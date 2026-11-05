import type { Context } from "@earendil-works/chord/context";
import {
	AssistantEntry,
	type Conversation,
	defineDoc,
	defineExtension,
	defineTask,
	type EntryRecord,
	type Tx,
} from "@earendil-works/pi-durable";
import type { AgentPort } from "../../../ports/agent.ts";
import { digestPrompt, type JobReport, type Outcome } from "../../domain/report.ts";
import { noticeEntry } from "../../notice.ts";
import { JOB_DONE } from "../dispatch/bridge.ts";
import { Dispatches } from "../dispatch/index.ts";

export const DIGEST_PERIOD_MS = 10 * 60_000;
/** Entry kind of the input that wakes the model for a report. */
export const DIGEST = "soma.digest";
export const NOTICE = "notice";

export const digestRequestId = (until: number) => `digest:${until}`;

/** The one digest task of a conversation, so a restart finds it instead of starting another. */
export const Digests = defineDoc<{ taskId?: number }>({
	kind: "soma.digest.task",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: () => false,
});

type Done = { agent: string; card: string; outcome: Outcome | "未知"; notified?: boolean };

/** Each agent's latest finished turn, unless the event bridge already told the human that one. */
function unreported(entries: readonly EntryRecord[]): Done[] {
	const latest = new Map<string, Done>();
	for (const entry of entries) {
		const done = entry.data as Done;
		latest.set(done.agent, done);
	}
	return [...latest.values()].filter((done) => !done.notified);
}

type Checkpoint = {
	phase: "tick";
	since: number;
	next: number;
	// The last finished-turn entry already reported.
	cursor: number;
	// The last one the report under way covers, pinned before its input is submitted: a turn that finishes
	// between a crash and the rerun must wait for the next report, not be counted as reported by this one.
	upto?: number;
};

async function doneSince(tx: Tx, conversationId: Conversation["id"], cursor: number, upto?: number) {
	const found: EntryRecord[] = [];
	let page: Awaited<ReturnType<Tx["scanEntries"]>> | undefined;
	do {
		page = await tx.scanEntries(
			{
				conversationId,
				order: "ascending",
				minEntryId: (cursor + 1) as EntryRecord["id"],
				maxEntryId: upto as EntryRecord["id"],
			},
			500,
			page?.next,
		);
		found.push(...page.items.filter((entry) => entry.kind === JOB_DONE));
	} while (page.next !== undefined);
	return found;
}

const textOf = (entry: EntryRecord | undefined) =>
	(entry?.model ?? [])
		.flatMap((message) => (message.role === "assistant" ? message.content : []))
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("");

/**
 * A periodic background task (ARCHITECTURE.md "Scheduled digest"). Each tick reads the turns the event bridge recorded as
 * finished since the last report; with none it only moves its checkpoint on, without the model. With some it submits
 * one input asking the model for a short report, and commits the answer as a `notice` entry together with the next
 * checkpoint, so a crash anywhere before that commit redoes the tick and the requestId admits the input once.
 */
export function digest(agents: Pick<AgentPort, "readResult">) {
	const Digest = defineTask<{ periodMs: number; since: number; cursor: number }, Checkpoint, null>({
		name: "soma.digest",
		version: 1,
		initial: ({ periodMs, since, cursor }) => ({ phase: "tick", since, next: since + periodMs, cursor }),
		phases: {
			tick: async (task, runtime, context) => {
				const checkpoint = task.state.checkpoint;
				const { since, next, cursor } = checkpoint;
				if (runtime.now() < next) return runtime.sleepUntil(next, checkpoint, context);
				const advance = (reported: number) => ({
					status: "running" as const,
					// After a long downtime, one tick covers the gap instead of one per missed period.
					checkpoint: {
						phase: "tick" as const,
						since: next,
						next: Math.max(next + task.input.periodMs, runtime.now()),
						cursor: reported,
					},
				});

				let upto = checkpoint.upto;
				if (upto === undefined) {
					let last: number | undefined;
					await runtime.commit(async (tx, current) => {
						const found = await doneSince(tx, current.conversationId, cursor);
						last = unreported(found).length === 0 ? undefined : found.at(-1)?.id;
						return last === undefined
							? advance(found.at(-1)?.id ?? cursor)
							: { status: "running", checkpoint: { ...checkpoint, upto: last } };
					}, context);
					if (last === undefined) return;
					upto = last;
				}

				const pinnedUpto = upto;
				let jobs: Omit<JobReport, "result">[] = [];
				await runtime.commit(async (tx, current) => {
					const done = unreported(await doneSince(tx, current.conversationId, cursor, pinnedUpto));
					const listed = (await tx.doc(Dispatches, current.conversationId)).jobs;
					// A doc is a live proxy only valid inside its commit, so decisions are copied out as JSON.
					jobs = done.map(({ notified: _told, ...each }) => ({
						...each,
						decisions: JSON.parse(JSON.stringify(listed.find((job) => job.card === each.card)?.decisions ?? [])),
					}));
				}, context);
				// A reply that cannot be read, as for an agent soma stopped since, leaves only that job without one: a read
				// that threw would fault the task, and with it every later report.
				const reports: JobReport[] = await Promise.all(
					jobs.map(async (job) => ({
						...job,
						result: (await agents.readResult(job.agent).catch(() => undefined))?.text || undefined,
					})),
				);
				const window = { since: new Date(since).toISOString(), until: new Date(next).toISOString() };
				const root = await runtime.conversation(runtime.conversationId, context);
				const content = digestPrompt({ ...window, jobs: reports });
				const submission = await root?.submit(
					{
						type: "input",
						content,
						whenBusy: "followUp",
						entry: { kind: DIGEST, data: { ...window, cards: reports.map((job) => job.card) } },
						requestId: digestRequestId(next),
					},
					context,
				);
				const settled = await submission?.wait(context);
				// A run that failed still reports its jobs, unwritten: they count as reported once this commit lands.
				const report =
					settled?.type === "input" && settled.status === "done"
						? textOf(await runtime.entry(AssistantEntry, settled.answer, context))
						: `模型沒有寫出報告（${settled?.status === "unanswered" ? settled.reason : "no root conversation"}）。\n${content}`;
				await runtime.commit(async (tx, current) => {
					await tx.appendEntry(current.conversationId, noticeEntry("report", "ambient", report));
					return advance(pinnedUpto);
				}, context);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});

	/** Starts the conversation's digest unless it has one. Turns that finished before it are not reported. */
	async function startDigest(conversation: Conversation, periodMs: number, context: Context): Promise<void> {
		await conversation.commit(async (tx) => {
			const doc = await tx.doc(Digests, conversation.id);
			if (doc.taskId !== undefined) return;
			const latest = await tx.scanEntries({ conversationId: conversation.id }, 1);
			doc.taskId = await tx.createTask(
				Digest,
				{ periodMs, since: Date.now(), cursor: latest.items[0]?.id ?? 0 },
				{ ownership: { kind: "conversation" }, background: true },
			);
		}, context);
	}

	return { extension: defineExtension({ name: "soma.digest", tasks: [Digest] }), startDigest };
}
