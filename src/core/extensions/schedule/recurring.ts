import {
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryDraft,
	type EntryRecord,
	type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { nextFire as cronNextFire, fireInput, fireResult, isSilent } from "../../domain/schedule.ts";
import { noticeEntry } from "../../notice.ts";

export type Rule = { cron: string; instruction: string; callId: string; next: number };

/** Recurring rules by task id; `next` moves in the commit that moves the task's checkpoint, and a rule leaves on abort. */
export const Rules = defineDoc<{ items: Record<string, Rule> }>({
	kind: "soma.schedule.rules",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: {} }),
	checkpointWhen: () => false,
});

/** The root entry by which the root's model sees what a fire told the human; the notice itself is display-only. */
export const RESULT = "soma.schedule.result";

/** The fire's input in its own conversation, so a rerun after a crash finds the one it submitted. */
export const fireRequestId = (id: number, slot: number) => `recurring:${id}:${slot}`;

/** The told text of a fire: the rule's head line, then the answer, or why there is none. */
export const toldText = (
	id: number,
	cron: string,
	outcome: { answer: string } | { failure: string; instruction: string },
) =>
	"answer" in outcome
		? `[schedule ${id} · ${cron}]\n${outcome.answer}`
		: `[schedule ${id} · ${cron}] did not finish: ${outcome.failure}. The instruction was: ${outcome.instruction}`;

export function resultEntry(id: number, cron: string, slot: number, told: string, now: number): EntryDraft {
	return {
		kind: RESULT,
		data: { rule: id, slot },
		model: [{ role: "user", content: fireResult(id, cron, slot, told), timestamp: now }],
	};
}

type Checkpoint = {
	phase: "wait";
	next: number;
	// Pinned before the submit, so a rerun after a crash waits for the same input in the same conversation.
	slot?: number;
	conversationId?: number;
};

const textOf = (entry: EntryRecord | undefined) =>
	(entry?.model ?? [])
		.flatMap((message) => (message.role === "assistant" ? message.content : []))
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("");

const reasonOf = (record: Extract<SubmissionRecord, { status: "unanswered" }>) => {
	const { reason, detail } = record;
	const text = typeof detail === "string" ? detail : detail === undefined ? "" : JSON.stringify(detail);
	return text === "" ? reason : `${reason}: ${text}`;
};

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

/**
 * The root's tools a fire does without: the schedule tools, so a rule cannot make, list or end rules, and `ask`, as no
 * one answers a fire's question.
 */
export const FIRE_REMOVED: readonly string[] = [
	"schedule",
	"schedule_list",
	"schedule_cancel",
	"schedule_recurring",
	"ask",
];

export interface RecurringOptions {
	/** The slot after `after`, in epoch ms; tests set a short one. */
	nextFire?: (cron: string, after: number) => number;
	/** How late a wake may be and still fire; a later one skips its slot, as after soma was down. */
	lateMs?: number;
}

/**
 * Recurring rules (ARCHITECTURE.md "Recurring schedule"). Each fire runs the instruction in a fresh conversation the
 * rule's task owns, with the root's model, extensions, sections and tools but `FIRE_REMOVED`; a tool there that acts on
 * the root's documents, such as `dispatch`, reaches them by the home rule (`home.ts`). Its answer is told to the human
 * as a notice and written into the root's context, in the commit that moves the rule to its next slot, unless it is
 * only `NO_REPLY`. The root's model is not woken.
 */
export function recurring({ nextFire = cronNextFire, lateMs = 60_000 }: RecurringOptions = {}) {
	const Recurring = defineTask<Rule, Checkpoint, null>({
		name: "soma.schedule.recurring",
		version: 1,
		initial: ({ next }) => ({ phase: "wait", next }),
		phases: {
			wait: async (task, runtime, context) => {
				const { cron, instruction } = task.input;
				const checkpoint = task.state.checkpoint;
				let pinned = checkpoint;
				if (checkpoint.conversationId === undefined) {
					const now = runtime.now();
					if (now < checkpoint.next) return runtime.sleepUntil(checkpoint.next, checkpoint, context);
					if (now - checkpoint.next > lateMs) {
						const next = nextFire(cron, now);
						await runtime.commit(async (tx) => {
							const rule = (await tx.doc(Rules, runtime.conversationId)).items[task.id];
							if (rule !== undefined) rule.next = next;
							return { status: "running", checkpoint: { phase: "wait", next } };
						}, context);
						return;
					}
					await runtime.commit(async (tx, current) => {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: current.id } });
						// It starts as a copy of the root's agent: its model, extensions, sections and tools, less these. They are
						// stored by name, so the registry's own registrations name them.
						const removed = runtime.registry
							.tools()
							.flatMap(({ tool }) => (FIRE_REMOVED.includes(tool.name) ? [tool] : []));
						await configure(tx, created.id, { tools: { remove: removed } });
						pinned = { ...checkpoint, slot: checkpoint.next, conversationId: created.id };
						return { status: "running", checkpoint: pinned };
					}, context);
				}
				const slot = pinned.slot ?? pinned.next;
				const conversationId = pinned.conversationId as ConversationId;
				const child = await runtime.conversation(conversationId, context);
				const submission = await child?.submit(
					{
						type: "input",
						content: fireInput(task.id, cron, slot, instruction),
						requestId: fireRequestId(task.id, slot),
					},
					context,
				);
				const settled = await submission?.wait(context);
				let answer = "";
				if (settled?.type === "input" && settled.status === "done") {
					const id = settled.answer;
					await runtime.commit(async (tx) => {
						answer = textOf(await tx.entry(id));
					}, context);
				}
				const failure =
					settled?.type === "input" && settled.status === "done"
						? answer.trim() === ""
							? "the answer had no text"
							: undefined
						: settled?.status === "unanswered"
							? reasonOf(settled as Extract<SubmissionRecord, { status: "unanswered" }>)
							: "its conversation was not found";
				// A failure is told whatever the model wrote before it, so only a finished answer can be silent.
				const silent = failure === undefined && isSilent(answer);
				const told = toldText(task.id, cron, failure === undefined ? { answer } : { failure, instruction });
				const root = await runtime.conversation(runtime.conversationId, context);
				await runtime.commit(async (tx, current) => {
					const now = runtime.now();
					if (!silent) {
						// First in the commit, as an admission must be. Idle, the root gets the entry now; busy, at its next
						// boundary: either way no round starts for it, and the model has it at its next request.
						await root?.submit(tx, { type: "write", entry: resultEntry(task.id, cron, slot, told, now) });
						await tx.appendEntry(current.conversationId, noticeEntry("report", "outcome", told));
					}
					// A slot that passed while the fire ran is skipped.
					const next = nextFire(cron, now);
					const rule = (await tx.doc(Rules, current.conversationId)).items[task.id];
					if (rule !== undefined) rule.next = next;
					return { status: "running", checkpoint: { phase: "wait", next } };
				}, context);
				console.error(
					`[soma] schedule ${task.id} (${cron}) fired in conversation ${conversationId}${silent ? ", silent" : ""}`,
				);
			},
		},
		abort: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				delete (await tx.doc(Rules, runtime.conversationId)).items[task.id];
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});

	const recurringTool = defineTool({
		name: "schedule_recurring",
		description:
			"Run an instruction again and again on a cron rule, each time on its own, and tell the user what it says. " +
			"cron: five fields, minute hour day-of-month month day-of-week, in this machine's local time, such as " +
			"0 9 * * 1-5 for 09:00 on weekdays; numbers, *, ranges a-b, steps */n or a-b/n and comma lists, no names. " +
			"instruction: what to do each time, in the user's words. schedule_list lists rules, schedule_cancel ends one.",
		parameters: obj({ cron: str(), instruction: str() }),
		// A rerun finds the rule its first run created by call id instead of creating another.
		replay: "safe",
		execute: async ({ cron, instruction }, api, context) => {
			const items = (await api.snapshot(Rules, api.conversationId, context))?.items ?? {};
			const found = Object.entries(items).find(([, rule]) => rule.callId === api.callId);
			if (found !== undefined)
				return text(`Scheduled ${found[0]}: ${found[1].cron}, next ${new Date(found[1].next).toISOString()}.`);
			const now = api.now();
			// Throws on a cron that does not parse or never matches, whatever slot function the host set.
			cronNextFire(cron, now);
			const rule = { cron, instruction, callId: api.callId, next: nextFire(cron, now) };
			const id = await api.commit(async (tx) => {
				const taskId = await tx.createTask(Recurring, rule, { ownership: { kind: "conversation" }, background: true });
				(await tx.doc(Rules, api.conversationId)).items[taskId] = rule;
				return taskId;
			}, context);
			return text(`Scheduled ${id}: ${cron}, next ${new Date(rule.next).toISOString()}.`);
		},
	});

	return defineExtension({ name: "soma.schedule.recurring", tasks: [Recurring], tools: [recurringTool] });
}
