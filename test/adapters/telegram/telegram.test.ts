import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { FakeHumanPort } from "../../../src/adapters/fake-human/index.ts";
import { FakeBotApi } from "../../../src/adapters/fake-telegram/index.ts";
import { runTelegram, splitMessage } from "../../../src/adapters/telegram/index.ts";
import { openHumanPort } from "../../../src/core/human-port.ts";
import type { HumanPort } from "../../../src/ports/human.ts";

const context = BACKGROUND_CONTEXT;
const TOKEN = "123:test";
const CHAT = 42;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function bot() {
	const api = new FakeBotApi(TOKEN);
	const apiBase = await api.listen();
	cleanup.push(() => api.close());
	return { api, apiBase };
}

function start(human: HumanPort, apiBase: string, onError = vi.fn()) {
	const controller = new AbortController();
	const running = runTelegram({ human, token: TOKEN, chatId: CHAT, apiBase, signal: controller.signal, onError });
	const stop = () => {
		controller.abort();
		return running;
	};
	cleanup.push(stop);
	return { stop, onError };
}

async function core() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const human = await openHumanPort(harness, root, context);
	cleanup.push(() => human.close());
	return { faux, root, human };
}

test("splitMessage cuts at a line break near the limit, keeps pairs whole, and never sends empty text", () => {
	expect(splitMessage("short")).toEqual(["short"]);
	expect(splitMessage(`${"a".repeat(7)}\n${"b".repeat(5)}`, 10)).toEqual(["aaaaaaa", "bbbbb"]);
	expect(splitMessage("a".repeat(25), 10)).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
	expect(splitMessage(`${"a".repeat(9)}😀b`, 10)).toEqual(["a".repeat(9), "😀b"]);
	expect(splitMessage(" ")).toEqual(["（這一輪沒有文字回答）"]);
});

test("a message is answered in its chat, and Telegram delivering it again after a restart starts no round", async () => {
	const { faux, root, human } = await core();
	faux.setResponses([fauxAssistantMessage("已派工 a。"), fauxAssistantMessage("不該有第二輪")]);
	const { api, apiBase } = await bot();
	const first = start(human, apiBase);

	const update = api.deliver("派 a", CHAT);
	await vi.waitFor(() => expect(api.sent).toEqual([{ chat_id: CHAT, text: "已派工 a。" }]));
	await first.stop();

	api.redeliver(update);
	start(human, apiBase);
	await vi.waitFor(async () => {
		const { items } = await root.entries({ order: "ascending" }, 100, undefined, context);
		expect(items.filter((entry) => entry.kind === "chat.telegram")).toHaveLength(1);
	});
	await new Promise((resolve) => setTimeout(resolve, 300));
	await root.waitForIdle(context);
	expect(faux.state.callCount).toBe(1);
	expect(api.sent).toHaveLength(1);
	const { items } = await root.entries({ order: "ascending" }, 100, undefined, context);
	expect(items.find((entry) => entry.kind === "chat.telegram")?.data).toEqual({
		messageId: update.message.message_id,
	});
});

test("this client's failed round goes back to its chat; another client's failure does not", async () => {
	const { faux, root, human } = await core();
	const boom = () => {
		throw new Error("401 invalid x-api-key");
	};
	faux.setResponses([boom, boom]);
	const { api, apiBase } = await bot();
	start(human, apiBase);

	await human.submit({ content: "你好", entry: { kind: "chat.terminal" }, requestId: "terminal:1" });
	await root.waitForIdle(context);
	api.deliver("你好", CHAT);

	await vi.waitFor(() => expect(api.sent).toHaveLength(1));
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(api.sent).toEqual([{ chat_id: CHAT, text: "[失敗] 模型出錯：401 invalid x-api-key" }]);
});

test("failures of schedule and event-bridge rounds are pushed; digest and other clients' failures are not", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);

	human.emit({ type: "failure", requestId: "terminal:1", reason: "x" });
	human.emit({ type: "failure", requestId: "schedule:4", reason: "模型出錯：y" });
	human.emit({ type: "failure", requestId: "digest:1", reason: "找不到模型" });

	human.emit({ type: "failure", requestId: "herdr:a:3", reason: "內部錯誤：z" });

	await vi.waitFor(() => expect(api.sent).toHaveLength(2));
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(api.sent.map((message) => message.text)).toEqual([
		"[失敗] schedule:4 那一輪：模型出錯：y",
		"[失敗] herdr:a:3 那一輪：內部錯誤：z",
	]);
});

test("each message becomes an input keyed by its message id; other chats are ignored", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);

	api.deliver("not you", 7);
	const mine = api.deliver("派 b", CHAT);
	await vi.waitFor(() => expect(human.inputs).toHaveLength(1));
	expect(human.inputs[0]).toEqual({
		content: "派 b",
		entry: { kind: "chat.telegram", data: { messageId: mine.message.message_id } },
		requestId: `telegram:${mine.message.message_id}`,
	});
});

test("only this client's answers, schedule rounds and notices reach the chat", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);

	human.emit({ type: "answer", requestId: "terminal:1", content: "terminal answer" });
	human.emit({ type: "answer", requestId: "herdr:a:3", content: "herdr wake" });
	human.emit({ type: "answer", requestId: "digest:2026-10-18T00:10:00.000Z", content: "digest round" });
	human.emit({ type: "run", state: "working" });
	human.emit({ type: "job", card: "a", agent: "a", status: { state: "done" } });
	human.emit({ type: "answer", requestId: "telegram:9", content: "mine" });
	human.emit({ type: "answer", requestId: "schedule:4", content: "提醒你：喝水" });
	human.emit({ type: "notice", kind: "report", content: "報告：a 完成" });
	human.emit({ type: "notice", kind: "question", content: "a 要密碼" });

	await vi.waitFor(() => expect(api.sent).toHaveLength(4));
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(api.sent.map((message) => message.text)).toEqual([
		"mine",
		"[通知] 提醒你：喝水",
		"[通知] 報告：a 完成",
		"[問題] a 要密碼",
	]);
	expect(api.sent.every((message) => message.chat_id === CHAT)).toBe(true);
});

test("a long answer arrives as ordered parts within the limit", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);

	human.emit({ type: "answer", requestId: "telegram:1", content: "x".repeat(5000) });
	human.emit({ type: "notice", kind: "report", content: "after" });

	await vi.waitFor(() => expect(api.sent).toHaveLength(3));
	expect(api.sent.map((message) => message.text.length)).toEqual([4096, 904, "[通知] after".length]);
});

test("a failing Bot API is reported and polled again", async () => {
	const human = new FakeHumanPort();
	const { apiBase } = await bot();
	const onError = vi.fn();
	const controller = new AbortController();
	const running = runTelegram({
		human,
		token: "wrong",
		chatId: CHAT,
		apiBase,
		signal: controller.signal,
		retryMs: 10,
		onError,
	});
	await vi.waitFor(() => expect(onError.mock.calls.length).toBeGreaterThanOrEqual(2));
	controller.abort();
	await running;
});
