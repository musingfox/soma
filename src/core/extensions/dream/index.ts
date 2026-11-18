import type { Context } from "@earendil-works/chord/context";
import {
	type Conversation,
	type ConversationId,
	type Cursor,
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	type EntryId,
	type EntryRecord,
	type ModelRef,
	type Storage,
	type SubmissionRecord,
	type Tx,
} from "@earendil-works/pi-durable";
import { type DreamRecords, dreamPrompt, renderDreamInput, windowLine } from "../../domain/dream.ts";
import type { Fact, StoredLine } from "../../domain/memory.ts";
import { noticeEntry } from "../../notice.ts";
import { Curated, Facts } from "../memory/index.ts";
import { Stops } from "../stop/index.ts";

export const DAY_MS = 24 * 60 * 60_000;

/** The dream's input in its own conversation: one per window, so a rerun after a crash finds the one it submitted. */
export const dreamRequestId = (until: number) => `dream:${until}`;

/** The conversation's one dream task, so a restart finds it instead of starting another. */
export const Dreams = defineDoc<{ taskId?: number }>({
	kind: "soma.dream.task",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: () => false,
});

type Checkpoint = {
	phase: "tick";
	/** The window under way starts here and ends when the tick runs. */
	since: number;
	next: number;
	/** The last root entry the previous dream covered; before the first dream, the window starts at `since`. */
	after?: number;
	// Pinned before the model is called, so a rerun after a crash asks about the same window in the same conversation,
	// and finds the input it submitted there instead of submitting one more.
	until?: number;
	upto?: number;
	conversationId?: number;
};

export interface DreamOptions {
	/** The Harness's own storage: neither `Tx` nor `Session` scans submissions. */
	storage: Pick<Storage, "scanSubmissions">;
	model: ModelRef;
	periodMs: number;
	/** The BCP 47 tag of the human's language, which the dream answers in. */
	language: string;
	timeZone?: string;
	/** soma's log file; undefined when the config names none. */
	readLog?: () => Promise<string>;
}

async function scanAll<T>(scan: (cursor?: Cursor) => Promise<{ items: readonly T[]; next?: Cursor }>): Promise<T[]> {
	const all: T[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await scan(cursor);
		all.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return all;
}

const textOf = (entry: EntryRecord | undefined) =>
	(entry?.model ?? [])
		.flatMap((message) => (message.role === "assistant" ? message.content : []))
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("");

const reasonOf = (record: Extract<SubmissionRecord, { status: "unanswered" }>) => {
	const { reason, detail } = record;
	const text = typeof detail === "string" ? detail : detail === undefined ? "" : JSON.stringify(detail);
	return text === "" ? reason : `${reason}：${text}`;
};

/**
 * A periodic background review of soma's own records (ARCHITECTURE.md "Dream"), run like the digest and the reflection.
 * When its time comes the tick pins the window's end and the last root entry it covers, and makes the conversation the
 * dream model answers in: owned by this task, with no extension, so no tool and no section, and nothing of the root's
 * context. It renders the window from storage, submits it there, and commits the answer as a `notice` to the human on
 * the root together with the next checkpoint. The root's model is never woken and never reads the input or the answer.
 */
export function dream({ storage, model, periodMs, language, timeZone, readLog }: DreamOptions) {
	const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

	/** What the window holds in storage; the log is read outside the commit. */
	async function records(tx: Tx, conversationId: ConversationId, checkpoint: Required<Checkpoint>, context: Context) {
		const { after, since, until, upto } = checkpoint;
		let entries = await scanAll((cursor) =>
			tx.scanEntries(
				{
					conversationId,
					order: "ascending",
					minEntryId: (after + 1) as EntryId,
					maxEntryId: upto as EntryId,
				},
				500,
				cursor,
			),
		);
		// The first dream starts at the first entry of its window.
		if (after === 0) {
			const first = entries.findIndex((entry) => (entry.model?.[0]?.timestamp ?? 0) >= since);
			entries = first === -1 ? [] : entries.slice(first);
		}
		const unanswered = new Map<number, string>();
		const inputs = new Map<number, number>();
		const failed = await scanAll((cursor) =>
			storage.scanSubmissions({ conversationId, status: "unanswered" }, 100, cursor, context),
		);
		for (const record of failed) {
			if (record.type !== "input" || record.status !== "unanswered" || record.entry === undefined) continue;
			unanswered.set(record.entry, reasonOf(record));
			inputs.set(record.id, record.entry);
		}
		const stopped = new Set<number>();
		for (const stop of (await tx.doc(Stops, conversationId)).stops)
			for (const input of stop.inputs) {
				const entry = inputs.get(input);
				if (entry !== undefined) stopped.add(entry);
			}
		const curated = await tx.doc(Curated);
		// Docs are live proxies only valid inside their commit, so what leaves it is copied out as JSON.
		const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
		return {
			since,
			until,
			timeZone: zone,
			entries,
			unanswered,
			stopped,
			facts: copy((await tx.doc(Facts)).rows) as Fact[],
			memory: {
				lines: copy(curated.lines) as StoredLine[],
				revisions: copy(curated.history.map((revision) => ({ at: revision.at }))),
			},
		} satisfies Omit<DreamRecords, "log">;
	}

	async function readTheLog(): Promise<DreamRecords["log"]> {
		if (readLog === undefined) return undefined;
		return readLog().then(
			(text) => ({ text }),
			(error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
		);
	}

	const Dream = defineTask<{ since: number; next: number }, Checkpoint, null>({
		name: "soma.dream",
		version: 1,
		initial: ({ since, next }) => ({ phase: "tick", since, next }),
		phases: {
			tick: async (task, runtime, context) => {
				const checkpoint = task.state.checkpoint;
				if (runtime.now() < checkpoint.next) return runtime.sleepUntil(checkpoint.next, checkpoint, context);

				let pinned = checkpoint;
				if (checkpoint.until === undefined) {
					await runtime.commit(async (tx, current) => {
						// Read before the first write, as a commit must.
						const upto = (await tx.latestEntryId(current.conversationId)) ?? 0;
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: current.id } });
						// It starts as a copy of the root's agent; it gets none of the root's extensions, so no tool or section.
						await configure(tx, created.id, { model, thinkingLevel: "high", extensions: [], tools: [] });
						pinned = { ...checkpoint, until: runtime.now(), upto, conversationId: created.id };
						return { status: "running", checkpoint: pinned };
					}, context);
				}
				const window = { ...pinned, after: pinned.after ?? 0 } as Required<Checkpoint>;
				const conversationId = window.conversationId as ConversationId;
				const requestId = dreamRequestId(window.until);

				let submitted = false;
				await runtime.commit(async (tx) => {
					submitted = (await tx.submissionByRequest(conversationId, requestId)) !== undefined;
				}, context);
				let content = "";
				if (!submitted) {
					const log = await readTheLog();
					await runtime.commit(async (tx, current) => {
						const read = await records(tx, current.conversationId, window, context);
						content = dreamPrompt(renderDreamInput({ ...read, ...(log !== undefined && { log }) }), language);
					}, context);
				}
				const child = await runtime.conversation(conversationId, context);
				const submission = await child?.submit({ type: "input", content, requestId }, context);
				const settled = await submission?.wait(context);
				let answer = "";
				if (settled?.type === "input" && settled.status === "done") {
					const id = settled.answer;
					await runtime.commit(async (tx) => {
						answer = textOf(await tx.entry(id));
					}, context);
				}
				const head = `soma 的 dream：${windowLine(window.since, window.until, zone)}`;
				// A failed call is told, and its window is not asked about again: the next dream covers the time after it.
				// An empty answer is such a failure, not a report that found nothing.
				const failure =
					settled?.type === "input" && settled.status === "done"
						? answer.trim() === ""
							? "dream 的模型回了空的答案"
							: undefined
						: settled?.status === "unanswered"
							? reasonOf(settled as Extract<SubmissionRecord, { status: "unanswered" }>)
							: "找不到 dream 的對話";
				const report =
					failure === undefined
						? `${head}\n\n${answer}`
						: `${head}\n\ndream 沒有完成（${failure}）。這段時間不會再看，下一次 dream 從這段時間之後開始。`;
				await runtime.commit(async (tx, current) => {
					await tx.appendEntry(current.conversationId, noticeEntry("report", "ambient", report));
					return {
						status: "running",
						checkpoint: { phase: "tick", since: window.until, next: window.until + periodMs, after: window.upto },
					};
				}, context);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});

	/**
	 * Starts the conversation's dream unless it has one. The first is due at once and covers the period before it; a
	 * task a db already holds goes on from its own checkpoint.
	 */
	async function startDream(conversation: Conversation, context: Context): Promise<void> {
		await conversation.commit(async (tx) => {
			const doc = await tx.doc(Dreams, conversation.id);
			if (doc.taskId !== undefined) return;
			const now = Date.now();
			doc.taskId = await tx.createTask(
				Dream,
				{ since: now - periodMs, next: now },
				{ ownership: { kind: "conversation" }, background: true },
			);
		}, context);
	}

	return { extension: defineExtension({ name: "soma.dream", tasks: [Dream] }), startDream };
}
