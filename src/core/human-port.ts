import type { JsonValue } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import {
	type CommitChange,
	type Conversation,
	type Cursor,
	defineDoc,
	type EntryId,
	type EntryRecord,
	type Harness,
	InboxDoc,
	LiveDoc,
	type LiveRun,
	type LiveState,
	type Storage,
	type SubmissionId,
	type SubmissionRecord,
	type TaskId,
} from "@earendil-works/pi-durable";
import { type AgentPort, type AgentState, PromptRefused } from "../ports/agent.ts";
import {
	type Choices,
	type Delivery,
	type HumanInput,
	type HumanPort,
	MESSAGE_CLASSES,
	type MessageClass,
	type NoticeKind,
	PUSHED_ANSWERS,
	PUSHED_FAILURES,
	type SaidOutcome,
	type SomaEvent,
} from "../ports/human.ts";
import { awaitsAnswer, type Decision, HUMAN_CHOSEN } from "./domain/dispatch.ts";
import type { Told } from "./domain/foreign.ts";
import {
	deliveries,
	escalates,
	escalation,
	holdsAny,
	type PendingPush,
	type Policies,
	type Presence,
	pushTarget,
} from "./domain/push.ts";
import { turnSignal } from "./domain/signal.ts";
import { Questions, saidQuestions } from "./extensions/ask/index.ts";
import { ForeignPrompts } from "./extensions/dispatch/foreign.ts";
import { answerJob, Dispatches } from "./extensions/dispatch/index.ts";
import { recordFact } from "./extensions/memory/index.ts";
import { Stops, settleStops } from "./extensions/stop/index.ts";
import { forgetHolding, Holds, holding, type Push, summaries, textOf } from "./hold.ts";
import { isForwarded, NOTICE, noticeEntry } from "./notice.ts";

// Durable spec 8.3: the reasons an input settles unanswered with; model_error and faulted carry the error text.
const REASONS: Record<string, string> = {
	model_error: "模型出錯",
	no_model: "找不到模型",
	aborted: "這一輪被中止",
	faulted: "內部錯誤",
};

/**
 * The class a notice entry names. One that names none is a fault in the code that wrote it: it is logged and pushed as
 * an `action`, so the slip is heard rather than hidden.
 */
function classOf(data: { class?: unknown; content?: unknown }): MessageClass {
	const found = MESSAGE_CLASSES.find((each) => each === data.class);
	if (found !== undefined) return found;
	console.error(`[soma] fault: a notice without a class, pushed as an action: ${JSON.stringify(data.content)}`);
	return "action";
}

/** Escalations kept before pushes had classes: only questions and pushed failures were kept. */
const pendingClass = (pending: PendingPush): MessageClass =>
	pending.class ?? (pending.kind === "question" ? "action" : "outcome");

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
	checkpointWhen: () => false,
});

/** ARCHITECTURE.md "Whom to push to when there are several interfaces"; the windows are its 15 minutes by default. */
export interface PushOptions {
	/**
	 * The entry kind of the interface pushed to when the human typed nowhere lately, and of every escalation. Without
	 * one there is no push target and no escalation: each interface follows its own policy.
	 */
	readonly defaultTarget?: string;
	/** Each interface's policy by entry kind; one not named is `instant`. */
	readonly policies?: Policies;
	readonly presenceMs?: number;
	readonly escalateMs?: number;
	/** How often pending pushes are checked for escalation. */
	readonly checkMs?: number;
	readonly now?: () => number;
	/** How long the human types nowhere before what interfaces hold is summarized; 30 minutes by default. */
	readonly summaryIdleMs?: number;
	/** The Harness's own storage, read at start for a pushed round a crash left unheld. */
	readonly storage?: Pick<Storage, "scanSubmissions">;
}

const FIFTEEN_MINUTES = 15 * 60_000;
/** Entries read at a time from a round's history. */
const ROUND_PAGE = 100;
const THIRTY_MINUTES = 30 * 60_000;

type Delivered = { delivery?: Record<string, Delivery> };

type NoticeData = {
	kind: NoticeKind;
	content: string;
	choices?: Choices;
	foreign?: PendingPush["foreign"];
	target?: string;
	delivery?: Record<string, Delivery>;
	replyTo?: string[];
};

/** What a notice entry pushes, when the policies decide on it: an escalation and a summary carry their own delivery. */
function pushOf(entry: EntryRecord): Push | undefined {
	if (entry.kind !== NOTICE) return undefined;
	const { kind, content, choices, foreign, target, delivery, replyTo } = entry.data as NoticeData;
	if (target !== undefined || delivery !== undefined) return undefined;
	const messageClass = classOf(entry.data as { class?: unknown });
	return {
		kind,
		class: messageClass,
		content,
		...(choices && { choices }),
		...(foreign && { foreign }),
		...(replyTo && { replyTo }),
	};
}

/**
 * A notice that is part of the reply to an interface's input goes to that interface at once, whatever its policy. The
 * round's first such notice to an interface rings there, and a later one in the same round is quiet there (`rang`
 * names the interfaces an earlier one went to): the round may end with no text, and the answer, marked `asked`, then
 * shows nothing, and with text does not ring, so the reply rings once. Every other interface keeps the delivery its
 * policy gave. Without push options every client rings, as for any notice.
 */
const replying = (pushed: Delivered, replyTo: readonly string[], rang: ReadonlySet<string>): Delivered =>
	pushed.delivery === undefined || replyTo.length === 0
		? pushed
		: {
				delivery: {
					...pushed.delivery,
					...Object.fromEntries(replyTo.map((kind) => [kind, rang.has(kind) ? "quiet" : "ring"])),
				},
			};

/** The interfaces, by entry kind, that the notices among `entries` are part of the reply to. */
const repliedTo = (entries: readonly EntryRecord[]): Set<string> =>
	new Set(entries.flatMap((entry) => (entry.kind === NOTICE ? ((entry.data as NoticeData).replyTo ?? []) : [])));

const failureContent = (requestId: string, reason: string) => `${requestId} 那一輪失敗：${reason}`;
const pushedFailure = (requestId: string, reason: string): Push => ({
	kind: "report",
	class: "outcome",
	content: failureContent(requestId, reason),
});
const pushedAnswer = (content: string): Push => ({ kind: "report", class: "outcome", content });

/**
 * The in-process HumanPort over the root conversation. A new subscriber first gets the current run state and every
 * job, so it can show them without waiting for the next change. Only commits stored after attachment are seen, so an
 * answer or failure settled before it, say before a restart, is never emitted again.
 */
export async function openHumanPort(
	harness: Harness,
	root: Conversation,
	agents: Pick<AgentPort, "respond" | "prompt">,
	context: Context,
	push?: PushOptions,
): Promise<HumanPort & { close(): Promise<void> }> {
	const now = push?.now ?? Date.now;
	const presenceMs = push?.presenceMs ?? FIFTEEN_MINUTES;
	const escalateMs = push?.escalateMs ?? FIFTEEN_MINUTES;
	const policies = push?.policies ?? {};
	const defaultTarget = push?.defaultTarget;
	const holds = holdsAny(policies);
	const held = await harness.snapshot(Holds, root.id, context);
	if (!holds && held?.entry !== undefined) await forgetHolding(root, context);
	// What is still held when no interface holds any more is summarized all the same.
	const summarizes = holds || (held?.held.length ?? 0) > 0;
	const hold = holds
		? holding({
				root,
				context,
				policies,
				now,
				...(push?.storage && { storage: push.storage }),
				ofEntry: pushOf,
				async ofRound(record, tx) {
					const { requestId = "" } = record;
					if (record.status === "unanswered")
						return PUSHED_FAILURES.some((source) => requestId.startsWith(source))
							? pushedFailure(requestId, failureReason(record.reason, record.detail))
							: undefined;
					if (!PUSHED_ANSWERS.some((source) => requestId.startsWith(source))) return undefined;
					const range = { conversationId: root.id, minEntryId: record.answer, maxEntryId: record.answer };
					const [answer] = (await tx.scanEntries(range, 1)).items;
					return pushedAnswer(answer === undefined ? "" : textOf(answer));
				},
			})
		: undefined;
	const tracksPresence = defaultTarget !== undefined || summarizes;
	const presence: Presence = tracksPresence
		? await root.commit(
				async (tx) => JSON.parse(JSON.stringify((await tx.doc(Pushes, root.id)).presence)) as Presence,
				context,
			)
		: {};
	/**
	 * What each interface does with a push the core starts. One that may escalate is kept as pending first, under the
	 * key of what it came from, so a crash before it reaches anyone leaves it pending rather than lost; it may only when
	 * the default interface's policy shows its class.
	 */
	async function deliveryOf(
		key: string,
		messageClass: MessageClass,
		pending?: Omit<PendingPush, "key" | "at" | "class">,
	): Promise<Delivered> {
		if (push === undefined) return {};
		if (defaultTarget === undefined) return { delivery: deliveries(policies, messageClass, undefined) };
		const at = now();
		const target = pushTarget(presence, at, presenceMs, defaultTarget);
		if (pending !== undefined && target !== defaultTarget && escalates(policies, defaultTarget, messageClass)) {
			await root
				.commit(async (tx) => {
					const doc = await tx.doc(Pushes, root.id);
					if (!doc.pending.some((each) => each.key === key))
						doc.pending.push({ key, at, class: messageClass, ...pending });
				}, context)
				// A throw would drop the rest of the commit's events: the push still goes out, only its escalation is lost.
				.catch((error: unknown) => console.error("[soma] pending push:", error));
		}
		return { delivery: deliveries(policies, messageClass, target) };
	}

	const listeners = new Set<(event: SomaEvent) => void>();
	// Notices from before the first subscriber, such as the startup reconcile's, which nothing replays.
	let unheard: SomaEvent[] | undefined = [];
	const emit = (event: SomaEvent) => {
		if (unheard !== undefined && event.type === "notice") unheard.push(event);
		for (const listener of listeners) listener(event);
	};

	let run: LiveRun | undefined;
	/**
	 * Emits the end of the run that was, and says whether one began. A run is known by its first input: one commit can
	 * end a run and start the next with the inputs queued behind it.
	 */
	const setRun = (next: LiveRun | undefined) => {
		const changed = next?.inputs[0] !== run?.inputs[0] || (next === undefined) !== (run === undefined);
		const before = run;
		run = next;
		if (changed && before !== undefined) emit({ type: "run", state: "idle" });
		return changed && next !== undefined;
	};
	// requestIds of inputs placed in the running round. A follow-up input, as every input here is, never joins a round
	// already running: it is placed once that round answers, and starts the next.
	const placed = new Map<SubmissionId, string>();
	// The rounds the human stopped that have not ended, by first input, with their inputs: as the `Stops` document holds
	// them, read at open and kept by this HumanPort. Their aborted inputs are told as `stopped`, and no partial of them is
	// emitted.
	const stopping = new Map<SubmissionId, readonly SubmissionId[]>();
	// By stopped round, the task of its run this process last asked to abort, so a change of `pi.live` asks once.
	const aborting = new Map<SubmissionId, TaskId>();
	// The last entry of the newest stopped round (`Stops.after`): a round's entries start past it, since the continue after
	// a stop starts its run at the stopped run's first entry.
	let after: EntryId | undefined;
	/**
	 * Aborts the running round once a stop names it and none of its tool calls runs: at once while the model writes, and
	 * at the hand-over to its next generation, before that one asks the model, while a tool call runs. Also at open,
	 * for a stop a restart left pending.
	 */
	const enforce = (value: LiveState | undefined) => {
		const run = value?.run;
		const round = run?.inputs[0];
		if (run === undefined || round === undefined || !stopping.has(round) || value?.tools !== undefined) return;
		if (aborting.get(round) === run.taskId) return;
		aborting.set(round, run.taskId);
		harness.abortTask(run.taskId, context).catch((error: unknown) => console.error("[soma] stop:", error));
	};
	/** Marks the stops of `rounds` settled: their rounds ended, and were told. */
	const settled = (rounds: ReadonlySet<SubmissionId>) => {
		for (const round of rounds) {
			stopping.delete(round);
			aborting.delete(round);
		}
		return root
			.commit((tx) => settleStops(tx, root.id, rounds), context)
			.then((last) => {
				after = last;
			})
			.catch((error: unknown) => console.error("[soma] settled stops:", error));
	};
	/**
	 * A stopped round leaves the inputs queued behind it queued (pi-durable places them only at the next input, write or
	 * continue), so a continue runs them now. Only when an input waits: a continue alone would answer the stopped input.
	 */
	const resumeQueued = () =>
		root
			.commit(async (tx) => {
				if ((await tx.doc(LiveDoc, root.id)).run !== undefined) return;
				const { items } = await tx.doc(InboxDoc, root.id);
				if (items.some((item) => item.mode !== "write")) await root.submit(tx, { type: "continue" });
			}, context)
			.catch((error: unknown) => console.error("[soma] queued after a stop:", error));
	/**
	 * The end of stopped rounds, seen as their inputs settle or found at open: their stops are settled with their last
	 * entry (`after`), and, when one of them ended aborted (`resume`), the inputs queued behind it run.
	 */
	const endStops = async (rounds: ReadonlySet<SubmissionId>, resume: boolean) => {
		await settled(rounds);
		if (resume) await resumeQueued();
	};
	/**
	 * A round's entries from `first` to `last`, read from storage rather than kept, so a round a restart split is read
	 * whole. A queued input gets its entry only once placed, so the range holds no other round's.
	 */
	const roundEntries = async (first: EntryId, last: EntryId) => {
		const found: EntryRecord[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await root.entries(
				{ minEntryId: first, maxEntryId: last, order: "ascending" },
				ROUND_PAGE,
				cursor,
				context,
			);
			found.push(...page.items);
			cursor = page.next;
		} while (cursor !== undefined);
		return found;
	};
	const onCommit = async (changes: readonly CommitChange[]) => {
		// Change order within a commit is unspecified. An answer's entry and its submission settle in the same commit,
		// so entries go before submissions; a run that ended goes before both, and one that began after them.
		const entries: EntryRecord[] = [];
		const submissions: SubmissionRecord[] = [];
		let began = false;
		for (const change of changes) {
			if (change.type === "entry" && change.value.conversationId === root.id) entries.push(change.value);
			else if (change.type === "submission" && change.value.conversationId === root.id) submissions.push(change.value);
			else if (
				change.type === "document" &&
				change.kind === "change" &&
				change.conversationId === root.id &&
				change.record.kind === LiveDoc.definition.kind
			)
				began = setRun((change.value as LiveState).run);
		}
		entries.sort((a, b) => a.id - b.id);
		const answers = new Map<EntryId, string>();
		for (const entry of entries) {
			answers.set(entry.id, textOf(entry));
			const forwarded = (entry.model ?? []).some(
				(message) => message.role === "toolResult" && isForwarded(message.details),
			);
			if (forwarded) for (const requestId of placed.values()) emit({ type: "notice", kind: "forwarded", requestId });
			if (entry.kind !== NOTICE) continue;
			const { kind, content, choices, foreign, target, delivery, replyTo = [] } = entry.data as NoticeData;
			const messageClass = classOf(entry.data as { class?: unknown });
			// The interfaces an earlier notice of this round replied to; the round starts at its run's first entry, and past a
			// stopped round before it.
			const first =
				run?.first === undefined || after === undefined ? run?.first : (Math.max(run.first, after + 1) as EntryId);
			const rang =
				replyTo.length === 0 || first === undefined
					? new Set<string>()
					: await roundEntries(first, entry.id)
							.then((round) => repliedTo(round.filter((each) => each.id !== entry.id)))
							.catch((error: unknown) => {
								console.error("[soma] round entries:", error);
								return new Set<string>();
							});
			// An escalation names its target and a summary its delivery; reports never escalate.
			const pushed =
				delivery !== undefined
					? { delivery }
					: target !== undefined
						? { delivery: deliveries(policies, messageClass, target) }
						: replying(
								await deliveryOf(
									`notice:${entry.id}`,
									messageClass,
									kind === "question"
										? { kind, content, ...(choices && { choices }), ...(foreign && { foreign }) }
										: undefined,
								),
								replyTo,
								rang,
							);
			await hold?.notice(entry.id, pushOf(entry)).catch((error: unknown) => console.error("[soma] held push:", error));
			emit({ type: "notice", kind, class: messageClass, content, ...(choices && { choices }), ...pushed });
		}
		// By answer, the earliest entry of the inputs it settles here, where its round starts: a round's inputs all settle
		// in the commit that answers them, the one that started it and those that joined it later.
		const starts = new Map<EntryId, EntryId>();
		for (const record of submissions)
			if (record.type === "input" && record.status === "done")
				starts.set(record.answer, Math.min(record.entry, starts.get(record.answer) ?? record.entry) as EntryId);
		// By answer, the interfaces a notice of its round replied to, and the entry kind of each of its inputs.
		const rounds = new Map<EntryId, Promise<{ replied: Set<string>; kinds: Map<EntryId, string> }>>();
		const roundOf = (answer: EntryId) => {
			let found = rounds.get(answer);
			if (found === undefined) {
				found = roundEntries(starts.get(answer) ?? answer, answer).then((round) => ({
					replied: repliedTo(round),
					kinds: new Map(round.map((each) => [each.id, each.kind])),
				}));
				rounds.set(answer, found);
			}
			return found;
		};
		/** Whether a notice of the round that answered `record` replied to the interface its input came from. */
		const asked = (record: { entry: EntryId; answer: EntryId }) =>
			roundOf(record.answer)
				.then(({ replied, kinds }) => replied.has(kinds.get(record.entry) ?? ""))
				.catch((error: unknown) => {
					console.error("[soma] round entries:", error);
					return false;
				});
		let resume = false;
		// The stopped rounds whose inputs settle in this commit, as a round's inputs all do.
		const ended = new Set<SubmissionId>();
		for (const record of submissions) {
			if (record.type !== "input") continue;
			const { requestId } = record;
			if (record.status === "placed" && requestId !== undefined) placed.set(record.id, requestId);
			else placed.delete(record.id);
			const stop =
				record.status === "done" || record.status === "unanswered"
					? [...stopping].find(([, inputs]) => inputs.includes(record.id))?.[0]
					: undefined;
			if (stop !== undefined) ended.add(stop);
			if (stop !== undefined && record.status === "unanswered" && record.reason === "aborted") {
				// The human's stop: no failure, no push and no signal for reflection.
				if (requestId !== undefined) emit({ type: "stopped", requestId });
				resume = true;
			} else if (record.status === "unanswered") {
				const reason = failureReason(record.reason, record.detail);
				if (requestId !== undefined && PUSHED_FAILURES.some((source) => requestId.startsWith(source))) {
					const content = failureContent(requestId, reason);
					await hold
						?.round(record, pushedFailure(requestId, reason))
						.catch((error: unknown) => console.error("[soma] held push:", error));
					emit({
						type: "failure",
						requestId,
						reason,
						class: "outcome",
						...(await deliveryOf(`failure:${record.id}`, "outcome", { kind: "report", content })),
					});
				} else if (requestId !== undefined) emit({ type: "failure", requestId, reason });
				const round = { submission: record.id, requestId, entry: record.entry, reason };
				await root
					.commit((tx) => recordFact(tx, turnSignal(round, Date.now())), context)
					.catch((error: unknown) => console.error("[soma] outcome signal:", error));
			} else if (record.status === "done" && requestId !== undefined) {
				const content = answers.get(record.answer) ?? "";
				const answered = PUSHED_ANSWERS.some((source) => requestId.startsWith(source));
				if (answered)
					await hold
						?.round(record, pushedAnswer(content))
						.catch((error: unknown) => console.error("[soma] held push:", error));
				const pushed = answered
					? { class: "outcome" as const, ...(await deliveryOf(`answer:${record.id}`, "outcome")) }
					: {};
				const reply = (await asked(record)) && { asked: true as const };
				emit({ type: "answer", requestId, content, ...reply, ...pushed });
			}
		}
		if (ended.size > 0) await endStops(ended, resume);
		if (began) emit({ type: "run", state: "working" });
	};
	// Commits are handled one at a time, in order. The observer attaches before the run state is read, so no commit
	// falls between the two.
	let handled = Promise.resolve();
	const commits = harness.observeCommits({
		advance({ changes }) {
			handled = handled.then(() => onCommit(changes)).catch((error: unknown) => console.error("[soma] commit:", error));
		},
		end() {},
	});
	// Before any commit is handled, so the settlement of a round stopped before a restart is told as stopped. A pending stop
	// whose round ended while no HumanPort listened was told to no one, and ends as one seen ending: when it ended aborted,
	// as a crash between its settlement and the continue leaves it, the inputs queued behind it run.
	const stopsRead = handled
		.then(() =>
			root.commit(async (tx) => {
				const doc = await tx.doc(Stops, root.id);
				after = doc.after;
				const live = await tx.doc(LiveDoc, root.id);
				const running = live.run?.inputs[0];
				const ended = new Set<SubmissionId>();
				for (const stop of doc.stops) {
					if (stop.settled !== undefined) continue;
					if (stop.round === running) stopping.set(stop.round, [...stop.inputs]);
					else ended.add(stop.round);
				}
				// The newest run that ended unanswered, until a later run starts.
				const failure = live.runFailure;
				const resume =
					failure?.reason === "aborted" && failure.inputs.some((input) => ended.has(input as SubmissionId));
				return { ended, resume };
			}, context),
		)
		.then(({ ended, resume }) => (ended.size > 0 ? endStops(ended, resume) : undefined))
		.catch((error: unknown) => console.error("[soma] stops:", error));
	handled = stopsRead;
	// Before any commit is handled, so a push it holds is never held again by the commit's handling.
	if (hold !== undefined)
		handled = handled.then(() => hold.catchUp()).catch((error: unknown) => console.error("[soma] held push:", error));
	run = await root.commit(
		async (tx) => JSON.parse(JSON.stringify((await tx.doc(LiveDoc, root.id)).run ?? null)) ?? undefined,
		context,
	);

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
	watch.start(async (call) => {
		if (call.kind === "value") updateJobs(call.value);
	});

	// The answer as the model writes it: pi-durable commits a throttled partial into `pi.live`, which a watch sees at once
	// and the commit observer only once stored, up to a second later. Handled behind the commits, so the round's inputs
	// are known as placed, and a partial that comes after its round's answer finds them settled and says nothing.
	// Once the stops are read, so the value the watch starts with can be enforced.
	await stopsRead;
	const live = await harness.watchDoc(LiveDoc, root.id, context);
	if (live === undefined) throw new Error("the live document is missing");
	// The first input of the round the last partial was of, and its text.
	let streamed: { round: SubmissionId; content: string } | undefined;
	const partial = (inputs: readonly SubmissionId[], content: string) => {
		const round = inputs[0];
		const requestIds = inputs.flatMap((id) => placed.get(id) ?? []);
		if (round === undefined || requestIds.length === 0) {
			streamed = undefined;
			return;
		}
		if (stopping.has(round) || content === (streamed?.round === round ? streamed.content : "")) return;
		streamed = { round, content };
		emit({ type: "partial", requestIds, content });
	};
	live.start(async (call) => {
		if (call.kind !== "value") return;
		// At once, not behind the commits: a stop that waits on a tool call aborts as soon as the round hands over.
		enforce(call.value);
		const inputs = [...(call.value?.run?.inputs ?? [])];
		// A generation that ended, or one that has written nothing yet, has no text: the next one starts over from empty.
		const content = (call.value?.generation?.message?.content ?? [])
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("");
		handled = handled
			.then(() => partial(inputs, content))
			.catch((error: unknown) => console.error("[soma] partial:", error));
	});
	// A watch delivers changes only: a stop a restart left pending is enforced on the value it starts with, so a round
	// whose model writes nothing more is aborted all the same.
	enforce(live.value);

	// Each due push becomes a notice to the default interface in the commit that drops it, so a restart repeats none.
	// One kept under a policy the config has since set to `log` is dropped.
	let checking = false;
	const check = async (defaultTarget: string) => {
		if (checking) return;
		checking = true;
		try {
			await root.commit(async (tx) => {
				const doc = await tx.doc(Pushes, root.id);
				const jobsNow = (await tx.doc(Dispatches, root.id)).jobs;
				const told = JSON.parse(JSON.stringify((await tx.doc(ForeignPrompts, root.id)).told)) as Told;
				const said = await saidQuestions(tx, root.id);
				const stored = JSON.parse(JSON.stringify(doc)) as { presence: Presence; pending: PendingPush[] };
				const kept: PendingPush[] = [];
				for (const pending of stored.pending) {
					const messageClass = pendingClass(pending);
					if (!escalates(policies, defaultTarget, messageClass)) continue;
					const verdict = escalation(pending, stored.presence, jobsNow, told, now(), escalateMs, said);
					if (verdict === "wait") kept.push(pending);
					if (verdict !== "due") continue;
					const { kind, content, choices } = pending;
					const { data } = noticeEntry(kind, messageClass, content, choices);
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
	const checker =
		defaultTarget === undefined ? undefined : setInterval(() => void check(defaultTarget), push?.checkMs ?? 30_000);
	checker?.unref();
	const summary = summarizes
		? summaries({
				harness,
				root,
				context,
				policies,
				now,
				presence: () => presence,
				idleMs: push?.summaryIdleMs ?? THIRTY_MINUTES,
			})
		: undefined;
	const summarizer = summary && setInterval(() => void summary.check(), push?.checkMs ?? 30_000);
	summarizer?.unref();

	const entryOf = ({ kind, data }: HumanInput["entry"]) =>
		data === undefined ? { kind } : { kind, data: data as JsonValue };
	const present = async (kind: string) => {
		if (!tracksPresence) return;
		const at = now();
		presence[kind] = at;
		await root.commit(async (tx) => {
			(await tx.doc(Pushes, root.id)).presence[kind] = at;
		}, context);
	};

	/**
	 * Sends the label of a job's question, already settled, to its agent as the `reply` tool does, and records it as a
	 * reply the human chose. A refusal before anything was typed leaves the question unsettled: for an agent busy with a
	 * turn or a prompt, the job no longer waits on it; for any other reason, the agent may still, and a later press may go.
	 */
	const promptJob = async (
		question: string,
		card: string,
		agent: string,
		label: string,
	): Promise<SaidOutcome | undefined> => {
		try {
			await agents.prompt(agent, label);
		} catch (error) {
			if (!(error instanceof PromptRefused)) {
				console.error(`[soma] prompt of ${agent} with a pressed option:`, error);
				return { said: false, refusal: "unsure", label };
			}
			await root.commit(async (tx) => {
				const doc = await tx.doc(Questions, root.id);
				const asked = doc.questions[question];
				if (asked === undefined) return;
				const { said: _unsaid, ...rest } = JSON.parse(JSON.stringify(asked)) as typeof asked;
				doc.questions[question] = rest;
			}, context);
			return error.busy
				? { said: false, refusal: "not_waiting" }
				: { said: false, refusal: "unsent", reason: error.message };
		}
		const decision: Decision = {
			at: new Date().toISOString(),
			kind: "question",
			action: "replied",
			text: label,
			reason: HUMAN_CHOSEN,
		};
		await root
			.commit(async (tx) => {
				const doc = await tx.doc(Dispatches, root.id);
				const index = doc.jobs.findIndex((each) => each.card === card);
				const current = doc.jobs[index];
				if (current !== undefined) doc.jobs[index] = { ...current, decisions: [...current.decisions, decision] };
			}, context)
			// The label went: a lost record must not read as a press that failed.
			.catch((error: unknown) => console.error("[soma] reply decision:", error));
		return undefined;
	};

	return {
		async submit(input) {
			await present(input.entry.kind);
			await root.submit(
				{
					type: "input",
					content: input.content,
					entry: entryOf(input.entry),
					requestId: input.requestId,
					whenBusy: "followUp",
				},
				context,
			);
		},
		async say(question, option, input) {
			await present(input.entry.kind);
			// Settled in the commit that admits the input, so two presses, on one interface or two, admit one. A job's
			// question is settled in the commit that finds the job waiting on it, before its agent is prompted.
			const claimed = await root.commit(async (tx): Promise<SaidOutcome & { agent?: string }> => {
				const doc = await tx.doc(Questions, root.id);
				// Own keys only: an id such as __proto__ or toString would otherwise find the prototype's.
				const asked = Object.hasOwn(doc.questions, question) ? doc.questions[question] : undefined;
				if (asked === undefined) return { said: false, refusal: "no_question" };
				const labelOf = (id: string) => asked.options.find((each) => each.id === id)?.label;
				if (asked.said !== undefined) return { said: false, refusal: "settled", label: labelOf(asked.said) ?? "" };
				const label = labelOf(option);
				if (label === undefined) return { said: false, refusal: "unknown_option" };
				const { job } = asked;
				if (job !== undefined) {
					const found = (await tx.doc(Dispatches, root.id)).jobs.find((each) => each.card === job.card);
					if (found === undefined || !awaitsAnswer(found, job)) return { said: false, refusal: "not_waiting" };
					doc.questions[question] = { ...JSON.parse(JSON.stringify(asked)), said: option };
					return { said: true, label, job: job.card, agent: found.agent };
				}
				doc.questions[question] = { ...JSON.parse(JSON.stringify(asked)), said: option };
				await root.submit(tx, {
					type: "input",
					content: label,
					entry: entryOf(input.entry),
					requestId: input.requestId,
					whenBusy: "followUp",
				});
				return { said: true, label };
			}, context);
			const { agent, ...outcome } = claimed;
			if (outcome.said && outcome.job !== undefined && agent !== undefined) {
				const sent = await promptJob(question, outcome.job, agent, outcome.label);
				if (sent !== undefined) return sent;
			}
			if (outcome.said) emit({ type: "said", question, label: outcome.label });
			return outcome;
		},
		async stop(requestId) {
			// Read and recorded in one commit, so the input is among the inputs of the run read with it, and a restart
			// after it keeps the stop.
			const taken = await root.commit(async (tx) => {
				const record = await tx.submissionByRequest(root.id, requestId);
				const { run } = await tx.doc(LiveDoc, root.id);
				// A queued or settled input is not among them.
				const round = run?.inputs[0];
				if (record === undefined || round === undefined || !run?.inputs.includes(record.id)) return undefined;
				const doc = await tx.doc(Stops, root.id);
				if (doc.stops.some((stop) => stop.settled === undefined && stop.round === round)) return undefined;
				const inputs = [...run.inputs];
				doc.stops.push({ round, inputs, at: now() });
				return { round, inputs };
			}, context);
			if (taken === undefined) return false;
			stopping.set(taken.round, taken.inputs);
			// While the model writes the run is aborted at once; while a tool call runs, aborting would abort the call too,
			// so the watch on `pi.live` aborts it once the round's tool calls ended.
			enforce(await harness.snapshot(LiveDoc, root.id, context));
			return true;
		},
		subscribe(listener) {
			listener({ type: "run", state: run !== undefined ? "working" : "idle" });
			// Held notices first, so a client that shows a prompt's buttons sees the job that may have moved past it.
			for (const event of unheard ?? []) listener(event);
			for (const [card, job] of jobs) listener({ type: "job", card, ...job });
			unheard = undefined;
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async notify(content, kind, messageClass) {
			await root.submit({ type: "write", entry: noticeEntry(kind, messageClass, content) }, context);
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
			clearInterval(summarizer);
			commits.detach();
			await watch.stop();
			await live.stop();
		},
	};
}
