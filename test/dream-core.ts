// A real core with the dream over the faux provider, for test/dream.test.ts and the crash child test/dream-child.ts.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, type Extension, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { clock } from "../src/core/extensions/clock/index.ts";
import { type DreamOptions, Dreams, dream } from "../src/core/extensions/dream/index.ts";
import { inspectExtension } from "../src/core/extensions/inspect/index.ts";
import { language } from "../src/core/extensions/language/index.ts";
import { memory } from "../src/core/extensions/memory/index.ts";
import { stopGuard } from "../src/core/extensions/stop/index.ts";
import { openHarness, openStorage } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";
import type { SomaEvent } from "../src/ports/human.ts";

export const context = BACKGROUND_CONTEXT;
export const ROOT_MODEL = "faux-root";
export const DREAM_MODEL = "faux-dream";
/** What the faux provider reports each round of each model cost: faux itself always reports 0. */
export const COST: Record<string, number> = { [ROOT_MODEL]: 0.0123, [DREAM_MODEL]: 0.4567 };
export const DREAM_ANSWER = "### 值得修的問題\n- 問題：讀檔工具一直出錯（DREAM-ANSWER-MARK）。";

export type Request = { model: string; context: TranscriptContext; options: SimpleStreamOptions | undefined };

export const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: (content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");

const priced = (message: AssistantMessage): AssistantMessage => ({
	...message,
	usage: { ...message.usage, cost: { ...message.usage.cost, total: COST[message.model] ?? 0 } },
});

/** Forwards the faux provider's events with each response's cost set from `COST`. */
function withCost(events: AssistantMessageEventStream): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void (async () => {
		for await (const event of events) {
			if (event.type === "done") out.push({ ...event, message: priced(event.message) });
			else if (event.type === "error") out.push({ ...event, error: priced(event.error) });
			else out.push(event);
		}
		out.end(priced(await events.result()));
	})();
	return out;
}

/**
 * The root model answers "好的。", calls the tool `broken` for an input asking to read a file and then says it failed,
 * calls `inspect` for usage when asked to, and for an input asking it to take its time waits until its request is
 * aborted. The dream model answers `DREAM_ANSWER` unless `dreamAnswer` says otherwise.
 */
function models(requests: Request[], dreamAnswer: () => AssistantMessage) {
	const faux = fauxProvider({ models: [{ id: ROOT_MODEL }, { id: DREAM_MODEL, reasoning: true }] });
	faux.setResponses(
		Array.from({ length: 60 }, () => async (request: TranscriptContext, options, _state, model) => {
			requests.push({ model: model.id, context: request, options });
			if (model.id === DREAM_MODEL) return dreamAnswer();
			const last = request.messages.findLast((message) => message.role !== "system");
			if (last?.role === "toolResult") return fauxAssistantMessage("失敗了，檔案讀不到。");
			const said = textOf(last?.content ?? "");
			if (said.includes("讀檔")) return fauxAssistantMessage([fauxToolCall("broken", {})], { stopReason: "toolUse" });
			if (said.includes("查用量"))
				return fauxAssistantMessage([fauxToolCall("inspect", { what: "usage" })], { stopReason: "toolUse" });
			if (said.includes("慢慢想")) {
				await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
				return fauxAssistantMessage("想到一半。");
			}
			return fauxAssistantMessage("好的。");
		}),
	);
	const provider = createProvider({
		id: faux.provider.id,
		auth: faux.provider.auth,
		models: faux.models,
		api: {
			stream: (model, request, options) => withCost(faux.provider.stream(model, request, options)),
			streamSimple: (model, request, options) => withCost(faux.provider.streamSimple(model, request, options)),
		},
	});
	const registry = createModels();
	registry.setProvider(provider);
	return registry;
}

const broken = defineExtension({
	name: "test.broken",
	tools: [
		defineTool({
			name: "broken",
			description: "Reads a file, and fails.",
			parameters: obj({}),
			replay: "safe",
			execute: async () => ({ output: [{ type: "text" as const, text: "ENOENT: 找不到檔案" }], isError: true }),
		}),
	],
});

export interface CoreOptions {
	db: string;
	/** The dream's options over the defaults below; false installs no dream at all. */
	dream?: Partial<DreamOptions> | false;
	/** Extensions in place of the dream's, as main.ts's wiring gives them. */
	extensions?: readonly Extension[];
	dreamAnswer?: () => AssistantMessage;
	/** False leaves the tasks to resume when the caller says. */
	resume?: boolean;
}

export async function openCore(options: CoreOptions) {
	const requests: Request[] = [];
	const storage = await openStorage(options.db);
	const dreams =
		options.dream === false
			? undefined
			: dream({
					storage,
					model: { provider: "faux", modelId: DREAM_MODEL },
					periodMs: 24 * 60 * 60_000,
					language: "zh-Hant",
					timeZone: "Asia/Taipei",
					...options.dream,
				});
	const harness: Harness = await openHarness(
		storage,
		[
			// Sections every root request carries, as main.ts installs them: the dream's request must carry neither.
			clock(Date.now, "Asia/Taipei"),
			language("zh-Hant"),
			stopGuard,
			memory,
			inspectExtension(storage),
			broken,
			...(dreams === undefined ? [] : [dreams.extension]),
			...(options.extensions ?? []),
		],
		context,
		{ models: models(requests, options.dreamAnswer ?? (() => fauxAssistantMessage(DREAM_ANSWER))) },
	);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: ROOT_MODEL } } });
	const human = await openHumanPort(harness, root, new FakeAgentPort(), context);
	if (options.resume !== false) harness.resume();
	const events: SomaEvent[] = [];
	human.subscribe((event) => events.push(event));
	const notices = () =>
		events.flatMap((event) =>
			event.type === "notice" && event.kind !== "forwarded" ? [{ content: event.content, class: event.class }] : [],
		);
	const checkpoint = async () => {
		const taskId = (await harness.snapshot(Dreams, root.id, context))?.taskId as TaskId | undefined;
		if (taskId === undefined) return undefined;
		const state = (await harness.getTask(taskId, context))?.state as unknown as {
			checkpoint: { since: number; next: number; until?: number };
		};
		return state.checkpoint;
	};
	return {
		harness,
		root,
		human,
		events,
		notices,
		requests,
		checkpoint,
		startDream: () => dreams?.startDream(root, context) ?? Promise.resolve(),
		async close() {
			await human.close();
			await harness.close(context);
		},
	};
}
