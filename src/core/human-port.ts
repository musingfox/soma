import type { JsonValue } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import {
	type Conversation,
	defineDoc,
	type EntryId,
	type EntryRecord,
	type Harness,
	type SubmissionId,
	watchEvents,
} from "@earendil-works/pi-durable";
import type { AgentPort, AgentState } from "../ports/agent.ts";
import { type Choices, type HumanPort, type NoticeKind, PUSHED_FAILURES, type SomaEvent } from "../ports/human.ts";
import { HUMAN_CHOSEN } from "./domain/dispatch.ts";
import { escalation, type PendingPush, type Presence, pushTarget } from "./domain/push.ts";
import { turnSignal } from "./domain/signal.ts";
import { answerJob, Dispatches } from "./extensions/dispatch/index.ts";
import { recordFact } from "./extensions/memory/index.ts";
import { isForwarded, NOTICE, noticeEntry } from "./notice.ts";

const textOf = (entry: EntryRecord) =>
	(entry.model ?? [])
		.flatMap((message) => (message.role === "assistant" ? message.content : []))
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("");

// Durable spec 8.3: the reasons an input settles unanswered with; model_error and faulted carry the error text.
const REASONS: Record<string, string> = {
	model_error: "模型出錯",
	no_model: "找不到模型",
	aborted: "這一輪被中止",
	faulted: "內部錯誤",
};

const failureReason = (reason: string, detail: unknown) => {
	const head = REASONS[reason] ?? reason;
	const text = typeof detail === "string" ? detail : detail === undefined ? "" : JSON.stringify(detail);
	return text === "" ? head : `${head}：${text}`;
};

/** When the human last typed on each interface, and the pushes waiting to be pushed to the default interface too. */
export const Pushes = defineDoc<{ presence: Presence; pending: PendingPush[] }>({
	kind: "soma.push",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ presence: {}, pending: [] }),
});

/** ARCHITECTURE.md "Whom to push to when there are several interfaces"; the windows are its 15 minutes by default. */
export interface PushOptions {
	/** The entry kind of the interface pushed to when the human typed nowhere lately, and of every escalation. */
	readonly defaultTarget: string;
	readonly presenceMs?: number;
	readonly escalateMs?: number;
	/** How often pending pushes are checked for escalation. */
	readonly checkMs?: number;
	readonly now?: () => number;
}

const FIFTEEN_MINUTES = 15 * 60_000;

type Target = { target?: string };

/**
 * The in-process HumanPort over the root conversation. A new subscriber first gets the current run state and every
 * job, so it can show them without waiting for the next change. The event snapshot holds no submissions, so an
 * answer or failure settled before attachment, say before a restart, is never emitted again.
 */
export async function openHumanPort(
	harness: Harness,
	root: Conversation,
	agents: Pick<AgentPort, "respond">,
	context: Context,
	push?: PushOptions,
): Promise<HumanPort & { close(): Promise<void> }> {
	const now = push?.now ?? Date.now;
	const presenceMs = push?.presenceMs ?? FIFTEEN_MINUTES;
	const escalateMs = push?.escalateMs ?? FIFTEEN_MINUTES;
	const presence: Presence = push
		? await root.commit(
				async (tx) => JSON.parse(JSON.stringify((await tx.doc(Pushes, root.id)).presence)) as Presence,
				context,
			)
		: {};
	/**
	 * The target of a push the core starts. One that may escalate is kept as pending first, under the key of what it
	 * came from, so a crash before it reaches anyone leaves it pending rather than lost.
	 */
	async function targetOf(key: string, pending?: Omit<PendingPush, "key" | "at">): Promise<Target> {
		if (push === undefined) return {};
		const at = now();
		const target = pushTarget(presence, at, presenceMs, push.defaultTarget);
		if (pending !== undefined && target !== push.defaultTarget) {
			await root
				.commit(async (tx) => {
					const doc = await tx.doc(Pushes, root.id);
					if (!doc.pending.some((each) => each.key === key)) doc.pending.push({ key, at, ...pending });
				}, context)
				// A listener that throws ends the watch: the push still goes out, only its escalation is lost.
				.catch((error: unknown) => console.error("[soma] pending push:", error));
		}
		return { target };
	}

	const listeners = new Set<(event: SomaEvent) => void>();
	// Notices from before the first subscriber, such as the startup reconcile's, which no snapshot replays.
	let unheard: SomaEvent[] | undefined = [];
	const emit = (event: SomaEvent) => {
		if (unheard !== undefined && event.type === "notice") unheard.push(event);
		for (const listener of listeners) listener(event);
	};

	const events = await watchEvents(harness, root.id, context);
	let running = events.snapshot.run !== undefined;
	const setRunning = (next: boolean) => {
		if (next === running) return;
		running = next;
		emit({ type: "run", state: running ? "working" : "idle" });
	};
	// requestIds of inputs placed in the running round; a follow-up input joins a round already running.
	const placed = new Map<SubmissionId, string>();
	events.start(async (batch) => {
		// An answer's entry and its submission settle in the same commit, so the same batch.
		const answers = new Map<EntryId, string>();
		for (const event of batch) {
			if (event.type === "snapshot") {
				for (const entry of event.entries) answers.set(entry.id, textOf(entry));
				setRunning(event.run !== undefined);
			} else if (event.type === "run_start") setRunning(true);
			else if (event.type === "run_end") setRunning(false);
			else if (event.type === "message_end") answers.set(event.entry.id, textOf(event.entry));
			else if (event.type === "tool_execution_end") {
				const forwarded = (event.entry?.model ?? []).some(
					(message) => message.role === "toolResult" && isForwarded(message.details),
				);
				if (forwarded) for (const requestId of placed.values()) emit({ type: "notice", kind: "forwarded", requestId });
			} else if (event.type === "entry_appended" && event.entry.kind === NOTICE) {
				const { kind, content, choices, target } = event.entry.data as {
					kind: NoticeKind;
					content: string;
					choices?: Choices;
					target?: string;
				};
				// An escalation names its target; reports never escalate.
				const pushed =
					target !== undefined
						? { target }
						: await targetOf(
								`notice:${event.entry.id}`,
								kind === "question" ? { kind, content, ...(choices && { choices }) } : undefined,
							);
				emit({ type: "notice", kind, content, ...(choices && { choices }), ...pushed });
			} else if (event.type === "submission") {
				const { record } = event;
				if (record.type !== "input") continue;
				const { requestId } = record;
				if (record.status === "placed" && requestId !== undefined) placed.set(record.id, requestId);
				else placed.delete(record.id);
				if (record.status === "unanswered") {
					const reason = failureReason(record.reason, record.detail);
					if (requestId !== undefined && PUSHED_FAILURES.some((source) => requestId.startsWith(source))) {
						const content = `${requestId} 那一輪失敗：${reason}`;
						emit({
							type: "failure",
							requestId,
							reason,
							...(await targetOf(`failure:${record.id}`, { kind: "report", content })),
						});
					} else if (requestId !== undefined) emit({ type: "failure", requestId, reason });
					const round = { submission: record.id, requestId, entry: record.entry, reason };
					// A listener that throws ends the watch, and with it every later event to the human.
					await root
						.commit((tx) => recordFact(tx, turnSignal(round, Date.now())), context)
						.catch((error: unknown) => console.error("[soma] outcome signal:", error));
				} else if (record.status === "done" && requestId !== undefined) {
					emit({ type: "answer", requestId, content: answers.get(record.answer) ?? "" });
				}
			}
		}
	});

	// Event-bridge and reconcile write job states into the dispatch list; the doc is where a change shows.
	await root.commit((tx) => tx.doc(Dispatches, root.id), context);
	const watch = await harness.watchDoc(Dispatches, root.id, context);
	if (watch === undefined) throw new Error("the dispatch list is missing");
	const jobs = new Map<string, { agent: string; status: AgentState }>();
	const updateJobs = (value: typeof watch.value) => {
		for (const job of value?.jobs ?? []) {
			const seen = jobs.get(job.card);
			if (seen !== undefined && JSON.stringify(seen.status) === JSON.stringify(job.status)) continue;
			jobs.set(job.card, { agent: job.agent, status: job.status });
			emit({ type: "job", card: job.card, agent: job.agent, status: job.status });
		}
	};
	updateJobs(watch.value);
	watch.start(async (value) => updateJobs(value));

	// Each due push becomes a notice to the default interface in the commit that drops it, so a restart repeats none.
	let checking = false;
	const check = async (defaultTarget: string) => {
		if (checking) return;
		checking = true;
		try {
			await root.commit(async (tx) => {
				const doc = await tx.doc(Pushes, root.id);
				const jobsNow = (await tx.doc(Dispatches, root.id)).jobs;
				const stored = JSON.parse(JSON.stringify(doc)) as { presence: Presence; pending: PendingPush[] };
				const kept: PendingPush[] = [];
				for (const pending of stored.pending) {
					const verdict = escalation(pending, stored.presence, jobsNow, now(), escalateMs);
					if (verdict === "wait") kept.push(pending);
					if (verdict !== "due") continue;
					const { kind, content, choices } = pending;
					const { data } = noticeEntry(kind, content, choices);
					await tx.appendEntry(root.id, { kind: NOTICE, data: { ...data, target: defaultTarget } });
				}
				if (kept.length !== stored.pending.length) doc.pending = kept;
			}, context);
		} catch (error) {
			console.error("[soma] push escalation:", error);
		} finally {
			checking = false;
		}
	};
	const checker = push && setInterval(() => void check(push.defaultTarget), push.checkMs ?? 30_000);
	checker?.unref();

	return {
		async submit(input) {
			const { kind, data } = input.entry;
			const entry = data === undefined ? { kind } : { kind, data: data as JsonValue };
			if (push !== undefined) {
				const at = now();
				presence[kind] = at;
				await root.commit(async (tx) => {
					(await tx.doc(Pushes, root.id)).presence[kind] = at;
				}, context);
			}
			await root.submit(
				{ type: "input", content: input.content, entry, requestId: input.requestId, whenBusy: "followUp" },
				context,
			);
		},
		subscribe(listener) {
			listener({ type: "run", state: running ? "working" : "idle" });
			for (const [card, job] of jobs) listener({ type: "job", card, ...job });
			for (const event of unheard ?? []) listener(event);
			unheard = undefined;
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async notify(content, kind) {
			await root.submit({ type: "write", entry: noticeEntry(kind, content) }, context);
		},
		respond(card, answer) {
			return answerJob(agents, (change) => root.commit(change, context), root.id, {
				card,
				answer,
				reason: HUMAN_CHOSEN,
			});
		},
		async close() {
			clearInterval(checker);
			await Promise.all([events.stop(), watch.stop()]);
		},
	};
}
