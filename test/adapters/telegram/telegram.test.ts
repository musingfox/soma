import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../../../src/adapters/fake-agent/index.ts";
import { FakeHumanPort } from "../../../src/adapters/fake-human/index.ts";
import { FakeBotApi } from "../../../src/adapters/fake-telegram/index.ts";
import { runTelegram, splitMessage } from "../../../src/adapters/telegram/index.ts";
import { Dispatches, dispatchExtension } from "../../../src/core/extensions/dispatch/index.ts";
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

async function core(registry = createRegistry()) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const human = await openHumanPort(harness, root, new FakeAgentPort(), context);
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
	await vi.waitFor(() => expect(api.sent).toEqual([{ chat_id: CHAT, text: "已派工 a。", parse_mode: "HTML" }]));
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
	expect(api.sent).toEqual([{ chat_id: CHAT, text: "[失敗] 模型出錯：401 invalid x-api-key", parse_mode: "HTML" }]);
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

test("a long answer arrives as ordered parts within the limit", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);

	human.emit({ type: "answer", requestId: "telegram:1", content: "x".repeat(5000) });
	human.emit({ type: "notice", kind: "report", class: "outcome", content: "after" });

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

const choices = {
	card: "card-a",
	fingerprint: "f00d",
	options: [
		{ id: "1", label: "Yes" },
		{ id: "2", label: "No" },
	],
};
const chosen = (text: string) => ({ inline_keyboard: [[{ text, callback_data: "-" }]] });

test("a question with choices arrives with a button per option; a press answers the agent and shows the choice", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);

	human.emit({ type: "notice", kind: "question", class: "action", content: "要讓它執行嗎？", choices });
	await vi.waitFor(() => expect(api.sent).toHaveLength(1));
	expect(api.sent[0]).toEqual({
		chat_id: CHAT,
		text: "[問題] 要讓它執行嗎？",
		parse_mode: "HTML",
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
	await vi.waitFor(() => expect(api.sent).toEqual([{ chat_id: CHAT, text: "[問題] q", parse_mode: "HTML" }]));
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
	expect(api.calls.map(({ method, params }) => [method, params.reply_markup])).toEqual([
		["editMessageReplyMarkup", elsewhere],
		["editMessageReplyMarkup", elsewhere],
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

test("a markdown answer arrives as Telegram HTML: formatting converted, markup characters escaped", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	const { onError } = start(human, apiBase);
	const answer =
		"# Plan\n\n- **one** & `a<b`\n- two\n\n| k | v |\n|---|--:|\n| x | 1 |\n\n```ts\nconst a = 1 < 2;\n```";

	human.emit({ type: "answer", requestId: "telegram:1", content: answer });
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
	expect(onError).not.toHaveBeenCalled();
});

test("notices, prompts with buttons and pushed failures are converted too, and the buttons still go once answered", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);

	human.emit({ type: "notice", kind: "report", class: "outcome", content: "**done** <3" });
	human.emit({ type: "notice", kind: "question", class: "action", content: "run `rm x`?", choices });
	human.emit({ type: "failure", requestId: "schedule:1", reason: "bad *thing* & <more>", class: "outcome" });
	await vi.waitFor(() => expect(api.sent).toHaveLength(3));
	expect(api.sent.map((message) => [message.parse_mode, message.text])).toEqual([
		["HTML", "[通知] <b>done</b> &lt;3"],
		["HTML", "[問題] run <code>rm x</code>?"],
		["HTML", "[失敗] schedule:1 那一輪：bad <i>thing</i> &amp; &lt;more&gt;"],
	]);
	expect(api.sent[1]?.reply_markup).toBeDefined();

	api.press("1:f00d:card-a", CHAT);
	await vi.waitFor(() =>
		expect(api.calls.map(({ method }) => method)).toEqual(["answerCallbackQuery", "editMessageReplyMarkup"]),
	);
	expect(human.answers).toEqual([{ card: "card-a", answer: { option: "1", fingerprint: "f00d" } }]);
});

test("a long markdown answer is split into parts that each parse, with the buttons on the last", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	const { onError } = start(human, apiBase);
	const answer = `**${"bold words here ".repeat(600)}**\n\n\`\`\`py\n${"print('a < b')\n".repeat(300)}\`\`\``;

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
});

test("a part Telegram refuses for its entities is resent as plain text, and nothing after it is lost", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	const { onError } = start(human, apiBase);
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
	expect(onError).not.toHaveBeenCalled();
});

test("a refusal that is not about entities is reported and not resent", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	const { onError } = start(human, apiBase);
	api.failing.add("sendMessage");

	human.emit({ type: "answer", requestId: "telegram:1", content: "**x**" });
	await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
	expect(api.sent).toEqual([]);
});
