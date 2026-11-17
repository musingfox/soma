import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../../../src/adapters/fake-agent/index.ts";
import { FakeHumanPort } from "../../../src/adapters/fake-human/index.ts";
import { FakeBotApi, type SentMessage } from "../../../src/adapters/fake-telegram/index.ts";
import { runTelegram, splitMessage } from "../../../src/adapters/telegram/index.ts";
import { PRESETS, type Preset } from "../../../src/core/domain/push.ts";
import { askExtension } from "../../../src/core/extensions/ask/index.ts";
import { Dispatches, dispatchExtension } from "../../../src/core/extensions/dispatch/index.ts";
import { Holds } from "../../../src/core/hold.ts";
import { openHumanPort } from "../../../src/core/human-port.ts";
import type { HumanPort, SomaEvent } from "../../../src/ports/human.ts";

const context = BACKGROUND_CONTEXT;
const TOKEN = "123:test";
const CHAT = 42;
const TELEGRAM = "chat.telegram";
const TERMINAL = "chat.terminal";
const MIN = 60_000;
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

async function core(registry = createRegistry(), storage = new MemoryStorage()) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(storage, { models, registry }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const human = await openHumanPort(harness, root, new FakeAgentPort(), context);
	cleanup.push(() => human.close());
	return { faux, root, human };
}

/**
 * A core whose model can ask, with Telegram as the default target at `summary` and the terminal at `terminal`, on a
 * clock the test moves; a due summary is checked for every 10 ms. Every event the HumanPort emits is kept in `seen`.
 */
async function summaryCore(terminal: Preset = "instant") {
	const storage = new MemoryStorage();
	const registry = createRegistry();
	registry.install(askExtension({ storage, interfaces: [TELEGRAM, TERMINAL] }));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(storage, { models, registry }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	let clock = 100 * MIN;
	const human = await openHumanPort(harness, root, new FakeAgentPort(), context, {
		defaultTarget: TELEGRAM,
		policies: { [TELEGRAM]: PRESETS.summary, [TERMINAL]: PRESETS[terminal] },
		now: () => clock,
		checkMs: 10,
		summaryIdleMs: 30 * MIN,
		storage,
	});
	cleanup.push(() => human.close());
	const seen: SomaEvent[] = [];
	human.subscribe((event) => seen.push(event));
	const held = () =>
		root.commit(async (tx) => JSON.parse(JSON.stringify((await tx.doc(Holds, root.id)).held)) as unknown[], context);
	return {
		faux,
		root,
		human,
		seen,
		held,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

const dinner = fauxAssistantMessage([fauxToolCall("ask", { question: "晚餐吃什麼？", options: ["拉麵", "咖哩"] })], {
	stopReason: "toolUse",
});
const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
/** The question id in the callback data of the first button of `message`. */
const questionOf = (message: SentMessage | undefined) =>
	/^ask\/([0-9a-f]{16})\/1$/.exec(message?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data ?? "")?.[1];

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
	await vi.waitFor(() => expect(api.sent).toEqual([{ chat_id: CHAT, text: "已派工 a。", rich: true }]));
	// The answered reaction goes out on a queue of its own, which the stop would cut short.
	await vi.waitFor(() => expect(api.reactions.map(({ emoji }) => emoji)).toEqual(["👀", "👍"]));
	await first.stop();

	api.redeliver(update);
	start(human, apiBase);
	await vi.waitFor(async () => {
		const { items } = await root.entries({ order: "ascending" }, 100, undefined, context);
		expect(items.filter((entry) => entry.kind === "chat.telegram")).toHaveLength(1);
	});
	// Marked received only once the core has admitted it again, which the entry above does not show.
	await vi.waitFor(() => expect(api.reactions).toHaveLength(3));
	await new Promise((resolve) => setTimeout(resolve, 300));
	await root.waitForIdle(context);
	expect(faux.state.callCount).toBe(1);
	expect(api.sent).toHaveLength(1);
	const { items } = await root.entries({ order: "ascending" }, 100, undefined, context);
	expect(items.find((entry) => entry.kind === "chat.telegram")?.data).toEqual({
		messageId: update.message.message_id,
	});
	// Accepted: the core admits a redelivered message silently, so it is marked received again and stays so.
	expect(api.reactions.map(({ emoji }) => emoji)).toEqual(["👀", "👍", "👀"]);
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
	expect(api.sent).toEqual([{ chat_id: CHAT, text: "[失敗] 模型出錯：401 invalid x-api-key", rich: true }]);
	await vi.waitFor(() => expect(api.reactions.map(({ emoji }) => emoji)).toEqual(["👀", "👎"]));
});

test("a message is marked received, then answered", async () => {
	const { faux, human } = await core();
	faux.setResponses([fauxAssistantMessage("好。")]);
	const { api, apiBase } = await bot();
	start(human, apiBase);

	const { message } = api.deliver("你好", CHAT);

	await vi.waitFor(() => expect(api.reactions).toHaveLength(2));
	expect(api.reactions).toEqual([
		{ message_id: message.message_id, emoji: "👀" },
		{ message_id: message.message_id, emoji: "👍" },
	]);
});

test("a message whose words went on to an agent is marked forwarded before it is answered", async () => {
	const registry = createRegistry();
	registry.install(dispatchExtension(new FakeAgentPort(), async (_repo, card) => `# ${card}`));
	const { faux, root, human } = await core(registry);
	await root.commit(async (tx) => {
		(await tx.doc(Dispatches, root.id)).jobs = [
			{ card: "a", agent: "a", sessionId: "s", status: { state: "idle" }, decisions: [] },
		];
	}, context);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("reply", { card: "a", text: "hi", reason: "人說 hi" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("已轉給 a。"),
	]);
	const { api, apiBase } = await bot();
	start(human, apiBase);

	api.deliver("跟 a 說 hi", CHAT);

	await vi.waitFor(() => expect(api.reactions).toHaveLength(3));
	expect(api.reactions.map(({ emoji }) => emoji)).toEqual(["👀", "👌", "👍"]);
});

test("only this client's inputs get reactions", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);

	human.emit({ type: "notice", kind: "forwarded", requestId: "terminal:1" });
	human.emit({ type: "answer", requestId: "schedule:4", content: "提醒你：喝水", class: "outcome" });
	human.emit({ type: "notice", kind: "forwarded", requestId: "telegram:5" });

	await vi.waitFor(() => expect(api.reactions).toHaveLength(1));
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(api.reactions).toEqual([{ message_id: 5, emoji: "👌" }]);
	expect(api.sent.map((message) => message.text)).toEqual(["[通知] 提醒你：喝水"]);
});

test("a refused reaction is reported, and the answer and the next message still go through", async () => {
	const { faux, human } = await core();
	faux.setResponses([fauxAssistantMessage("一。"), fauxAssistantMessage("二。")]);
	const { api, apiBase } = await bot();
	api.failing.add("setMessageReaction");
	const { onError } = start(human, apiBase);

	api.deliver("一", CHAT);
	await vi.waitFor(() => expect(api.sent).toHaveLength(1));
	api.deliver("二", CHAT);

	await vi.waitFor(() => expect(api.sent.map((message) => message.text)).toEqual(["一。", "二。"]));
	expect(onError).toHaveBeenCalledWith(
		expect.objectContaining({ message: expect.stringContaining("setMessageReaction") }),
	);
});

test("failures of schedule and event-bridge rounds are pushed; digest and other clients' failures are not", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);

	human.emit({ type: "failure", requestId: "terminal:1", reason: "x" });
	human.emit({ type: "failure", requestId: "schedule:4", reason: "模型出錯：y", class: "outcome" });
	human.emit({ type: "failure", requestId: "digest:1", reason: "找不到模型" });

	human.emit({ type: "failure", requestId: "agent:a:3", reason: "內部錯誤：z", class: "outcome" });

	await vi.waitFor(() => expect(api.sent).toHaveLength(2));
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(api.sent.map((message) => message.text)).toEqual([
		"[失敗] schedule:4 那一輪：模型出錯：y",
		"[失敗] agent:a:3 那一輪：內部錯誤：z",
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
	human.emit({ type: "answer", requestId: "agent:a:3", content: "herdr wake" });
	human.emit({ type: "answer", requestId: "digest:2026-10-18T00:10:00.000Z", content: "digest round" });
	human.emit({ type: "run", state: "working" });
	human.emit({ type: "job", card: "a", agent: "a", status: { state: "done" } });
	human.emit({ type: "answer", requestId: "telegram:9", content: "mine" });
	human.emit({ type: "answer", requestId: "schedule:4", content: "提醒你：喝水", class: "outcome" });
	human.emit({ type: "notice", kind: "report", class: "outcome", content: "報告：a 完成" });
	human.emit({ type: "notice", kind: "question", class: "action", content: "a 要密碼" });

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

test("a text over 32768 bytes of UTF-8 arrives whole as ordered HTML parts; one at the limit goes as one rich message", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);
	// 32769 bytes in 10923 characters, which a rich message would take: the bytes are what counts.
	const wide = "好".repeat(10923);

	human.emit({ type: "answer", requestId: "telegram:1", content: wide });
	human.emit({ type: "answer", requestId: "telegram:2", content: "x".repeat(32768) });
	human.emit({ type: "notice", kind: "report", class: "outcome", content: "after" });

	await vi.waitFor(() => expect(api.sent).toHaveLength(5));
	expect(api.sent.map((message) => [message.rich ?? false, message.parse_mode, message.text.length])).toEqual([
		[false, "HTML", 4096],
		[false, "HTML", 4096],
		[false, "HTML", 2731],
		[true, undefined, 32768],
		[true, undefined, "[通知] after".length],
	]);
	expect(
		api.sent
			.slice(0, 3)
			.map((message) => message.text)
			.join(""),
	).toBe(wide);
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

const choices = {
	card: "card-a",
	fingerprint: "f00d",
	options: [
		{ id: "1", label: "Yes" },
		{ id: "2", label: "No" },
	],
};
// toEqual tells a missing key from a set one, so the settled button must carry no callback_data.
const chosen = (text: string) => ({ inline_keyboard: [[{ text, disabled: {} }]] });

test("a question with choices arrives with a button per option; a press answers the agent and shows the choice", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);

	human.emit({ type: "notice", kind: "question", class: "action", content: "要讓它執行嗎？", choices });
	await vi.waitFor(() => expect(api.sent).toHaveLength(1));
	expect(api.sent[0]).toEqual({
		chat_id: CHAT,
		text: "[問題] 要讓它執行嗎？",
		rich: true,
		reply_markup: {
			inline_keyboard: [
				[{ text: "Yes", callback_data: "1:f00d:card-a" }],
				[{ text: "No", callback_data: "2:f00d:card-a" }],
			],
		},
	});

	const press = api.press("2:f00d:card-a", CHAT);
	await vi.waitFor(() => expect(api.calls).toHaveLength(2));
	expect(human.answers).toEqual([{ card: "card-a", answer: { option: "2", fingerprint: "f00d" } }]);
	expect(api.calls).toEqual([
		{ method: "answerCallbackQuery", params: { callback_query_id: press.callback_query.id, text: "已選：No" } },
		{
			method: "editMessageReplyMarkup",
			params: { chat_id: CHAT, message_id: press.callback_query.message.message_id, reply_markup: chosen("已選：No") },
		},
	]);
});

test("a press on a prompt that has since changed sends nothing and says so in the chat", async () => {
	const human = new FakeHumanPort();
	human.outcome = { sent: false, refusal: "stale" };
	const { api, apiBase } = await bot();
	start(human, apiBase);

	human.emit({ type: "notice", kind: "question", class: "action", content: "要讓它執行嗎？", choices });
	await vi.waitFor(() => expect(api.sent).toHaveLength(1));
	api.press("1:f00d:card-a", CHAT);

	await vi.waitFor(() => expect(api.calls).toHaveLength(2));
	expect(api.calls.map(({ params }) => params.text ?? params.reply_markup)).toEqual([
		"未送出：提示已經變了",
		chosen("未送出：提示已經變了"),
	]);
});

test("a press from another chat is ignored", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);

	human.emit({ type: "notice", kind: "question", class: "action", content: "要讓它執行嗎？", choices });
	await vi.waitFor(() => expect(api.sent).toHaveLength(1));
	api.press("1:f00d:card-a", 7);
	api.deliver("after", CHAT);

	await vi.waitFor(() => expect(human.inputs).toHaveLength(1));
	expect(human.answers).toEqual([]);
	expect(api.calls).toEqual([]);
});

test("choices whose button data would pass 64 bytes arrive as plain text", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);

	human.emit({
		type: "notice",
		kind: "question",
		class: "action",
		content: "q",
		choices: { ...choices, card: "c".repeat(60) },
	});
	await vi.waitFor(() => expect(api.sent).toEqual([{ chat_id: CHAT, text: "[問題] q", rich: true }]));
});

test("a callback Telegram no longer accepts an answer for does not hold the polling back", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	const { onError } = start(human, apiBase);

	human.emit({ type: "notice", kind: "question", class: "action", content: "q", choices });
	await vi.waitFor(() => expect(api.sent).toHaveLength(1));
	api.failing.add("answerCallbackQuery");
	api.press("1:f00d:card-a", CHAT);
	api.deliver("after", CHAT);

	await vi.waitFor(() => expect(human.inputs).toHaveLength(1));
	expect(human.answers).toHaveLength(1);
	expect(onError).toHaveBeenCalled();
});

test("a second tap on the same question answers nothing and leaves the first result shown", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);

	human.emit({ type: "notice", kind: "question", class: "action", content: "q", choices });
	await vi.waitFor(() => expect(api.sent).toHaveLength(1));
	api.press("2:f00d:card-a", CHAT);
	const second = api.press("2:f00d:card-a", CHAT);
	api.deliver("after", CHAT);

	await vi.waitFor(() => expect(human.inputs).toHaveLength(1));
	expect(human.answers).toHaveLength(1);
	expect(api.calls.filter(({ method }) => method === "editMessageReplyMarkup")).toHaveLength(1);
	expect(api.calls.at(-1)).toEqual({
		method: "answerCallbackQuery",
		params: { callback_query_id: second.callback_query.id },
	});
});

test('a press on an older message\'s settled button, whose data is "-", is answered and changes nothing', async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);

	// Update 0, so the fake's own next update still comes after it.
	api.redeliver({
		update_id: 0,
		callback_query: {
			id: "old",
			data: "-",
			message: {
				message_id: 99,
				chat: { id: CHAT },
				reply_markup: { inline_keyboard: [[{ text: "已選：No", callback_data: "-" }]] },
			},
		},
	});
	api.deliver("after", CHAT);

	await vi.waitFor(() => expect(human.inputs).toHaveLength(1));
	expect(human.answers).toEqual([]);
	expect(api.calls).toEqual([{ method: "answerCallbackQuery", params: { callback_query_id: "old" } }]);
});

test("a push arrives as the core delivers it here: ringing, silently, or not at all when logged", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);
	const report = { type: "notice", kind: "report", class: "outcome" } as const;

	human.emit({ ...report, content: "elsewhere", delivery: { "chat.terminal": "ring", "chat.telegram": "quiet" } });
	human.emit({ ...report, content: "here", delivery: { "chat.telegram": "ring" } });
	human.emit({ ...report, content: "anywhere" });
	human.emit({ ...report, content: "unnamed", delivery: { "chat.terminal": "ring" } });
	human.emit({ ...report, content: "logged", delivery: { "chat.telegram": "log", "chat.terminal": "ring" } });
	human.emit({ type: "failure", requestId: "schedule:1", reason: "boom", class: "outcome", delivery: {} });
	const logged = { "chat.telegram": "log" } as const;
	human.emit({ type: "failure", requestId: "schedule:2", reason: "logged", class: "outcome", delivery: logged });
	human.emit({ type: "answer", requestId: "schedule:3", content: "logged", class: "outcome", delivery: logged });
	human.emit({
		type: "answer",
		requestId: "schedule:4",
		content: "rung",
		class: "outcome",
		delivery: { "chat.telegram": "ring" },
	});
	await vi.waitFor(() => expect(api.sent).toHaveLength(6));
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(api.sent.map((message) => [message.text, message.disable_notification ?? false])).toEqual([
		["[通知] elsewhere", true],
		["[通知] here", false],
		["[通知] anywhere", false],
		["[通知] unnamed", true],
		["[失敗] schedule:1 那一輪：boom", true],
		["[通知] rung", false],
	]);
});

const elsewhere = chosen("已在別處處理");

test("a prompt's buttons go once its job leaves that prompt, unless a press here already settled it", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);
	const blocked = { state: "blocked", kind: "permission", fingerprint: "f00d" } as const;

	human.emit({ type: "notice", kind: "question", class: "action", content: "要讓它執行嗎？", choices });
	human.emit({
		type: "notice",
		kind: "question",
		class: "action",
		content: "還是要嗎？",
		choices,
		delivery: { "chat.telegram": "ring" },
	});
	await vi.waitFor(() => expect(api.sent).toHaveLength(2));
	human.emit({ type: "job", card: "card-a", agent: "card-a", status: blocked });
	human.emit({ type: "job", card: "card-b", agent: "card-b", status: { state: "working" } });
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(api.calls).toEqual([]);

	human.emit({ type: "job", card: "card-a", agent: "card-a", status: { state: "working" } });
	await vi.waitFor(() => expect(api.calls).toHaveLength(2));
	// The fake numbers its messages from 1: these are the two prompts.
	expect(api.calls.map(({ method, params }) => [method, params.message_id, params.reply_markup])).toEqual([
		["editMessageReplyMarkup", 1, elsewhere],
		["editMessageReplyMarkup", 2, elsewhere],
	]);

	human.emit({
		type: "notice",
		kind: "question",
		class: "action",
		content: "第三次",
		choices: { ...choices, fingerprint: "beef" },
	});
	await vi.waitFor(() => expect(api.sent).toHaveLength(3));
	api.press("1:beef:card-a", CHAT);
	await vi.waitFor(() => expect(api.calls).toHaveLength(4));
	human.emit({ type: "job", card: "card-a", agent: "card-a", status: { state: "idle" } });
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(api.calls).toHaveLength(4);
});

test("a question soma asks arrives with a button per option; a press is the human's answer and runs a round", async () => {
	const registry = createRegistry();
	const storage = new MemoryStorage();
	registry.install(askExtension({ storage, interfaces: [TELEGRAM, TERMINAL] }));
	const { faux, root, human } = await core(registry, storage);
	let heard = "";
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("ask", { question: "要我稍後再試一次嗎？", options: ["好", "不用"] })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("先停在這。"),
		(request) => {
			heard = JSON.stringify(request.messages.at(-1));
			return fauxAssistantMessage("好，十分鐘後再試。");
		},
		fauxAssistantMessage("不該有第三輪"),
	]);
	const { api, apiBase } = await bot();
	start(human, apiBase);

	api.deliver("部署失敗了", CHAT);
	await vi.waitFor(() => expect(api.sent).toHaveLength(2));
	const prompt = api.sent.find((message) => message.reply_markup !== undefined);
	const data = prompt?.reply_markup?.inline_keyboard.flat().map((button) => button.callback_data) ?? [];
	expect(data).toHaveLength(2);
	const question = /^ask\/([0-9a-f]{16})\/1$/.exec(data[0] ?? "")?.[1];
	expect(prompt).toEqual({
		chat_id: CHAT,
		text: "[問題] 要我稍後再試一次嗎？",
		rich: true,
		reply_markup: {
			inline_keyboard: [
				[{ text: "好", callback_data: `ask/${question}/1` }],
				[{ text: "不用", callback_data: `ask/${question}/2` }],
			],
		},
	});
	await root.waitForIdle(context);

	const press = api.press(`ask/${question}/1`, CHAT);
	await vi.waitFor(() => expect(api.sent.map(({ text }) => text)).toContain("好，十分鐘後再試。"));
	expect(JSON.parse(heard)).toMatchObject({ role: "user", content: "好" });
	const { items } = await root.entries({ order: "ascending" }, 100, undefined, context);
	expect(items.filter((entry) => entry.kind === "chat.telegram").map((entry) => entry.data)).toEqual([
		{ messageId: 1 },
		{ pressed: press.callback_query.message.message_id },
	]);
	expect(api.calls).toEqual([
		{ method: "answerCallbackQuery", params: { callback_query_id: press.callback_query.id, text: "已選：好" } },
		{
			method: "editMessageReplyMarkup",
			params: { chat_id: CHAT, message_id: press.callback_query.message.message_id, reply_markup: chosen("已選：好") },
		},
	]);
	// The round from the press shows the Thinking draft under the prompt's id; it has no message of the human's to mark.
	expect(api.drafts.map(({ draft_id }) => draft_id)).toContain(press.callback_query.message.message_id);
	await vi.waitFor(() => expect(api.reactions.map(({ message_id }) => message_id)).toEqual([1, 1]));

	// The button is disabled now; a stale client's second press is only answered.
	const second = api.press(`ask/${question}/2`, CHAT, press.callback_query.message.message_id);
	api.deliver("after", CHAT);
	await vi.waitFor(() => expect(faux.state.callCount).toBe(4));
	await root.waitForIdle(context);
	expect(api.calls).toHaveLength(3);
	expect(api.calls.at(-1)).toEqual({
		method: "answerCallbackQuery",
		params: { callback_query_id: second.callback_query.id },
	});
	const pressed = items.filter((entry) => entry.kind === "chat.telegram").length;
	const after = (await root.entries({ order: "ascending" }, 100, undefined, context)).items;
	expect(after.filter((entry) => entry.kind === "chat.telegram")).toHaveLength(pressed + 1);
});

test("a question pressed elsewhere shows the choice on every message here offering it, and no prompt's buttons go", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);
	const said = {
		question: "abc",
		options: [
			{ id: "1", label: "好" },
			{ id: "2", label: "不用" },
		],
	};

	human.emit({ type: "notice", kind: "question", class: "action", content: "要嗎？", choices: said });
	human.emit({ type: "notice", kind: "question", class: "action", content: "還是要嗎？", choices: said });
	human.emit({ type: "notice", kind: "question", class: "action", content: "要讓它執行嗎？", choices });
	await vi.waitFor(() => expect(api.sent).toHaveLength(3));
	human.emit({ type: "said", question: "other", label: "x" });
	human.emit({ type: "said", question: "abc", label: "不用" });
	await vi.waitFor(() => expect(api.calls).toHaveLength(2));
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(api.calls.map(({ method, params }) => [method, params.message_id, params.reply_markup])).toEqual([
		["editMessageReplyMarkup", 1, chosen("已選：不用")],
		["editMessageReplyMarkup", 2, chosen("已選：不用")],
	]);

	// Settled here, so a press that was on its way is only answered.
	api.press("ask/abc/1", CHAT, 1);
	api.deliver("after", CHAT);
	await vi.waitFor(() => expect(human.inputs).toHaveLength(1));
	expect(human.said).toEqual([]);
	expect(api.calls.at(-1)?.method).toBe("answerCallbackQuery");
});

test("a press goes to say, never to an agent; one the core finds settled or unknown shows why", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);
	const said = {
		question: "abc",
		options: [
			{ id: "1", label: "好" },
			{ id: "2", label: "不用" },
		],
	};

	// As after a restart: this adapter does not know the question was answered, the core does.
	human.saidOutcome = { said: false, refusal: "settled", label: "不用" };
	human.emit({ type: "notice", kind: "question", class: "action", content: "要嗎？", choices: said });
	await vi.waitFor(() => expect(api.sent).toHaveLength(1));
	const press = api.press("ask/abc/1", CHAT);
	await vi.waitFor(() => expect(api.calls).toHaveLength(2));
	expect(human.answers).toEqual([]);
	expect(human.said).toEqual([
		{
			question: "abc",
			option: "1",
			input: { entry: { kind: "chat.telegram", data: { pressed: 1 } }, requestId: "telegram:ask/abc" },
		},
	]);
	expect(api.calls.map(({ params }) => params.text ?? params.reply_markup)).toEqual([
		"已選：不用",
		chosen("已選：不用"),
	]);
	expect(api.drafts).toEqual([]);

	human.saidOutcome = { said: false, refusal: "no_question" };
	human.emit({ type: "notice", kind: "question", class: "action", content: "又一題", choices: said });
	await vi.waitFor(() => expect(api.sent).toHaveLength(2));
	api.press("ask/abc/2", CHAT);
	await vi.waitFor(() => expect(api.calls).toHaveLength(4));
	expect(api.calls.slice(2).map(({ params }) => params.text ?? params.reply_markup)).toEqual([
		"未送出：找不到這個問題",
		chosen("未送出：找不到這個問題"),
	]);
	expect(press.callback_query.message.message_id).toBe(1);
});

test("a say that throws is reported and leaves its buttons; a respond that throws settles as unknown", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	const { onError } = start(human, apiBase);
	const said = { question: "abc", options: [{ id: "1", label: "好" }] };
	const say = human.say.bind(human);
	const respond = human.respond.bind(human);
	vi.spyOn(human, "say").mockRejectedValueOnce(new Error("the db is gone"));
	vi.spyOn(human, "respond").mockRejectedValueOnce(new Error("the decision commit failed"));
	human.saidOutcome = { said: true, label: "好" };

	human.emit({ type: "notice", kind: "question", class: "action", content: "要嗎？", choices: said });
	human.emit({ type: "notice", kind: "question", class: "action", content: "要讓它執行嗎？", choices });
	await vi.waitFor(() => expect(api.sent).toHaveLength(2));
	const first = api.press("ask/abc/1", CHAT);
	const prompt = api.press("1:f00d:card-a", CHAT);
	api.deliver("after", CHAT);
	await vi.waitFor(() => expect(human.inputs).toHaveLength(1));
	expect(onError).toHaveBeenCalledTimes(2);
	const unknown = "不確定有沒有送出：出錯了，請到 agent 的畫面確認";
	expect(api.calls).toEqual([
		{
			method: "answerCallbackQuery",
			params: { callback_query_id: first.callback_query.id, text: "未送出：出錯了，可以再按一次" },
		},
		{ method: "answerCallbackQuery", params: { callback_query_id: prompt.callback_query.id, text: unknown } },
		{
			method: "editMessageReplyMarkup",
			params: { chat_id: CHAT, message_id: prompt.callback_query.message.message_id, reply_markup: chosen(unknown) },
		},
	]);

	// A second press on the prompt, from a client that still shows its buttons, reaches no agent: the keys may have gone.
	vi.mocked(human.respond).mockImplementation(respond);
	const again = api.press("1:f00d:card-a", CHAT, prompt.callback_query.message.message_id);
	await vi.waitFor(() => expect(api.calls).toHaveLength(4));
	expect(api.calls.at(-1)).toEqual({
		method: "answerCallbackQuery",
		params: { callback_query_id: again.callback_query.id },
	});
	expect(human.answers).toEqual([]);

	// say's message is not settled by the failure: the next press on it goes through.
	vi.mocked(human.say).mockImplementation(say);
	api.press("ask/abc/1", CHAT);
	await vi.waitFor(() => expect(api.calls).toHaveLength(6));
	expect(human.said).toHaveLength(1);
	expect(api.calls.at(-1)?.params.reply_markup).toEqual(chosen("已選：好"));
});

test("a press that throws leaves settled a message an event settled while the press was in flight", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);
	const said = { question: "abc", options: [{ id: "1", label: "好" }] };
	let fail = (_error: Error) => {};
	vi.spyOn(human, "say").mockImplementationOnce(
		() =>
			new Promise((_resolve, reject) => {
				fail = reject;
			}),
	);

	human.emit({ type: "notice", kind: "question", class: "action", content: "要嗎？", choices: said });
	await vi.waitFor(() => expect(api.sent).toHaveLength(1));
	const press = api.press("ask/abc/1", CHAT);
	await vi.waitFor(() => expect(human.say).toHaveBeenCalledOnce());
	// Said on another interface while this press waits: the event leaves the message to the press.
	human.emit({ type: "said", question: "abc", label: "好" });
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(api.calls).toEqual([]);
	fail(new Error("the db is gone"));
	await vi.waitFor(() => expect(api.calls).toHaveLength(2));
	expect(api.calls).toEqual([
		{ method: "answerCallbackQuery", params: { callback_query_id: press.callback_query.id, text: "已選：好" } },
		{
			method: "editMessageReplyMarkup",
			params: { chat_id: CHAT, message_id: press.callback_query.message.message_id, reply_markup: chosen("已選：好") },
		},
	]);

	// Still settled: a stale client's press is only answered.
	api.press("ask/abc/1", CHAT, press.callback_query.message.message_id);
	await vi.waitFor(() => expect(api.calls).toHaveLength(3));
	expect(api.calls.at(-1)?.params.text).toBeUndefined();
	expect(human.say).toHaveBeenCalledOnce();
});

test("at summary, a question asked in reply to a message from the chat comes at once with its buttons, and is never held", async () => {
	const { faux, root, human, seen, held, advance } = await summaryCore();
	faux.setResponses([
		dinner,
		fauxAssistantMessage("選一個吧。"),
		fauxAssistantMessage("好，拉麵。"),
		fauxAssistantMessage("不該有第四輪"),
	]);
	const { api, apiBase } = await bot();
	start(human, apiBase);

	api.deliver("用選項題問我：晚餐吃拉麵還是咖哩？", CHAT);
	await vi.waitFor(() => expect(api.sent).toHaveLength(2));
	const question = questionOf(api.sent[0]);
	// The question rings, and the answer after it to the same round does not: the reply rings once.
	expect(api.sent).toEqual([
		{
			chat_id: CHAT,
			text: "[問題] 晚餐吃什麼？",
			rich: true,
			reply_markup: {
				inline_keyboard: [
					[{ text: "拉麵", callback_data: `ask/${question}/1` }],
					[{ text: "咖哩", callback_data: `ask/${question}/2` }],
				],
			},
		},
		{ chat_id: CHAT, text: "選一個吧。", rich: true, disable_notification: true },
	]);
	expect(seen.find((event) => event.type === "notice" && event.kind === "question")).toMatchObject({
		delivery: { [TELEGRAM]: "ring", [TERMINAL]: "quiet" },
	});
	await root.waitForIdle(context);
	expect(await held()).toEqual([]);

	// Long past the idle time, unpressed: nothing was held, so no summary comes and the question is not offered again.
	advance(31 * MIN);
	await pause();
	expect(faux.state.callCount).toBe(2);
	expect(api.sent).toHaveLength(2);

	const press = api.press(`ask/${question}/1`, CHAT);
	await vi.waitFor(() => expect(api.sent.map(({ text }) => text)).toContain("好，拉麵。"));
	expect(api.calls.at(-1)).toEqual({
		method: "editMessageReplyMarkup",
		params: { chat_id: CHAT, message_id: press.callback_query.message.message_id, reply_markup: chosen("已選：拉麵") },
	});
	await root.waitForIdle(context);
	advance(31 * MIN);
	await pause();
	expect(faux.state.callCount).toBe(3);
	expect(api.sent).toHaveLength(3);
});

test("at summary, a question asked in a schedule round is held, then offered again with its buttons after the summary", async () => {
	const { faux, root, human, held, advance } = await summaryCore();
	faux.setResponses([
		dinner,
		fauxAssistantMessage("問了晚餐。"),
		fauxAssistantMessage("摘要：有一個問題等你。"),
		fauxAssistantMessage("好，咖哩。"),
		fauxAssistantMessage("不該有第五輪"),
	]);
	const { api, apiBase } = await bot();
	start(human, apiBase);

	await root.submit(
		{ type: "input", content: "晚餐提醒", entry: { kind: "schedule" }, requestId: "schedule:1" },
		context,
	);
	await root.waitForIdle(context);
	await vi.waitFor(async () => expect(await held()).toHaveLength(2));
	await pause();
	expect(api.sent).toEqual([]);

	advance(31 * MIN);
	await vi.waitFor(() => expect(api.sent).toHaveLength(2));
	const question = questionOf(api.sent[1]);
	expect(api.sent).toEqual([
		{ chat_id: CHAT, text: "[通知] 摘要：有一個問題等你。", rich: true },
		{
			chat_id: CHAT,
			text: "[問題] 晚餐吃什麼？",
			rich: true,
			disable_notification: true,
			reply_markup: {
				inline_keyboard: [
					[{ text: "拉麵", callback_data: `ask/${question}/1` }],
					[{ text: "咖哩", callback_data: `ask/${question}/2` }],
				],
			},
		},
	]);
	expect(await held()).toEqual([]);

	api.press(`ask/${question}/2`, CHAT);
	await vi.waitFor(() => expect(api.sent.map(({ text }) => text)).toContain("好，咖哩。"));
	expect(api.calls.at(-1)?.params.reply_markup).toEqual(chosen("已選：咖哩"));
});

test("with two interfaces at summary, the one whose message the round answers gets the question at once, the other holds it", async () => {
	const { faux, root, human, seen, held, advance } = await summaryCore("summary");
	faux.setResponses([
		dinner,
		fauxAssistantMessage("選一個吧。"),
		fauxAssistantMessage("摘要：有一個問題等你。"),
		fauxAssistantMessage("不該有第四輪"),
	]);
	const { api, apiBase } = await bot();
	start(human, apiBase);

	await human.submit({ content: "晚餐吃什麼？", entry: { kind: TERMINAL }, requestId: "terminal:1" });
	await root.waitForIdle(context);
	const asked = seen.filter((event) => event.type === "notice" && event.kind === "question");
	expect(asked).toEqual([expect.objectContaining({ delivery: { [TELEGRAM]: "log", [TERMINAL]: "ring" } })]);
	await vi.waitFor(async () => expect(await held()).toMatchObject([{ kind: "question", to: [TELEGRAM] }]));
	await pause();
	expect(api.sent).toEqual([]);

	advance(31 * MIN);
	await vi.waitFor(() => expect(api.sent).toHaveLength(2));
	expect(api.sent.map(({ text, disable_notification }) => [text, disable_notification])).toEqual([
		["[通知] 摘要：有一個問題等你。", undefined],
		["[問題] 晚餐吃什麼？", true],
	]);
	expect(questionOf(api.sent[1])).toMatch(/^[0-9a-f]{16}$/);
	// The terminal, which got the question at once, is shown neither the summary nor the question again.
	const after = seen.filter((event) => event.type === "notice" && event.kind !== "forwarded").slice(-2);
	expect(after.map((event) => ("delivery" in event ? event.delivery?.[TERMINAL] : undefined))).toEqual(["log", "log"]);
});

test("a steered round answering both interfaces sends its question at once to each, and neither holds it", async () => {
	const { faux, root, human, seen, held, advance } = await summaryCore("summary");
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	faux.setResponses([
		async () => {
			await gate;
			return fauxAssistantMessage([fauxToolCall("nothing", {})], { stopReason: "toolUse" });
		},
		dinner,
		fauxAssistantMessage("選一個吧。"),
		fauxAssistantMessage("不該有第四輪"),
	]);
	const { api, apiBase } = await bot();
	start(human, apiBase);

	await human.submit({ content: "晚餐", entry: { kind: TERMINAL }, requestId: "terminal:1" });
	await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
	await root.submit(
		{ type: "input", content: "吃什麼？", entry: { kind: TELEGRAM }, requestId: "telegram:steer", whenBusy: "steer" },
		context,
	);
	release();
	await root.waitForIdle(context);
	await vi.waitFor(() => expect(api.sent.some(({ reply_markup }) => reply_markup !== undefined)).toBe(true));
	const asked = seen.filter((event) => event.type === "notice" && event.kind === "question");
	expect(asked).toEqual([expect.objectContaining({ delivery: { [TELEGRAM]: "ring", [TERMINAL]: "ring" } })]);
	expect(await held()).toEqual([]);

	advance(31 * MIN);
	await pause();
	expect(faux.state.callCount).toBe(3);
});

/** The messages sent to the chat with a sound. */
const ringing = (api: FakeBotApi) => api.sent.filter(({ disable_notification }) => disable_notification !== true);
const dinnerKeyboard = (question: string | undefined) => ({
	inline_keyboard: [
		[{ text: "拉麵", callback_data: `ask/${question}/1` }],
		[{ text: "咖哩", callback_data: `ask/${question}/2` }],
	],
});

test("at summary, a round from the chat that asks and then writes nothing sends the question alone, ringing once", async () => {
	const { faux, root, human } = await summaryCore();
	faux.setResponses([dinner, fauxAssistantMessage(""), fauxAssistantMessage("不該有第三輪")]);
	const { api, apiBase } = await bot();
	const { onError } = drafting(human, apiBase);

	const { message } = api.deliver("用選項題問我晚餐", CHAT);
	await vi.waitFor(() => expect(api.reactions.map(({ emoji }) => emoji)).toEqual(["👀", "👍"]));
	await root.waitForIdle(context);
	await settle();
	// One message, the question with its keyboard and a sound; no placeholder after it.
	expect(api.sent).toEqual([
		{ chat_id: CHAT, text: "[問題] 晚餐吃什麼？", rich: true, reply_markup: dinnerKeyboard(questionOf(api.sent[0])) },
	]);
	expect(ringing(api)).toHaveLength(1);
	expect(api.reactions.every(({ message_id }) => message_id === message.message_id)).toBe(true);
	// The Thinking draft was shown and is sent no more.
	const drafts = api.drafts.length;
	expect(drafts).toBeGreaterThan(0);
	await settle();
	expect(api.drafts).toHaveLength(drafts);
	expect(onError).not.toHaveBeenCalled();
});

test("at summary, a round from the chat that asks and then writes text sends the question and the text, ringing once", async () => {
	const { faux, root, human } = await summaryCore();
	faux.setResponses([dinner, fauxAssistantMessage("想好再按。"), fauxAssistantMessage("不該有第三輪")]);
	const { api, apiBase } = await bot();
	start(human, apiBase);

	api.deliver("用選項題問我晚餐", CHAT);
	await vi.waitFor(() => expect(api.sent).toHaveLength(2));
	await root.waitForIdle(context);
	await settle();
	expect(api.sent).toEqual([
		{ chat_id: CHAT, text: "[問題] 晚餐吃什麼？", rich: true, reply_markup: dinnerKeyboard(questionOf(api.sent[0])) },
		{ chat_id: CHAT, text: "想好再按。", rich: true, disable_notification: true },
	]);
	expect(ringing(api)).toHaveLength(1);
	expect(api.reactions.map(({ emoji }) => emoji)).toEqual(["👀", "👍"]);
});

test("a round from the chat that asks twice rings with its first question only", async () => {
	const { faux, root, human } = await summaryCore();
	const lunch = fauxAssistantMessage([fauxToolCall("ask", { question: "午餐呢？", options: ["飯", "麵"] })], {
		stopReason: "toolUse",
	});
	faux.setResponses([dinner, lunch, fauxAssistantMessage(""), fauxAssistantMessage("不該有第四輪")]);
	const { api, apiBase } = await bot();
	start(human, apiBase);

	api.deliver("用選項題問我兩餐", CHAT);
	await vi.waitFor(() => expect(api.reactions.map(({ emoji }) => emoji)).toEqual(["👀", "👍"]));
	await root.waitForIdle(context);
	await settle();
	expect(api.sent.map(({ text, disable_notification }) => [text, disable_notification])).toEqual([
		["[問題] 晚餐吃什麼？", undefined],
		["[問題] 午餐呢？", true],
	]);
});

test("at summary, a round from the chat that asks nothing and writes nothing still gets the placeholder", async () => {
	const { faux, root, human } = await summaryCore();
	faux.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("不該有第二輪")]);
	const { api, apiBase } = await bot();
	start(human, apiBase);

	api.deliver("嗯", CHAT);
	await vi.waitFor(() => expect(api.sent).toHaveLength(1));
	await root.waitForIdle(context);
	await settle();
	expect(api.sent).toEqual([{ chat_id: CHAT, text: "（這一輪沒有文字回答）", rich: true }]);
	expect(api.reactions.map(({ emoji }) => emoji)).toEqual(["👀", "👍"]);
});

const gated = () => {
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { gate, release };
};
/** A tool round that waits for `gate`, so an input can join the round while it runs. */
const waiting = (gate: Promise<void>) => async () => {
	await gate;
	return fauxAssistantMessage([fauxToolCall("nothing", {})], { stopReason: "toolUse" });
};
const answersSeen = (seen: SomaEvent[]) =>
	seen.flatMap((event) => (event.type === "answer" ? [[event.requestId, event.asked]] : []));

test("an input from the chat that joins a round after its question is answered as following it: nothing more is sent", async () => {
	const { faux, root, human, seen } = await summaryCore();
	const { gate, release } = gated();
	faux.setResponses([dinner, waiting(gate), fauxAssistantMessage(""), fauxAssistantMessage("不該有第二輪")]);
	const { api, apiBase } = await bot();
	start(human, apiBase);

	const { message } = api.deliver("問我晚餐", CHAT);
	await vi.waitFor(() => expect(faux.state.callCount).toBe(2));
	await root.submit(
		{ type: "input", content: "快點", entry: { kind: TELEGRAM }, requestId: "telegram:steer", whenBusy: "steer" },
		context,
	);
	release();
	await root.waitForIdle(context);
	await settle();
	expect(answersSeen(seen)).toEqual([
		[`telegram:${message.message_id}`, true],
		["telegram:steer", true],
	]);
	expect(api.sent.map(({ text, disable_notification }) => [text, disable_notification])).toEqual([
		["[問題] 晚餐吃什麼？", undefined],
	]);
	expect(faux.state.callCount).toBe(3);
});

test("a message from the chat sent while a round that asked runs is a round of its own, which asked nothing", async () => {
	const { faux, root, human, seen } = await summaryCore();
	const { gate, release } = gated();
	faux.setResponses([
		dinner,
		waiting(gate),
		fauxAssistantMessage(""),
		fauxAssistantMessage(""),
		fauxAssistantMessage("不該"),
	]);
	const { api, apiBase } = await bot();
	start(human, apiBase);

	const first = api.deliver("問我晚餐", CHAT);
	await vi.waitFor(() => expect(faux.state.callCount).toBe(2));
	// Telegram submits as a follow-up: the message waits for the round to end and starts the next one.
	const second = api.deliver("快點", CHAT);
	await pause();
	release();
	await vi.waitFor(() => expect(faux.state.callCount).toBe(4));
	await root.waitForIdle(context);
	await settle();
	expect(answersSeen(seen)).toEqual([
		[`telegram:${first.message.message_id}`, true],
		[`telegram:${second.message.message_id}`, undefined],
	]);
	expect(api.sent.map(({ text, disable_notification }) => [text, disable_notification])).toEqual([
		["[問題] 晚餐吃什麼？", undefined],
		["（這一輪沒有文字回答）", undefined],
	]);
});

test("in a steered round, each interface's first question rings there and a later one is quiet there", async () => {
	const { faux, root, human, seen } = await summaryCore();
	const { gate, release } = gated();
	const lunch = fauxAssistantMessage([fauxToolCall("ask", { question: "午餐呢？", options: ["飯", "麵"] })], {
		stopReason: "toolUse",
	});
	faux.setResponses([dinner, waiting(gate), lunch, fauxAssistantMessage(""), fauxAssistantMessage("不該有第二輪")]);
	const { api, apiBase } = await bot();
	start(human, apiBase);

	await human.submit({ content: "晚餐", entry: { kind: TERMINAL }, requestId: "terminal:1" });
	await vi.waitFor(() => expect(faux.state.callCount).toBe(2));
	await root.submit(
		{ type: "input", content: "午餐也問", entry: { kind: TELEGRAM }, requestId: "telegram:steer", whenBusy: "steer" },
		context,
	);
	release();
	await root.waitForIdle(context);
	await settle();
	const asked = seen.flatMap((event) =>
		event.type === "notice" && event.kind === "question" ? [[event.content, event.delivery]] : [],
	);
	// The first went to the terminal only; Telegram, at summary, holds it.
	expect(asked).toEqual([
		["晚餐吃什麼？", { [TELEGRAM]: "log", [TERMINAL]: "ring" }],
		["午餐呢？", { [TELEGRAM]: "ring", [TERMINAL]: "quiet" }],
	]);
	expect(answersSeen(seen)).toEqual([
		["terminal:1", true],
		["telegram:steer", true],
	]);
	expect(api.sent.map(({ text, disable_notification }) => [text, disable_notification])).toEqual([
		["[問題] 午餐呢？", undefined],
	]);
});

test("a round from the chat that asks and then fails rings twice: the question, then the failure", async () => {
	const { faux, root, human } = await summaryCore();
	faux.setResponses([
		dinner,
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
		fauxAssistantMessage(""),
		fauxAssistantMessage("不該有第三輪"),
	]);
	const { api, apiBase } = await bot();
	start(human, apiBase);

	api.deliver("問我晚餐", CHAT);
	await vi.waitFor(() => expect(api.sent).toHaveLength(2));
	await root.waitForIdle(context);
	expect(api.sent.map(({ text, disable_notification }) => [text.split("：")[0], disable_notification])).toEqual([
		["[問題] 晚餐吃什麼？", undefined],
		["[失敗] 模型出錯", undefined],
	]);
	// The next round asks nothing and writes nothing: the placeholder, as for any such round.
	api.deliver("嗯", CHAT);
	await vi.waitFor(() => expect(api.sent).toHaveLength(3));
	expect(api.sent[2]).toEqual({ chat_id: CHAT, text: "（這一輪沒有文字回答）", rich: true });
});

/** A core whose HumanPort can be closed and opened again over the same harness, as a restart of soma's process does. */
async function reopenable() {
	const storage = new MemoryStorage();
	const registry = createRegistry();
	registry.install(askExtension({ storage, interfaces: [TELEGRAM, TERMINAL] }));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(storage, { models, registry }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const open = async () => {
		const human = await openHumanPort(harness, root, new FakeAgentPort(), context, {
			defaultTarget: TELEGRAM,
			policies: { [TELEGRAM]: PRESETS.summary, [TERMINAL]: PRESETS.instant },
			now: () => 100 * MIN,
			checkMs: 10,
			summaryIdleMs: 30 * MIN,
			storage,
		});
		cleanup.push(() => human.close());
		return human;
	};
	return { faux, root, open };
}

for (const asked of ["before", "after"] as const)
	test(`a HumanPort opened again in a round from the chat, ${asked} its question, sends nothing after the question`, async () => {
		const { faux, root, open } = await reopenable();
		const { gate, release } = gated();
		const late = async () => {
			await gate;
			return asked === "before" ? fauxAssistantMessage("") : dinner;
		};
		faux.setResponses(
			asked === "before"
				? [dinner, late, fauxAssistantMessage("不該有第二輪")]
				: [late, fauxAssistantMessage(""), fauxAssistantMessage("不該有第二輪")],
		);
		const { api, apiBase } = await bot();
		const first = await open();
		const telegram = start(first, apiBase);
		api.deliver("問我晚餐", CHAT);
		await vi.waitFor(() => expect(faux.state.callCount).toBe(asked === "before" ? 2 : 1));
		await pause();
		await telegram.stop();
		await first.close();

		start(await open(), apiBase);
		release();
		await root.waitForIdle(context);
		await settle();
		await settle();
		expect(api.sent.map(({ text, disable_notification }) => [text, disable_notification])).toEqual([
			["[問題] 晚餐吃什麼？", undefined],
		]);
	});

const markdownAnswer =
	"# Plan\n\n- **one** & `a<b`\n- two\n\n| k | v |\n|---|--:|\n| x | 1 |\n\n```ts\nconst a = 1 < 2;\n```";

test("a markdown answer with a table arrives as one rich message holding the model's text unchanged", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	const { onError } = start(human, apiBase);

	human.emit({ type: "answer", requestId: "telegram:1", content: markdownAnswer });
	await vi.waitFor(() => expect(api.sent).toHaveLength(1));
	expect(api.sent[0]).toEqual({ chat_id: CHAT, text: markdownAnswer, rich: true });
	expect(api.methods.filter((method) => method.startsWith("send"))).toEqual(["sendRichMessage"]);
	expect(onError).not.toHaveBeenCalled();
});

test("an answer with no text arrives as a rich message saying so", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);

	human.emit({ type: "answer", requestId: "telegram:1", content: "  " });
	await vi.waitFor(() => expect(api.sent).toEqual([{ chat_id: CHAT, text: "（這一輪沒有文字回答）", rich: true }]));
});

test("a text whose rich message Telegram refuses arrives as Telegram HTML, and the refusal is reported", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	const { onError } = start(human, apiBase);
	api.failing.add("sendRichMessage");

	human.emit({ type: "answer", requestId: "telegram:1", content: markdownAnswer });
	await vi.waitFor(() => expect(api.sent).toHaveLength(1));
	expect(api.sent[0]).toEqual({
		chat_id: CHAT,
		parse_mode: "HTML",
		text: [
			"<b>Plan</b>",
			"",
			"• <b>one</b> &amp; <code>a&lt;b</code>",
			"• two",
			"",
			"<pre>k | v",
			"--+--",
			"x | 1</pre>",
			"",
			'<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>',
		].join("\n"),
	});
	expect(onError).toHaveBeenCalledOnce();
	expect(onError).toHaveBeenCalledWith(
		expect.objectContaining({ message: expect.stringContaining("sendRichMessage") }),
	);
});

test("a rich message that gets no answer is reported and not resent as HTML", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	const { onError } = start(human, apiBase);
	api.dropping.add("sendRichMessage");

	human.emit({ type: "answer", requestId: "telegram:1", content: "**x**" });
	await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(api.methods.filter((method) => method.startsWith("send"))).toEqual(["sendRichMessage"]);
	expect(api.sent).toEqual([]);
});

test("notices, prompts with buttons and pushed failures go as rich messages too, and the buttons still go once answered", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);

	human.emit({ type: "notice", kind: "report", class: "outcome", content: "**done** <3" });
	human.emit({ type: "notice", kind: "question", class: "action", content: "run `rm x`?", choices });
	human.emit({ type: "failure", requestId: "schedule:1", reason: "bad *thing* & <more>", class: "outcome" });
	await vi.waitFor(() => expect(api.sent).toHaveLength(3));
	expect(api.sent.map((message) => [message.rich, message.text])).toEqual([
		[true, "[通知] **done** <3"],
		[true, "[問題] run `rm x`?"],
		[true, "[失敗] schedule:1 那一輪：bad *thing* & <more>"],
	]);
	expect(api.sent[1]?.reply_markup).toBeDefined();

	api.press("1:f00d:card-a", CHAT);
	await vi.waitFor(() =>
		expect(api.calls.map(({ method }) => method)).toEqual(["answerCallbackQuery", "editMessageReplyMarkup"]),
	);
	expect(human.answers).toEqual([{ card: "card-a", answer: { option: "1", fingerprint: "f00d" } }]);
});

test("a prompt too long for a rich message is split into HTML parts that each parse, with the buttons on the last", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	const { onError } = start(human, apiBase);
	const answer = `**${"bold words here ".repeat(2100)}**\n\n\`\`\`py\n${"print('a < b')\n".repeat(300)}\`\`\``;

	human.emit({ type: "notice", kind: "question", class: "action", content: answer, choices });
	await vi.waitFor(() => expect(api.sent.length).toBeGreaterThan(3));
	expect(onError).not.toHaveBeenCalled();
	for (const message of api.sent) {
		expect(message.text.length).toBeLessThanOrEqual(4096);
		expect(message.parse_mode).toBe("HTML");
	}
	expect(api.sent.slice(0, -1).every((message) => message.reply_markup === undefined)).toBe(true);
	expect(api.sent.at(-1)?.reply_markup).toBeDefined();
	expect(api.sent.at(-1)?.text).toContain('<pre><code class="language-py">');

	human.emit({ type: "job", card: "card-a", agent: "card-a", status: { state: "working" } });
	await vi.waitFor(() => expect(api.calls).toHaveLength(1));
	// The fake numbers its messages from 1, so the last part's id is the count of parts.
	expect(api.calls[0]?.params.message_id).toBe(api.sent.length);
});

test("a part Telegram refuses for its entities is resent as plain text, and nothing after it is lost", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	const { onError } = start(human, apiBase);
	api.failing.add("sendRichMessage");
	api.refuseEntities = true;

	human.emit({ type: "notice", kind: "question", class: "action", content: "**sure** about `a<b`?", choices });
	human.emit({ type: "answer", requestId: "telegram:1", content: "*next*" });
	await vi.waitFor(() => expect(api.sent).toHaveLength(2));
	expect(api.sent[0]).toEqual({
		chat_id: CHAT,
		text: "[問題] sure about a<b?",
		reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
	});
	expect(api.sent[1]).toEqual({ chat_id: CHAT, text: "next" });
	expect(api.methods.filter((method) => method === "sendRichMessage")).toHaveLength(2);
	expect(onError).toHaveBeenCalledTimes(2);
});

test("a refusal that is not about entities is reported and not resent", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	const { onError } = start(human, apiBase);
	api.failing.add("sendRichMessage");
	api.failing.add("sendMessage");

	human.emit({ type: "answer", requestId: "telegram:1", content: "**x**" });
	await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(api.methods.filter((method) => method.startsWith("send"))).toEqual(["sendRichMessage", "sendMessage"]);
	expect(api.sent).toEqual([]);
});

// The draft refreshed every few milliseconds, so a test sees several refreshes of an open round.
function drafting(human: HumanPort, apiBase: string, limit: { draftLimitMs?: number } = {}) {
	const onError = vi.fn();
	const controller = new AbortController();
	const options = { human, token: TOKEN, chatId: CHAT, apiBase, signal: controller.signal, onError };
	const running = runTelegram({ ...options, draftRefreshMs: 20, ...limit });
	cleanup.push(() => {
		controller.abort();
		return running;
	});
	return { onError };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

test("a message from the chat gets a Thinking draft under its id once the core has admitted it", async () => {
	const human = new FakeHumanPort();
	let admit = () => {};
	const admitted = new Promise<void>((resolve) => {
		admit = resolve;
	});
	const submit = human.submit.bind(human);
	vi.spyOn(human, "submit").mockImplementation(async (input) => {
		await admitted;
		await submit(input);
	});
	const { api, apiBase } = await bot();
	start(human, apiBase);

	api.deliver("not you", 7);
	const { message } = api.deliver("你好", CHAT);
	await vi.waitFor(() => expect(human.submit).toHaveBeenCalledTimes(1));
	await settle();
	expect(api.drafts).toEqual([]);

	admit();
	await vi.waitFor(() => expect(api.drafts).toEqual([{ chat_id: CHAT, draft_id: message.message_id, text: "" }]));
});

test("an open round's draft is sent again until its answer or its failure, and then no more", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	drafting(human, apiBase);
	const sentFor = (update: { message: { message_id: number } }) =>
		api.drafts.filter(({ draft_id }) => draft_id === update.message.message_id).length;

	const answered = api.deliver("一", CHAT);
	const failed = api.deliver("二", CHAT);
	await vi.waitFor(() => expect(Math.min(sentFor(answered), sentFor(failed))).toBeGreaterThanOrEqual(3));

	human.emit({ type: "answer", requestId: `telegram:${answered.message.message_id}`, content: "好" });
	human.emit({ type: "failure", requestId: `telegram:${failed.message.message_id}`, reason: "x" });
	await settle();
	const after = api.drafts.length;
	await settle();
	expect(api.drafts).toHaveLength(after);
	expect(api.sent.map((sent) => sent.text)).toEqual(["好", "[失敗] x"]);
});

test("a message Telegram delivers again while its round is open keeps one refresh, which its answer ends", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	drafting(human, apiBase);

	const update = api.deliver("一", CHAT);
	await vi.waitFor(() => expect(api.drafts.length).toBeGreaterThanOrEqual(2));
	api.redeliver(update);
	await vi.waitFor(() => expect(api.reactions).toHaveLength(2));
	human.emit({ type: "answer", requestId: `telegram:${update.message.message_id}`, content: "好" });

	await settle();
	const after = api.drafts.length;
	await settle();
	expect(api.drafts).toHaveLength(after);
});

test("a round answered before its submit resolves shows no draft", async () => {
	const human = new FakeHumanPort();
	const submit = human.submit.bind(human);
	vi.spyOn(human, "submit").mockImplementation(async (input) => {
		await submit(input);
		human.emit({ type: "answer", requestId: input.requestId, content: "快" });
	});
	const { api, apiBase } = await bot();
	drafting(human, apiBase);

	api.deliver("一", CHAT);
	await vi.waitFor(() => expect(api.reactions).toHaveLength(2));
	await settle();
	expect(api.drafts).toEqual([]);
});

test("a refused draft is reported, and the answers and the reactions still go through", async () => {
	const { faux, human } = await core();
	faux.setResponses([fauxAssistantMessage("一。"), fauxAssistantMessage("二。")]);
	const { api, apiBase } = await bot();
	api.failing.add("sendMessageDraft");
	const { onError } = start(human, apiBase);

	api.deliver("一", CHAT);
	await vi.waitFor(() => expect(api.sent).toHaveLength(1));
	api.deliver("二", CHAT);

	await vi.waitFor(() => expect(api.sent.map((message) => message.text)).toEqual(["一。", "二。"]));
	await vi.waitFor(() => expect(api.reactions.map(({ emoji }) => emoji)).toEqual(["👀", "👍", "👀", "👍"]));
	expect(onError).toHaveBeenCalledWith(
		expect.objectContaining({ message: expect.stringContaining("sendMessageDraft") }),
	);
});

test("a round whose answer does not come stops getting the draft after the limit, and its answer still arrives", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	drafting(human, apiBase, { draftLimitMs: 100 });

	const { message } = api.deliver("一", CHAT);
	await vi.waitFor(() => expect(api.drafts.length).toBeGreaterThanOrEqual(3));
	await settle();
	await settle();
	const after = api.drafts.length;
	// Sent at once and on each refresh up to the limit: 100 ms of 20 ms refreshes.
	expect(after).toBeLessThanOrEqual(6);
	await settle();
	expect(api.drafts).toHaveLength(after);

	human.emit({ type: "answer", requestId: `telegram:${message.message_id}`, content: "好" });
	await vi.waitFor(() => expect(api.sent.map((sent) => sent.text)).toEqual(["好"]));
	await vi.waitFor(() => expect(api.reactions.map(({ emoji }) => emoji)).toEqual(["👀", "👍"]));
});
