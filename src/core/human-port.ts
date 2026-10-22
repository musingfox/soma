import type { JsonValue } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import {
	type Conversation,
	type EntryId,
	type EntryRecord,
	type Harness,
	watchEvents,
} from "@earendil-works/pi-durable";
import type { AgentPort, AgentState } from "../ports/agent.ts";
import type { Choices, HumanPort, NoticeKind, SomaEvent } from "../ports/human.ts";
import { turnSignal } from "./domain/signal.ts";
import { answerJob, Dispatches } from "./extensions/dispatch/index.ts";
import { recordFact } from "./extensions/memory/index.ts";
import { NOTICE, noticeEntry } from "./notice.ts";

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
): Promise<HumanPort & { close(): Promise<void> }> {
	const listeners = new Set<(event: SomaEvent) => void>();
	const emit = (event: SomaEvent) => {
		for (const listener of listeners) listener(event);
	};

	const events = await watchEvents(harness, root.id, context);
	let running = events.snapshot.run !== undefined;
	const setRunning = (next: boolean) => {
		if (next === running) return;
		running = next;
		emit({ type: "run", state: running ? "working" : "idle" });
	};
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
			else if (event.type === "entry_appended" && event.entry.kind === NOTICE) {
				const { kind, content, choices } = event.entry.data as { kind: NoticeKind; content: string; choices?: Choices };
				emit(choices === undefined ? { type: "notice", kind, content } : { type: "notice", kind, content, choices });
			} else if (event.type === "submission") {
				const { record } = event;
				if (record.type !== "input") continue;
				const { requestId } = record;
				if (record.status === "unanswered") {
					const reason = failureReason(record.reason, record.detail);
					if (requestId !== undefined) emit({ type: "failure", requestId, reason });
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

	return {
		async submit(input) {
			const { kind, data } = input.entry;
			const entry = data === undefined ? { kind } : { kind, data: data as JsonValue };
			await root.submit(
				{ type: "input", content: input.content, entry, requestId: input.requestId, whenBusy: "followUp" },
				context,
			);
		},
		subscribe(listener) {
			listener({ type: "run", state: running ? "working" : "idle" });
			for (const [card, job] of jobs) listener({ type: "job", card, ...job });
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
				reason: "人親自選的選項",
			});
		},
		async close() {
			await Promise.all([events.stop(), watch.stop()]);
		},
	};
}
