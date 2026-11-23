// A real core with the recurring schedule over the faux provider, for test/recurring.test.ts and the crash child
// test/recurring-child.ts.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, Harness, ModelRef, TaskId } from "@earendil-works/pi-durable";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { memory } from "../src/core/extensions/memory/index.ts";
import { schedule } from "../src/core/extensions/schedule/index.ts";
import { RESULT, type RecurringOptions, Rules, recurring } from "../src/core/extensions/schedule/recurring.ts";
import { openHarness, openStorage } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";
import type { SomaEvent } from "../src/ports/human.ts";

export const context = BACKGROUND_CONTEXT;
/** The fixed first line of a fire's input, by which the faux model tells a fire from the human. */
export const FIRE = /^Scheduled run of rule (\d+) \(([^)]*)\) for [^\n]*\.\n\n(.*)$/s;

export const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: (content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");

export type Request = { fire: boolean; context: TranscriptContext };

/**
 * The model, in the root and in every fire's conversation alike, as each starts as a copy of the root's agent. For the
 * human it calls `schedule_recurring` on 「每 <cron> 做 <instruction>」, `schedule` on 「提醒我 <words>」, `schedule_list`
 * on 「列出排程」 and `schedule_cancel` on 「取消排程 <id>」, and says 「好。」 otherwise. A fire's input is answered
 * `fire <n>: <instruction>`, `n` counting the fires this process answered, and fails while `failing` says so.
 */
export function fauxModels(options: { failing?: () => boolean } = {}) {
	const requests: Request[] = [];
	let fires = 0;
	const faux = fauxProvider();
	faux.setResponses(
		Array.from({ length: 200 }, () => (request: TranscriptContext) => {
			const last = request.messages.findLast((message) => message.role !== "system");
			const said = textOf(last?.content ?? "");
			const fire = last?.role === "user" && FIRE.test(said);
			requests.push({ fire, context: request });
			if (fire) {
				if (options.failing?.() === true) throw new Error("401 invalid x-api-key");
				return fauxAssistantMessage(`fire ${++fires}: ${FIRE.exec(said)?.[3]}`);
			}
			if (last?.role === "toolResult") return fauxAssistantMessage(`好。${said}`);
			const call = (name: string, args: Record<string, string>) =>
				fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
			const rule = /每 (.+?) 做 (.+)$/s.exec(said);
			if (rule?.[1] !== undefined && rule[2] !== undefined)
				return call("schedule_recurring", { cron: rule[1], instruction: rule[2] });
			const remind = /提醒我\s*(.+)$/s.exec(said);
			if (remind?.[1] !== undefined) return call("schedule", { at: "PT2S", instruction: remind[1] });
			if (said.includes("列出排程")) return call("schedule_list", {});
			const cancel = /取消排程\s*(\d+)/.exec(said);
			if (cancel?.[1] !== undefined) return call("schedule_cancel", { id: cancel[1] });
			const fired = /^\[schedule \d+\] (.*)$/s.exec(said);
			if (fired !== null) return fauxAssistantMessage(`提醒你：${fired[1]}`);
			return fauxAssistantMessage("好。");
		}),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, model: { provider: faux.provider.id, modelId: faux.getModel().id }, requests };
}

export interface CoreOptions extends RecurringOptions {
	db: string;
	models?: { models: Models; model: ModelRef };
	failing?: () => boolean;
	/** False leaves the tasks to resume when the caller says. */
	resume?: boolean;
}

export async function openCore(options: CoreOptions) {
	const faux = fauxModels({ ...(options.failing && { failing: options.failing }) });
	const { models, model } = options.models ?? faux;
	const storage = await openStorage(options.db);
	const recurringOptions: RecurringOptions = {
		...(options.nextFire && { nextFire: options.nextFire }),
		...(options.lateMs !== undefined && { lateMs: options.lateMs }),
	};
	const harness: Harness = await openHarness(
		storage,
		[memory, schedule((id, c) => harness.abortTask(id, c)), recurring(recurringOptions)],
		context,
		{ models },
	);
	const root = await harness.root(context, { agent: { model } });
	const human = await openHumanPort(harness, root, new FakeAgentPort(), context);
	if (options.resume !== false) harness.resume();
	const events: SomaEvent[] = [];
	human.subscribe((event) => events.push(event));
	const notices = () =>
		events.flatMap((event) =>
			event.type === "notice" && event.kind !== "forwarded" ? [{ content: event.content, class: event.class }] : [],
		);
	let said = 0;
	return {
		harness,
		root,
		human,
		storage,
		events,
		notices,
		requests: faux.requests,
		/** The human says `content` on the terminal; resolves with the answer once the round ends. */
		async say(content: string) {
			const requestId = `terminal:${++said}`;
			await human.submit({ content, entry: { kind: "chat.terminal" }, requestId });
			for (;;) {
				const answer = events.find((event) => event.type === "answer" && event.requestId === requestId);
				if (answer?.type === "answer") {
					await root.waitForIdle(context);
					return answer.content;
				}
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		},
		rules: async () => (await harness.snapshot(Rules, root.id, context))?.items ?? {},
		/** The conversations a rule's task owns, oldest first. */
		owned: (taskId: TaskId) =>
			root.commit(async (tx) => (await tx.scanConversations({ ownerTaskId: taskId }, 100)).items, context),
		/** The root's entries, oldest first. */
		entries: async () => (await root.entries({ order: "ascending" }, 1000, undefined, context)).items,
		results: async () =>
			(await root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter(
				(entry) => entry.kind === RESULT,
			),
		/** The submissions of a conversation, as stored. */
		submissions: async (conversationId: ConversationId) =>
			(await storage.scanSubmissions({ conversationId }, 1000, undefined, context)).items,
		async close() {
			await human.close();
			await harness.close(context);
		},
	};
}

export type Core = Awaited<ReturnType<typeof openCore>>;
