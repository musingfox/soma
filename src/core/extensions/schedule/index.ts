import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, defineTask, defineTool, type TaskId } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { resolveAt } from "../../domain/schedule.ts";

export type Scheduled = { at: number; instruction: string; callId: string };

/** Pending reminders by task id; a reminder leaves in the commit that ends its task. */
export const Schedules = defineDoc<{ items: Record<string, Scheduled> }>({
	kind: "soma.schedule.items",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: {} }),
	checkpointWhen: () => false,
});

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

// The input is submitted before the terminal commit, so a crash between the two resubmits it, and the requestId makes
// the second submit return the first.
export const Reminder = defineTask<Scheduled, { phase: "wait"; at: number }, null>({
	name: "soma.schedule.reminder",
	version: 1,
	initial: ({ at }) => ({ phase: "wait", at }),
	phases: {
		wait: async (task, runtime, context) => {
			const { at } = task.state.checkpoint;
			if (runtime.now() < at) return runtime.sleepUntil(at, task.state.checkpoint, context);
			const root = await runtime.conversation(runtime.conversationId, context);
			await root?.submit(
				{
					type: "input",
					content: `[schedule ${task.id}] ${task.input.instruction}`,
					whenBusy: "followUp",
					entry: { kind: "schedule" },
					requestId: `schedule:${task.id}`,
				},
				context,
			);
			await runtime.commit(async (tx) => {
				delete (await tx.doc(Schedules, runtime.conversationId)).items[task.id];
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, context);
		},
	},
	abort: async (task, runtime, context) => {
		await runtime.commit(async (tx) => {
			delete (await tx.doc(Schedules, runtime.conversationId)).items[task.id];
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});

/** Tools get no task-abort API, so the host passes `Harness.abortTask` in. */
export function schedule(abortTask: (id: TaskId, context: Context) => Promise<unknown>) {
	const scheduleTool = defineTool({
		name: "schedule",
		description:
			"Deliver an instruction back to you at a given time. at: an ISO 8601 date-time with offset, or an ISO 8601 " +
			"duration from now such as PT2M. instruction: what to do then, in the user's words.",
		parameters: obj({ at: str(), instruction: str() }),
		// A rerun finds the reminder its first run created by call id instead of creating another.
		replay: "safe",
		execute: async ({ at, instruction }, api, context) => {
			const items = (await api.snapshot(Schedules, api.conversationId, context))?.items ?? {};
			const found = Object.entries(items).find(([, item]) => item.callId === api.callId);
			// Looked up before resolving `at`: a rerun after an absolute `at` passed must not report an error.
			if (found !== undefined) return text(`Scheduled ${found[0]} for ${new Date(found[1].at).toISOString()}.`);
			const reminder = { at: resolveAt(at, Date.now()), instruction, callId: api.callId };
			const id = await api.commit(async (tx) => {
				const taskId = await tx.createTask(Reminder, reminder, {
					ownership: { kind: "conversation" },
					background: true,
				});
				(await tx.doc(Schedules, api.conversationId)).items[taskId] = reminder;
				return taskId;
			}, context);
			return text(`Scheduled ${id} for ${new Date(reminder.at).toISOString()}.`);
		},
	});

	const listTool = defineTool({
		name: "schedule_list",
		description: "List pending scheduled instructions with their ids and times.",
		parameters: obj({}),
		replay: "safe",
		execute: async (_args, api, context) => {
			const items = (await api.snapshot(Schedules, api.conversationId, context))?.items ?? {};
			const lines = Object.entries(items).map(
				([id, item]) => `${id}: ${new Date(item.at).toISOString()} ${item.instruction}`,
			);
			return text(lines.length === 0 ? "Nothing scheduled." : lines.join("\n"));
		},
	});

	const cancelTool = defineTool({
		name: "schedule_cancel",
		description: "Cancel a pending scheduled instruction by the id schedule or schedule_list gave.",
		parameters: obj({ id: str() }),
		replay: "safe",
		execute: async ({ id }, api, context) => {
			const items = (await api.snapshot(Schedules, api.conversationId, context))?.items ?? {};
			if (!Object.hasOwn(items, id)) return text(`Nothing scheduled under ${id}.`);
			const taskId = Number(id) as TaskId;
			await abortTask(taskId, context);
			await api.waitForTask(taskId, context);
			return text(`Cancelled ${id}.`);
		},
	});

	return defineExtension({ name: "soma.schedule", tasks: [Reminder], tools: [scheduleTool, listTool, cancelTool] });
}
