import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../../../src/adapters/fake-agent/index.ts";
import { FakeHumanPort } from "../../../src/adapters/fake-human/index.ts";
import { FakeBotApi, type SentMessage } from "../../../src/adapters/fake-telegram/index.ts";
import { runTelegram, splitMessage } from "../../../src/adapters/telegram/index.ts";
import { HUMAN_CHOSEN } from "../../../src/core/domain/dispatch.ts";
import { PRESETS, type Preset } from "../../../src/core/domain/push.ts";
import { askExtension } from "../../../src/core/extensions/ask/index.ts";
import { eventBridge } from "../../../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../../../src/core/extensions/dispatch/index.ts";
import { Holds } from "../../../src/core/hold.ts";
import { openHumanPort } from "../../../src/core/human-port.ts";
import type { HumanPort, SomaEvent } from "../../../src/ports/human.ts";
import { steppedModel } from "../../stepped-model.ts";

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

/**
 * A core with the event bridge over a fake agent side and one idle job, `pick`, whose turns the test ends; with
 * `summary`, Telegram is the default target at `summary` on a clock the test moves, as in `summaryCore`.
 */
async function jobCore({ summary = false } = {}) {
	const storage = new MemoryStorage();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	let clock = 100 * MIN;
	const agents = new FakeAgentPort();
	const human = await openHumanPort(
		harness,
		root,
		agents,
		context,
		summary
			? {
					defaultTarget: TELEGRAM,
					policies: { [TELEGRAM]: PRESETS.summary },
					now: () => clock,
					checkMs: 10,
					summaryIdleMs: 30 * MIN,
					storage,
				}
			: undefined,
	);
	cleanup.push(() => human.close());
	await root.commit(async (tx) => {
		const job = { card: "pick", agent: "pick", sessionId: "s", status: { state: "idle" as const }, decisions: [] };
		(await tx.doc(Dispatches, root.id)).jobs.push(job);
	}, context);
	const bridge = eventBridge(root, agents, context);
	const handled: Promise<void>[] = [];
	agents.onStatus((event) => handled.push(bridge.handle(event)));
	/** Runs a turn of `pick` that ends on `reply`, and waits until the bridge recorded it. */
	const turn = async (reply: string) => {
		agents.emit("pick", { state: "working" });
		agents.finish("pick", reply);
		await Promise.all(handled);
	};
	/** Waits until the bridge handled every status reported so far. */
	const settle = async () => {
		await Promise.all(handled);
	};
	const job = async () =>
		(await harness.snapshot(Dispatches, root.id, context))?.jobs.find((each) => each.card === "pick");
	const held = () =>
		root.commit(async (tx) => JSON.parse(JSON.stringify((await tx.doc(Holds, root.id)).held)) as unknown[], context);
	return {
		faux,
		root,
		human,
		agents,
		turn,
		settle,
		job,
		held,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}
const AB = "結果：需要你\n選 A 還是 B？\n選項：\n1. A\n2. B";
const AB_NOTICE = "[問題] agent pick（卡片 pick）這一輪結束了：\n結果：需要你\n選 A 還是 B？";

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

test("a getUpdates answer of an unexpected shape is reported once per attempt, and the next poll's updates are handled", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	api.answering.set("getUpdates", [
		{ result: [] },
		{ ok: true, result: { update_id: 1 } },
		"<html>502 Bad Gateway</html>",
	]);
	const onError = vi.fn();
	const controller = new AbortController();
	const running = runTelegram({
		human,
		token: TOKEN,
		chatId: CHAT,
		apiBase,
		signal: controller.signal,
		retryMs: 10,
		onError,
	});
	cleanup.push(() => {
		controller.abort();
		return running;
	});

	const { message } = api.deliver("你好", CHAT);

	await vi.waitFor(() => expect(human.inputs.map((input) => input.content)).toEqual(["你好"]));
	expect(human.inputs[0]?.requestId).toBe(`telegram:${message.message_id}`);
	expect(onError.mock.calls.map(([error]) => (error as Error).message)).toEqual([
		"getUpdates: the response (200) has an unexpected shape: ok: Invalid discriminator value. Expected true | false",
		"getUpdates: the result has an unexpected shape: (root): Expected array, received object",
		expect.stringMatching(/^getUpdates: the response \(200\) is not JSON: /),
	]);
});

// 2026-11-19 08:59 in Taipei, when the outage of that day began.
const OUTAGE_START = Date.UTC(2026, 10, 19, 0, 59);

/**
 * The client on a clock the test moves, whose timers run when it passes them, with the outage alert `alert` and the
 * zone Asia/Taipei; each failed poll is reported to `onError` and polled again after 10 ms.
 */
async function outageWatch(alert = vi.fn(async (_text: string) => {})) {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	let at = OUTAGE_START;
	const timers = new Set<{ due: number; run: () => void }>();
	const onError = vi.fn();
	const controller = new AbortController();
	const running = runTelegram({
		human,
		token: TOKEN,
		chatId: CHAT,
		apiBase,
		signal: controller.signal,
		retryMs: 10,
		onError,
		alert,
		timeZone: "Asia/Taipei",
		now: () => at,
		setTimer: (run, ms) => {
			const timer = { due: at + ms, run };
			timers.add(timer);
			return () => timers.delete(timer);
		},
	});
	cleanup.push(() => {
		controller.abort();
		return running;
	});
	const advance = (ms: number) => {
		at += ms;
		for (const timer of [...timers])
			if (timer.due <= at) {
				timers.delete(timer);
				timer.run();
			}
	};
	// Polls that fail from now on, at least `count` of them.
	const failures = async (count: number) => {
		const seen = onError.mock.calls.length;
		await vi.waitFor(() => expect(onError.mock.calls.length).toBeGreaterThanOrEqual(seen + count));
	};
	// A message the next poll that succeeds brings, once the client has handled it.
	const succeeds = async (text: string) => {
		api.failing.delete("getUpdates");
		api.deliver(text, CHAT);
		await vi.waitFor(() => expect(human.inputs.map((input) => input.content)).toContain(text));
	};
	// A poll the fake holds open, as Telegram holds a long poll while no update comes.
	const held = async () => {
		api.stalling.add("getUpdates");
		await vi.waitFor(() => expect(api.holding).toBe(1));
	};
	const release = () => {
		api.stalling.delete("getUpdates");
		api.release();
	};
	return { human, api, alert, onError, advance, failures, succeeds, held, release };
}

test("polling that fails for 10 minutes alerts once, and not again while the outage lasts", async () => {
	const { api, alert, advance, failures } = await outageWatch();
	api.failing.add("getUpdates");

	await failures(3);
	advance(10 * MIN - 1);
	await failures(3);
	expect(alert).not.toHaveBeenCalled();
	advance(1);
	await vi.waitFor(() => expect(alert).toHaveBeenCalledOnce());
	expect(alert).toHaveBeenCalledWith(
		"Telegram 從 2026-11-19 08:59（Asia/Taipei）起一直連不上。soma 還在執行，會繼續重試，連上後會在 Telegram 告訴你斷了多久。",
	);

	await failures(3);
	advance(10 * MIN);
	await failures(3);
	advance(4 * 60 * MIN);
	expect(alert).toHaveBeenCalledOnce();
	expect(api.methods).not.toContain("sendRichMessage");
});

test("a single failed poll followed by a success sends nothing", async () => {
	const { api, alert, advance, failures, succeeds } = await outageWatch();
	api.answering.set("getUpdates", ["<html>502 Bad Gateway</html>"]);

	await failures(1);
	await succeeds("在嗎");
	advance(60 * MIN);

	expect(alert).not.toHaveBeenCalled();
	expect(api.sent).toEqual([]);
});

test("the first poll that succeeds after an outage that alerted tells the chat its start and end, once", async () => {
	const { api, alert, advance, failures, succeeds } = await outageWatch();
	api.failing.add("getUpdates");

	await failures(1);
	advance(10 * MIN);
	await vi.waitFor(() => expect(alert).toHaveBeenCalledOnce());
	advance(3 * 60 * MIN + 48 * MIN);
	// The second started on the moved clock, so the poll that succeeds does too.
	await failures(2);
	await succeeds("壞了嗎");
	await succeeds("又一則");

	expect(api.sent.map((message) => message.text)).toEqual([
		"[通知] Telegram 從 2026-11-19 08:59 到 2026-11-19 12:57（Asia/Taipei）連不上，共 3 小時 58 分鐘。",
	]);
});

test("an outage shorter than 10 minutes sends nothing on either channel when it ends", async () => {
	const { api, alert, advance, failures, succeeds } = await outageWatch();
	api.failing.add("getUpdates");

	await failures(3);
	advance(10 * MIN - 1);
	await succeeds("回來了");
	advance(60 * MIN);

	expect(alert).not.toHaveBeenCalled();
	expect(api.sent).toEqual([]);
});

test("a poll Telegram answers before the 10-minute mark and holds open past it ends the outage without an alert", async () => {
	const { api, alert, onError, advance, failures, succeeds, held, release } = await outageWatch();
	api.failing.add("getUpdates");

	await failures(3);
	advance(9 * MIN + 30_000);
	await held();
	api.failing.delete("getUpdates");
	const failed = onError.mock.calls.length;
	advance(30_000);
	expect(alert).not.toHaveBeenCalled();
	release();
	await succeeds("在嗎");
	advance(60 * MIN);

	expect(onError).toHaveBeenCalledTimes(failed);
	expect(alert).not.toHaveBeenCalled();
	expect(api.sent).toEqual([]);
});

test("a poll open at the 10-minute mark that then fails alerts at its failure, and a poll that succeeds ends the outage when it was sent", async () => {
	const { api, alert, advance, failures, succeeds, held, release } = await outageWatch();
	api.failing.add("getUpdates");

	await failures(3);
	await held();
	advance(10 * MIN);
	expect(alert).not.toHaveBeenCalled();
	release();
	await vi.waitFor(() => expect(alert).toHaveBeenCalledOnce());
	await held();
	api.failing.delete("getUpdates");
	advance(5 * MIN);
	release();
	await succeeds("好了");

	// Telegram answered the held poll when it was sent, five minutes before it returned.
	expect(api.sent.map((message) => message.text)).toEqual([
		"[通知] Telegram 從 2026-11-19 08:59 到 2026-11-19 09:09（Asia/Taipei）連不上，共 10 分鐘。",
	]);
});

test("a notification that fails is reported, and the polling goes on", async () => {
	const refused = new Error("osascript: not allowed to send notifications");
	const { api, onError, advance, failures, succeeds } = await outageWatch(
		vi.fn(async (_text: string) => {
			throw refused;
		}),
	);
	api.failing.add("getUpdates");

	await failures(1);
	advance(10 * MIN);
	await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(refused));
	await succeeds("還在嗎");
});

test("a getUpdates result that is not a list counts as a failed poll", async () => {
	const { api, alert, onError, advance, failures } = await outageWatch();
	api.answering.set(
		"getUpdates",
		Array.from({ length: 2_000 }, () => ({ ok: true, result: {} })),
	);

	await failures(3);
	advance(10 * MIN);
	await vi.waitFor(() => expect(alert).toHaveBeenCalledOnce());
	expect(onError).toHaveBeenCalledWith(
		expect.objectContaining({
			message: "getUpdates: the result has an unexpected shape: (root): Expected array, received object",
		}),
	);
});

test("an update that does not parse is reported and skipped, the rest of its batch is handled, and it is not asked for again", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	const { onError } = start(human, apiBase);

	const bad = api.deliverRaw({ message: { message_id: "7", chat: { id: CHAT }, text: "壞的" } });
	const good = api.deliver("好的", CHAT);

	await vi.waitFor(() => expect(human.inputs.map((input) => input.content)).toEqual(["好的"]));
	expect(human.inputs[0]?.requestId).toBe(`telegram:${good.message.message_id}`);
	expect(api.batches.filter((ids) => ids.includes(bad.update_id))).toEqual([[bad.update_id, good.update_id]]);
	expect(onError).toHaveBeenCalledOnce();
	expect(onError).toHaveBeenCalledWith(
		expect.objectContaining({
			message: `getUpdates: update ${bad.update_id} skipped, unexpected shape: message.message_id: Expected number, received string`,
		}),
	);
});

test("an update that does not parse, last in its batch, is confirmed by the next poll and not asked for again", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	const { onError } = start(human, apiBase);

	const bad = api.deliverRaw({ stopped_message_generation: { chat: { id: CHAT }, draft_id: "not a number" } });
	await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
	api.deliver("之後", CHAT);

	await vi.waitFor(() => expect(human.inputs.map((input) => input.content)).toEqual(["之後"]));
	expect(api.batches.filter((ids) => ids.includes(bad.update_id))).toEqual([[bad.update_id]]);
	expect(onError).toHaveBeenCalledOnce();
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

test("a press whose label may have reached a job's agent in part settles as unknown, and shows no draft", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);
	const options = [
		{ id: "1", label: "A" },
		{ id: "2", label: "B" },
	];

	human.saidOutcome = { said: false, refusal: "unsure", label: "A" };
	human.emit({
		type: "notice",
		kind: "question",
		class: "action",
		content: "選 A 還是 B？",
		choices: { question: "abc", options, job: "pick" },
	});
	await vi.waitFor(() => expect(api.sent).toHaveLength(1));
	api.press("ask/abc/1", CHAT);
	await vi.waitFor(() => expect(api.calls).toHaveLength(2));
	const unknown = "不確定有沒有送出：出錯了，請到 agent 的畫面確認";
	expect(api.calls.map(({ params }) => params.text ?? params.reply_markup)).toEqual([unknown, chosen(unknown)]);
	expect(api.drafts).toEqual([]);
});

test("a press the agent side refused keeps its buttons and says why; a later press on them goes through", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	start(human, apiBase);
	const options = [
		{ id: "1", label: "A" },
		{ id: "2", label: "B" },
	];
	const choices = { question: "abc", options, job: "pick" };

	human.saidOutcome = { said: false, refusal: "unsent", reason: "acp agent pick is dormant: hangar is full" };
	human.emit({ type: "notice", kind: "question", class: "action", content: "選 A 還是 B？", choices });
	await vi.waitFor(() => expect(api.sent).toHaveLength(1));
	const first = api.press("ask/abc/1", CHAT);
	await vi.waitFor(() => expect(api.calls).toHaveLength(1));
	expect(api.calls).toEqual([
		{
			method: "answerCallbackQuery",
			params: {
				callback_query_id: first.callback_query.id,
				text: "未送出：acp agent pick is dormant: hangar is full，可以再按一次",
			},
		},
	]);

	// A reason too long for the callback's text is cut, and the text still says the press may be made again.
	human.saidOutcome = { said: false, refusal: "unsent", reason: "x".repeat(300) };
	api.press("ask/abc/1", CHAT);
	await vi.waitFor(() => expect(api.calls).toHaveLength(2));
	const cut = String(api.calls[1]?.params.text);
	expect([...cut]).toHaveLength(200);
	expect(cut).toMatch(/^未送出：x+…，可以再按一次$/);

	// One the agent side gives no reason for says so in general words.
	human.saidOutcome = { said: false, refusal: "unsent", reason: " " };
	api.press("ask/abc/1", CHAT);
	await vi.waitFor(() => expect(api.calls).toHaveLength(3));
	expect(api.calls[2]?.params.text).toBe("未送出：出錯了，可以再按一次");

	human.saidOutcome = { said: true, label: "B", job: "pick" };
	api.press("ask/abc/2", CHAT);
	await vi.waitFor(() => expect(api.calls).toHaveLength(5));
	expect(api.calls.slice(3).map(({ params }) => params.text ?? params.reply_markup)).toEqual([
		"已選：B",
		chosen("已選：B"),
	]);
	expect(human.said.map(({ option }) => option)).toEqual(["1", "1", "1", "2"]);
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

test("a job's 需要你 reply listing options arrives with their buttons; a press prompts its agent, and no round runs", async () => {
	const { faux, human, agents, turn, job } = await jobCore();
	const { api, apiBase } = await bot();
	start(human, apiBase);

	await turn(AB);
	await vi.waitFor(() => expect(api.sent).toHaveLength(1));
	const question = questionOf(api.sent[0]);
	expect(api.sent).toEqual([
		{
			chat_id: CHAT,
			text: AB_NOTICE,
			rich: true,
			reply_markup: {
				inline_keyboard: [
					[{ text: "A", callback_data: `ask/${question}/1` }],
					[{ text: "B", callback_data: `ask/${question}/2` }],
				],
			},
		},
	]);

	const press = api.press(`ask/${question}/2`, CHAT);
	await vi.waitFor(() => expect(api.calls).toHaveLength(2));
	expect(agents.prompts).toEqual([{ agent: "pick", text: "B" }]);
	const messageId = press.callback_query.message.message_id;
	expect(api.calls).toEqual([
		{ method: "answerCallbackQuery", params: { callback_query_id: press.callback_query.id, text: "已選：B" } },
		{
			method: "editMessageReplyMarkup",
			params: { chat_id: CHAT, message_id: messageId, reply_markup: chosen("已選：B") },
		},
	]);
	expect((await job())?.decisions).toEqual([
		{ at: expect.any(String), kind: "question", action: "replied", text: "B", reason: HUMAN_CHOSEN },
	]);

	// A press from a client that still shows the buttons, here on a message the chat never settled, sends nothing more.
	const again = api.press(`ask/${question}/1`, CHAT, messageId + 100);
	await vi.waitFor(() => expect(api.calls).toHaveLength(4));
	expect(api.calls[2]).toEqual({
		method: "answerCallbackQuery",
		params: { callback_query_id: again.callback_query.id, text: "已選：B" },
	});
	await pause();
	expect(agents.prompts).toHaveLength(1);
	expect(faux.state.callCount).toBe(0);
	expect(api.drafts).toEqual([]);
});

test("a press on a job's question it no longer waits on sends nothing and says so in the chat", async () => {
	const { human, agents, turn, settle } = await jobCore();
	const { api, apiBase } = await bot();
	start(human, apiBase);
	const refused = chosen("未送出：agent 已經不在等這個回答");

	await turn(AB);
	await vi.waitFor(() => expect(api.sent).toHaveLength(1));
	// Prompted some other way: the human typed into its window, and it works on that.
	agents.emit("pick", { state: "working" });
	await settle();
	api.press(`ask/${questionOf(api.sent[0])}/1`, CHAT);
	await vi.waitFor(() => expect(api.calls).toHaveLength(2));
	expect(api.calls.map(({ params }) => params.text ?? params.reply_markup)).toEqual([
		"未送出：agent 已經不在等這個回答",
		refused,
	]);

	// Asked again, and the job ends before the press.
	await turn(AB);
	await vi.waitFor(() => expect(api.sent).toHaveLength(2));
	agents.emit("pick", { state: "error" });
	await settle();
	api.press(`ask/${questionOf(api.sent[1])}/2`, CHAT);
	await vi.waitFor(() => expect(api.calls).toHaveLength(4));
	expect(api.calls.at(-1)?.params.reply_markup).toEqual(refused);
	expect(agents.prompts).toEqual([]);
});

test("at summary, a job's question with options is held, then offered again with its buttons after the summary", async () => {
	const { faux, human, agents, turn, held, advance } = await jobCore({ summary: true });
	faux.setResponses([fauxAssistantMessage("摘要：pick 在問你選 A 還是 B。"), fauxAssistantMessage("不該有第二輪")]);
	const { api, apiBase } = await bot();
	start(human, apiBase);

	await turn(AB);
	await vi.waitFor(async () => expect(await held()).toHaveLength(1));
	await pause();
	expect(api.sent).toEqual([]);

	advance(31 * MIN);
	await vi.waitFor(() => expect(api.sent).toHaveLength(2));
	const question = questionOf(api.sent[1]);
	expect(api.sent).toEqual([
		{ chat_id: CHAT, text: "[通知] 摘要：pick 在問你選 A 還是 B。", rich: true },
		{
			chat_id: CHAT,
			text: AB_NOTICE,
			rich: true,
			disable_notification: true,
			reply_markup: {
				inline_keyboard: [
					[{ text: "A", callback_data: `ask/${question}/1` }],
					[{ text: "B", callback_data: `ask/${question}/2` }],
				],
			},
		},
	]);
	expect(await held()).toEqual([]);

	api.press(`ask/${question}/1`, CHAT);
	await vi.waitFor(() => expect(api.calls.at(-1)?.params.reply_markup).toEqual(chosen("已選：A")));
	expect(agents.prompts).toEqual([{ agent: "pick", text: "A" }]);
	expect(faux.state.callCount).toBe(1);
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
	// No Thinking draft follows the answer; one still in flight when the answer came was aborted.
	const drafts = api.drafts.length;
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
	// The buttons go on the last part only, so once a part carrying them is sent, every part is.
	await vi.waitFor(() => expect(api.sent.at(-1)?.reply_markup).toBeDefined());
	expect(api.sent.length).toBeGreaterThan(3);
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

// The draft refreshed every few milliseconds, with no least time between two calls, so a test sees several refreshes
// of an open round.
function drafting(human: HumanPort, apiBase: string, limit: { draftLimitMs?: number } = {}) {
	const onError = vi.fn();
	const controller = new AbortController();
	const options = { human, token: TOKEN, chatId: CHAT, apiBase, signal: controller.signal, onError };
	const running = runTelegram({ ...options, draftRefreshMs: 20, draftIntervalMs: 0, ...limit });
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
	await vi.waitFor(() =>
		expect(api.drafts).toEqual([{ chat_id: CHAT, draft_id: message.message_id, text: "", can_stop: true }]),
	);
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
	const { stepped, human } = await streamingCore();
	const replies = [stepped.reply(), stepped.reply()];
	const { api, apiBase } = await bot();
	api.failing.add("sendMessageDraft");
	const { onError } = start(human, apiBase);
	const refused = expect.objectContaining({ message: expect.stringContaining("sendMessageDraft") });

	// Each round answers once its placeholder was refused: a draft call still in flight at the answer is ignored.
	for (const [index, reply] of replies.entries()) {
		const text = `${index + 1}。`;
		api.deliver(String(index + 1), CHAT);
		await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(index + 1));
		expect(onError).toHaveBeenLastCalledWith(refused);
		await reply.write(text);
		await reply.end();
		await vi.waitFor(() => expect(api.sent.map((message) => message.text)).toContain(text));
	}

	expect(api.sent.map((message) => message.text)).toEqual(["1。", "2。"]);
	await vi.waitFor(() => expect(api.reactions.map(({ emoji }) => emoji)).toEqual(["👀", "👍", "👀", "👍"]));
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

/** A clock the test moves; a timer set on it runs once the clock passes its time. */
function manualClock() {
	let at = 0;
	const timers = new Set<{ at: number; run: () => void }>();
	return {
		now: () => at,
		setTimer: (run: () => void, ms: number) => {
			const timer = { at: at + ms, run };
			timers.add(timer);
			return () => void timers.delete(timer);
		},
		advance(ms: number) {
			at += ms;
			for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
				if (timer.at > at) continue;
				timers.delete(timer);
				timer.run();
			}
		},
	};
}

/** A core whose model writes its answers when the test says; every event the HumanPort emits is kept in `seen`. */
async function streamingCore(registry = createRegistry()) {
	const stepped = steppedModel();
	const harness = await Harness.open(new MemoryStorage(), { models: stepped.models, registry }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: stepped.model } });
	harness.resume();
	const human = await openHumanPort(harness, root, new FakeAgentPort(), context);
	cleanup.push(() => human.close());
	const seen: SomaEvent[] = [];
	human.subscribe((event) => seen.push(event));
	return { stepped, root, human, seen };
}

/** Telegram over `human` with its drafts timed by `clock`; the refresh keeps its 20 s unless `draftRefreshMs` says. */
function streaming(human: HumanPort, apiBase: string, clock: ReturnType<typeof manualClock>, draftRefreshMs?: number) {
	const onError = vi.fn();
	const controller = new AbortController();
	const running = runTelegram({
		human,
		token: TOKEN,
		chatId: CHAT,
		apiBase,
		signal: controller.signal,
		onError,
		now: clock.now,
		setTimer: clock.setTimer,
		...(draftRefreshMs !== undefined && { draftRefreshMs }),
	});
	cleanup.push(() => {
		controller.abort();
		return running;
	});
	return { onError };
}

/** Waits until the HumanPort has emitted `content` as the partial of the round of message `messageId`. */
const partialOf = (seen: SomaEvent[], messageId: number, content: string) =>
	vi.waitFor(() => expect(seen).toContainEqual({ type: "partial", requestIds: [`telegram:${messageId}`], content }));

const draftCalls = (api: FakeBotApi) =>
	api.methods.filter((method) => /Draft$|^sendRichMessage$|^sendMessage$/.test(method));

test("a round from the chat shows its growing answer as its draft, at most once a second, then the answer as today", async () => {
	const { stepped, root, human, seen } = await streamingCore();
	const reply = stepped.reply();
	const { api, apiBase } = await bot();
	const clock = manualClock();
	const { onError } = streaming(human, apiBase, clock);

	const { message } = api.deliver("寫長一點", CHAT);
	const id = message.message_id;
	const placeholder = { chat_id: CHAT, draft_id: id, text: "", can_stop: true };
	const draft = (text: string) => ({ chat_id: CHAT, draft_id: id, text, rich: true, can_stop: true });
	await vi.waitFor(() => expect(api.drafts).toEqual([placeholder]));

	// Within the second since the placeholder, each text waits, and only the newest goes once the second has passed.
	await reply.write("## 標題\n\n第一");
	await partialOf(seen, id, "## 標題\n\n第一");
	await reply.write("段");
	await partialOf(seen, id, "## 標題\n\n第一段");
	clock.advance(999);
	await settle();
	expect(api.drafts).toEqual([placeholder]);
	clock.advance(1);
	await vi.waitFor(() => expect(api.drafts).toEqual([placeholder, draft("## 標題\n\n第一段")]));

	await reply.write("，**第二段**");
	await partialOf(seen, id, "## 標題\n\n第一段，**第二段**");
	clock.advance(500);
	await settle();
	expect(api.drafts).toHaveLength(2);
	clock.advance(500);
	await vi.waitFor(() => expect(api.drafts.at(-1)).toEqual(draft("## 標題\n\n第一段，**第二段**")));

	await reply.end();
	await root.waitForIdle(context);
	await vi.waitFor(() =>
		expect(api.sent).toEqual([{ chat_id: CHAT, text: "## 標題\n\n第一段，**第二段**", rich: true }]),
	);
	await vi.waitFor(() => expect(api.reactions.map(({ emoji }) => emoji)).toEqual(["👀", "👍"]));
	clock.advance(5_000);
	await settle();
	expect(draftCalls(api)).toEqual([
		"sendMessageDraft",
		"sendRichMessageDraft",
		"sendRichMessageDraft",
		"sendRichMessage",
	]);
	expect(onError).not.toHaveBeenCalled();
});

test("a text still waiting for its second when the answer comes is never sent, and no draft follows the answer", async () => {
	const { stepped, root, human, seen } = await streamingCore();
	const reply = stepped.reply();
	const { api, apiBase } = await bot();
	const clock = manualClock();
	streaming(human, apiBase, clock);

	const { message } = api.deliver("一", CHAT);
	await vi.waitFor(() => expect(api.drafts).toHaveLength(1));
	await reply.write("快寫完");
	await partialOf(seen, message.message_id, "快寫完");
	await reply.end();
	await root.waitForIdle(context);
	await vi.waitFor(() => expect(api.sent.map(({ text }) => text)).toEqual(["快寫完"]));

	clock.advance(5_000);
	await settle();
	expect(draftCalls(api)).toEqual(["sendMessageDraft", "sendRichMessage"]);
});

test("three text drafts refused in a row stop the round's text drafts, the placeholder goes on, and the answer still arrives", async () => {
	const { stepped, root, human, seen } = await streamingCore();
	const reply = stepped.reply();
	const { api, apiBase } = await bot();
	api.failing.add("sendRichMessageDraft");
	const clock = manualClock();
	const { onError } = streaming(human, apiBase, clock, 20);
	const richCalls = () => api.methods.filter((method) => method === "sendRichMessageDraft").length;

	const { message } = api.deliver("一", CHAT);
	const id = message.message_id;
	await vi.waitFor(() => expect(api.drafts).toHaveLength(1));
	let written = "";
	for (const [index, text] of ["第一段", "，第二段", "，第三段"].entries()) {
		written += text;
		await reply.write(text);
		await partialOf(seen, id, written);
		clock.advance(1_000);
		await vi.waitFor(() => expect(richCalls()).toBe(index + 1));
		await settle();
	}
	expect(onError).toHaveBeenCalledTimes(1);
	expect(onError).toHaveBeenCalledWith(
		expect.objectContaining({ message: expect.stringContaining("sendRichMessageDraft") }),
	);

	await reply.write("，第四段");
	await partialOf(seen, id, `${written}，第四段`);
	clock.advance(1_000);
	await vi.waitFor(() => expect(api.drafts).toHaveLength(2));
	clock.advance(1_000);
	await vi.waitFor(() => expect(api.drafts).toHaveLength(3));
	expect(api.drafts.every(({ text, rich }) => text === "" && rich === undefined)).toBe(true);
	expect(richCalls()).toBe(3);

	await reply.end();
	await root.waitForIdle(context);
	await vi.waitFor(() =>
		expect(api.sent).toEqual([{ chat_id: CHAT, text: "第一段，第二段，第三段，第四段", rich: true }]),
	);
	await vi.waitFor(() => expect(api.reactions.map(({ emoji }) => emoji)).toEqual(["👀", "👍"]));
	expect(onError).toHaveBeenCalledTimes(1);
});

test("a text longer than a draft takes is not sent, and the draft keeps the last text that fit", async () => {
	const { stepped, root, human, seen } = await streamingCore();
	const reply = stepped.reply();
	const { api, apiBase } = await bot();
	const clock = manualClock();
	const { onError } = streaming(human, apiBase, clock, 20);

	const { message } = api.deliver("一", CHAT);
	const id = message.message_id;
	await vi.waitFor(() => expect(api.drafts).toHaveLength(1));
	await reply.write("短");
	await partialOf(seen, id, "短");
	clock.advance(1_000);
	await vi.waitFor(() =>
		expect(api.drafts.at(-1)).toEqual({ chat_id: CHAT, draft_id: id, text: "短", rich: true, can_stop: true }),
	);

	// 11,000 characters of three bytes each: past 32768 bytes, the most one rich message takes.
	const long = `短${"字".repeat(11_000)}`;
	await reply.write("字".repeat(11_000));
	await partialOf(seen, id, long);
	// The refresh sends the draft again, with the text that fit.
	clock.advance(1_000);
	await vi.waitFor(() => expect(api.drafts).toHaveLength(3));
	expect(api.drafts.slice(1)).toEqual(
		[1, 2].map(() => ({ chat_id: CHAT, draft_id: id, text: "短", rich: true, can_stop: true })),
	);
	expect(onError).not.toHaveBeenCalled();

	// The answer goes as today: too long for one rich message, in parts.
	await reply.end();
	await root.waitForIdle(context);
	await vi.waitFor(() => expect(api.sent.map(({ text }) => text).join("")).toBe(long));
	expect(api.sent.length).toBeGreaterThan(1);
	expect(api.sent.every(({ rich }) => rich === undefined)).toBe(true);
});

test("a draft flood control refuses waits its retry_after, then shows the newest text", async () => {
	const { stepped, root, human, seen } = await streamingCore();
	const reply = stepped.reply();
	const { api, apiBase } = await bot();
	api.flooding.set("sendRichMessageDraft", [3]);
	const clock = manualClock();
	const { onError } = streaming(human, apiBase, clock);

	const { message } = api.deliver("一", CHAT);
	const id = message.message_id;
	await vi.waitFor(() => expect(api.drafts).toHaveLength(1));
	await reply.write("一");
	await partialOf(seen, id, "一");
	clock.advance(1_000);
	await vi.waitFor(() =>
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("retry after 3") }),
		),
	);
	await reply.write("二");
	await partialOf(seen, id, "一二");
	clock.advance(2_999);
	await settle();
	expect(api.methods.filter((method) => method === "sendRichMessageDraft")).toHaveLength(1);
	clock.advance(1);
	await vi.waitFor(() =>
		expect(api.drafts.at(-1)).toEqual({ chat_id: CHAT, draft_id: id, text: "一二", rich: true, can_stop: true }),
	);

	await reply.end();
	await root.waitForIdle(context);
	await vi.waitFor(() => expect(api.sent.map(({ text }) => text)).toEqual(["一二"]));
});

test("a partial of a round from elsewhere, or of one the chat has no draft for, sends no draft", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	const clock = manualClock();
	const { onError } = streaming(human, apiBase, clock);

	human.emit({ type: "partial", requestIds: ["terminal:1"], content: "別處" });
	human.emit({ type: "partial", requestIds: ["telegram:99"], content: "重啟前" });
	clock.advance(5_000);
	await settle();
	expect(api.drafts).toEqual([]);
	expect(api.methods).toEqual([]);
	expect(onError).not.toHaveBeenCalled();
});

/** Telegram over a fake HumanPort with drafts timed by `clock`, once a message from the chat shows its placeholder. */
async function fakeStreaming(clock = manualClock(), draftRefreshMs?: number) {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	const { onError } = streaming(human, apiBase, clock, draftRefreshMs);
	const { message } = api.deliver("一", CHAT);
	const id = message.message_id;
	await vi.waitFor(() => expect(api.drafts).toEqual([{ chat_id: CHAT, draft_id: id, text: "", can_stop: true }]));
	const partial = (content: string) => human.emit({ type: "partial", requestIds: [`telegram:${id}`], content });
	const answer = (content: string) => human.emit({ type: "answer", requestId: `telegram:${id}`, content });
	const draft = (text: string) => ({ chat_id: CHAT, draft_id: id, text, rich: true, can_stop: true });
	const calls = (method: string) => api.methods.filter((each) => each === method).length;
	return { human, api, clock, onError, id, partial, answer, draft, calls };
}

test("a round's draft call waits for the one in flight, and the newest text goes once it ends", async () => {
	const { api, clock, onError, id, partial, draft, calls } = await fakeStreaming();
	api.stalling.add("sendRichMessageDraft");

	partial("一");
	clock.advance(1_000);
	await vi.waitFor(() => expect(calls("sendRichMessageDraft")).toBe(1));
	partial("一二");
	partial("一二三");
	clock.advance(5_000);
	await settle();
	expect(calls("sendRichMessageDraft")).toBe(1);

	api.stalling.delete("sendRichMessageDraft");
	api.release();
	await vi.waitFor(() =>
		expect(api.drafts).toEqual([
			{ chat_id: CHAT, draft_id: id, text: "", can_stop: true },
			draft("一"),
			draft("一二三"),
		]),
	);
	expect(calls("sendRichMessageDraft")).toBe(2);
	expect(onError).not.toHaveBeenCalled();
});

test("a draft call in flight when the answer comes is aborted and ignored, and the answer does not wait for it", async () => {
	const { api, clock, onError, partial, answer, calls } = await fakeStreaming();
	api.stalling.add("sendRichMessageDraft");

	partial("快寫完");
	clock.advance(1_000);
	await vi.waitFor(() => expect(calls("sendRichMessageDraft")).toBe(1));
	answer("快寫完了");
	await vi.waitFor(() => expect(api.sent).toEqual([{ chat_id: CHAT, text: "快寫完了", rich: true }]));
	await vi.waitFor(() => expect(api.aborted).toEqual(["sendRichMessageDraft"]));

	api.release();
	clock.advance(30_000);
	await settle();
	expect(api.drafts).toHaveLength(1);
	expect(draftCalls(api)).toEqual(["sendMessageDraft", "sendRichMessageDraft", "sendRichMessage"]);
	expect(onError).not.toHaveBeenCalled();
});

test("a text that is only whitespace shows the placeholder, as empty text does", async () => {
	const { api, clock, onError, id, partial, draft } = await fakeStreaming();
	const placeholder = { chat_id: CHAT, draft_id: id, text: "", can_stop: true };

	partial("一");
	clock.advance(1_000);
	await vi.waitFor(() => expect(api.drafts).toEqual([placeholder, draft("一")]));
	// As after a tool call, when the next generation has written only a line break so far.
	partial(" \n\n");
	clock.advance(1_000);
	await vi.waitFor(() => expect(api.drafts).toEqual([placeholder, draft("一"), placeholder]));
	expect(onError).not.toHaveBeenCalled();
});

test("a refused text draft is reported once a round and skipped, and a draft taken starts the count of refusals over", async () => {
	const { api, clock, onError, id, partial, draft, calls } = await fakeStreaming(manualClock(), 20);
	const placeholder = { chat_id: CHAT, draft_id: id, text: "", can_stop: true };
	// Each text goes a second after the one before, once the refresh has asked for it too.
	const next = async (text: string) => {
		const before = calls("sendRichMessageDraft");
		partial(text);
		clock.advance(1_000);
		await vi.waitFor(() => expect(calls("sendRichMessageDraft")).toBe(before + 1));
		await settle();
	};

	api.refusing.set("sendRichMessageDraft", 2);
	await next("一");
	await next("一二");
	await next("一二三");
	expect(api.drafts).toEqual([placeholder, draft("一二三")]);
	// Two refusals, a draft taken, two more: never three in a row, so text drafts go on.
	api.refusing.set("sendRichMessageDraft", 2);
	await next("一二三四");
	await next("一二三四五");
	await next("一二三四五六");
	expect(api.drafts).toEqual([placeholder, draft("一二三"), draft("一二三四五六")]);

	// A refused text is not shown again: the refresh sends what the draft showed.
	api.refusing.set("sendRichMessageDraft", 1);
	await next("一二三四五六七");
	clock.advance(1_000);
	await vi.waitFor(() => expect(api.drafts).toHaveLength(4));
	expect(api.drafts.at(-1)).toEqual(draft("一二三四五六"));
	expect(onError).toHaveBeenCalledTimes(1);
	expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("can't parse") }));
});

/** Telegram over a fake HumanPort on a clock the test moves, with what a 429 of `sendRichMessage` should answer. */
async function flooded(retryAfters: number[]) {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	api.flooding.set("sendRichMessage", retryAfters);
	const clock = manualClock();
	const { onError } = streaming(human, apiBase, clock);
	const answer = (requestId: string, content: string) => human.emit({ type: "answer", requestId, content });
	const floodedFor = (seconds: number) =>
		vi.waitFor(() =>
			expect(onError).toHaveBeenLastCalledWith(
				expect.objectContaining({ message: expect.stringContaining(`retry after ${seconds}`) }),
			),
		);
	return { api, clock, onError, answer, floodedFor };
}

test("an answer flood control refuses waits each retry_after and goes again, and the messages after it wait their turn", async () => {
	const { api, clock, onError, answer, floodedFor } = await flooded([3, 5]);

	answer("telegram:1", "答案");
	answer("telegram:2", "下一則");
	await floodedFor(3);
	clock.advance(2_999);
	await settle();
	expect(api.sent).toEqual([]);
	clock.advance(1);
	await floodedFor(5);
	clock.advance(4_999);
	await settle();
	expect(api.sent).toEqual([]);
	clock.advance(1);
	await vi.waitFor(() =>
		expect(api.sent).toEqual([
			{ chat_id: CHAT, text: "答案", rich: true },
			{ chat_id: CHAT, text: "下一則", rich: true },
		]),
	);
	expect(onError).toHaveBeenCalledTimes(2);
});

test("an answer flood control refuses a third time goes by the HTML path at once", async () => {
	const { api, clock, onError, answer, floodedFor } = await flooded([1, 1, 1]);

	answer("telegram:1", "答案");
	await floodedFor(1);
	clock.advance(1_000);
	await vi.waitFor(() => expect(api.methods.filter((method) => method === "sendRichMessage")).toHaveLength(2));
	clock.advance(1_000);
	await vi.waitFor(() => expect(api.sent).toEqual([{ chat_id: CHAT, text: "答案", parse_mode: "HTML" }]));
	expect(api.methods.filter((method) => method === "sendRichMessage")).toHaveLength(3);
	expect(onError).toHaveBeenCalledTimes(3);
});

test("an answer whose waits for flood control would pass a minute in all goes by the HTML path at once", async () => {
	const { api, clock, answer, floodedFor } = await flooded([40, 30, 61]);

	answer("telegram:1", "一");
	await floodedFor(40);
	clock.advance(40_000);
	// 40 s and 30 s more would pass the minute: no wait.
	await vi.waitFor(() => expect(api.sent).toEqual([{ chat_id: CHAT, text: "一", parse_mode: "HTML" }]));

	// One retry_after past the minute alone gets no wait either.
	answer("telegram:2", "二");
	await vi.waitFor(() => expect(api.sent.map(({ text }) => text)).toEqual(["一", "二"]));
	expect(api.sent[1]).toEqual({ chat_id: CHAT, text: "二", parse_mode: "HTML" });
});

test("a draft flood control asks to wait past a minute waits a minute, and the round's text drafts stop", async () => {
	const { api, clock, onError, id, partial, calls } = await fakeStreaming();
	const placeholder = { chat_id: CHAT, draft_id: id, text: "", can_stop: true };
	api.flooding.set("sendRichMessageDraft", [100_000]);

	partial("一");
	clock.advance(1_000);
	await vi.waitFor(() =>
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("retry after 100000") }),
		),
	);
	partial("一二");
	clock.advance(59_999);
	await settle();
	expect(api.drafts).toEqual([placeholder]);
	clock.advance(1);
	await vi.waitFor(() => expect(api.drafts).toEqual([placeholder, placeholder]));
	partial("一二三");
	clock.advance(5_000);
	await settle();
	expect(calls("sendRichMessageDraft")).toBe(1);
	expect(onError).toHaveBeenCalledTimes(1);
});

test("the fake Bot API refuses a rich draft with empty markdown, as it refuses such a message", async () => {
	const { api, apiBase } = await bot();
	const post = (method: string, body: object) =>
		fetch(`${apiBase}/bot${TOKEN}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}).then((response) => response.json());

	const empty = { chat_id: CHAT, draft_id: 1, rich_message: { markdown: "" } };
	expect(await post("sendRichMessageDraft", empty)).toMatchObject({ ok: false, error_code: 400 });
	expect(await post("sendRichMessage", { chat_id: CHAT, rich_message: { markdown: "" } })).toMatchObject({ ok: false });
	expect(await post("sendRichMessageDraft", { ...empty, rich_message: { markdown: "一" } })).toEqual({
		ok: true,
		result: true,
	});
	expect(api.drafts).toEqual([{ chat_id: CHAT, draft_id: 1, text: "一", rich: true }]);
});

test("a stop pressed on the draft while soma writes ends the round: the reaction becomes 🫡, and no message and no draft follow", async () => {
	const { stepped, root, human, seen } = await streamingCore();
	const reply = stepped.reply();
	const { api, apiBase } = await bot();
	const clock = manualClock();
	const { onError } = streaming(human, apiBase, clock);

	const { message } = api.deliver("寫長一點", CHAT);
	const id = message.message_id;
	await vi.waitFor(() => expect(api.drafts).toEqual([{ chat_id: CHAT, draft_id: id, text: "", can_stop: true }]));
	await reply.write("寫到一半");
	await partialOf(seen, id, "寫到一半");
	clock.advance(1_000);
	await vi.waitFor(() =>
		expect(api.drafts.at(-1)).toEqual({ chat_id: CHAT, draft_id: id, text: "寫到一半", rich: true, can_stop: true }),
	);

	api.stopGeneration(id, CHAT);
	await vi.waitFor(() => expect(seen).toContainEqual({ type: "stopped", requestId: `telegram:${id}` }));
	await root.waitForIdle(context);
	await vi.waitFor(() => expect(api.reactions.map(({ emoji }) => emoji)).toEqual(["👀", "🫡"]));
	// Past the refresh: the round's draft is over, and nothing was sent in its place.
	clock.advance(30_000);
	await settle();
	expect(draftCalls(api)).toEqual(["sendMessageDraft", "sendRichMessageDraft"]);
	expect(api.sent).toEqual([]);
	expect(onError).not.toHaveBeenCalled();
});

test("no draft goes while a stop press is asked of the core, and the draft goes on when the press stopped nothing", async () => {
	const human = new FakeHumanPort();
	let answer = (_took: boolean) => {};
	vi.spyOn(human, "stop").mockImplementation(
		() =>
			new Promise<boolean>((resolve) => {
				answer = resolve;
			}),
	);
	const { api, apiBase } = await bot();
	const clock = manualClock();
	const { onError } = streaming(human, apiBase, clock);

	const { message } = api.deliver("寫長一點", CHAT);
	const id = message.message_id;
	const requestIds = [`telegram:${id}`];
	await vi.waitFor(() => expect(api.drafts).toHaveLength(1));
	api.stopGeneration(id, CHAT);
	await vi.waitFor(() => expect(human.stop).toHaveBeenCalledWith(`telegram:${id}`));

	human.emit({ type: "partial", requestIds, content: "按下之後才寫的" });
	clock.advance(30_000);
	await settle();
	expect(api.drafts).toHaveLength(1);

	answer(false);
	await vi.waitFor(() => expect(api.drafts.at(-1)).toMatchObject({ text: "按下之後才寫的", can_stop: true }));
	expect(onError).not.toHaveBeenCalled();
});

test("a stop from another chat, or pressed after the answer, does nothing", async () => {
	const { stepped, root, human, seen } = await streamingCore();
	// The second round's reply is never written: it runs until the test ends.
	const [reply] = [stepped.reply(), stepped.reply()];
	const { api, apiBase } = await bot();
	const clock = manualClock();
	const { onError } = streaming(human, apiBase, clock);

	const { message } = api.deliver("一", CHAT);
	const id = message.message_id;
	await vi.waitFor(() => expect(api.drafts).toHaveLength(1));
	await reply.write("一的");
	await partialOf(seen, id, "一的");
	api.stopGeneration(id, 7);
	await vi.waitFor(() => expect(api.methods.length).toBeGreaterThan(0));
	await settle();
	expect(seen.some((event) => event.type === "stopped")).toBe(false);
	// The round goes on, its draft with it.
	clock.advance(1_000);
	await vi.waitFor(() => expect(api.drafts.at(-1)).toMatchObject({ text: "一的", can_stop: true }));

	await reply.end();
	await root.waitForIdle(context);
	await vi.waitFor(() => expect(api.sent.map(({ text }) => text)).toEqual(["一的"]));
	await vi.waitFor(() => expect(api.reactions.map(({ emoji }) => emoji)).toEqual(["👀", "👍"]));
	const calls = api.methods.length;
	api.stopGeneration(id, CHAT);
	// The next message is taken, so the press before it was too.
	api.deliver("二", CHAT);
	await vi.waitFor(() => expect(api.reactions).toHaveLength(3));
	await settle();
	expect(seen.some((event) => event.type === "stopped")).toBe(false);
	expect(api.methods.slice(calls).sort()).toEqual(["sendMessageDraft", "setMessageReaction"]);
	expect(api.sent.map(({ text }) => text)).toEqual(["一的"]);
	expect(onError).not.toHaveBeenCalled();
});

test("a stop pressed while a tool runs shows no draft again while the tool finishes, then the round ends as stopped", async () => {
	let started = () => {};
	const running = new Promise<void>((resolve) => {
		started = resolve;
	});
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const registry = createRegistry();
	const slow = defineTool({
		name: "slow",
		description: "Takes as long as the test says.",
		parameters: obj({}),
		replay: "safe",
		execute: async () => {
			started();
			await gate;
			return { output: [{ type: "text" as const, text: "查好了" }], isError: false };
		},
	});
	registry.install(defineExtension({ name: "test.slow", tools: [slow] }));
	const { stepped, root, human, seen } = await streamingCore(registry);
	const [first, second] = [stepped.reply(), stepped.reply()];
	const { api, apiBase } = await bot();
	const clock = manualClock();
	// Refreshed every 20 ms, so a draft still open would go as soon as the clock passes its second.
	streaming(human, apiBase, clock, 20);

	const { message } = api.deliver("查一下", CHAT);
	const id = message.message_id;
	await vi.waitFor(() => expect(api.drafts).toHaveLength(1));
	await first.end(fauxToolCall("slow", {}));
	await running;
	api.stopGeneration(id, CHAT);
	await vi.waitFor(() => expect(api.reactions).toHaveLength(1));
	await settle();
	// The refresh would show the placeholder again while the tool runs.
	clock.advance(1_000);
	await settle();
	expect(draftCalls(api)).toEqual(["sendMessageDraft"]);
	expect(seen.some((event) => event.type === "stopped")).toBe(false);

	release();
	await root.waitForIdle(context);
	await vi.waitFor(() => expect(api.reactions.map(({ emoji }) => emoji)).toEqual(["👀", "🫡"]));
	expect(second.messages).toBeUndefined();
	clock.advance(30_000);
	await settle();
	expect(draftCalls(api)).toEqual(["sendMessageDraft"]);
	expect(api.sent).toEqual([]);
});

test("a stop names the round of the draft pressed, a pressed option's too; one that stops nothing leaves the draft, and a stopped event ends it", async () => {
	const human = new FakeHumanPort();
	const { api, apiBase } = await bot();
	const { onError } = drafting(human, apiBase);
	const draftsOf = (id: number) => api.drafts.filter(({ draft_id }) => draft_id === id).length;

	// Telegram's press on a draft its round no longer shows, or a round this chat never had: the core says no.
	human.stopOutcome = false;
	const { message } = api.deliver("一", CHAT);
	const id = message.message_id;
	await vi.waitFor(() => expect(draftsOf(id)).toBeGreaterThanOrEqual(2));
	api.stopGeneration(id, CHAT);
	await vi.waitFor(() => expect(human.stops).toEqual([`telegram:${id}`]));
	const before = draftsOf(id);
	await vi.waitFor(() => expect(draftsOf(id)).toBeGreaterThan(before));

	// A round from a pressed option shows its draft under the message pressed, and a stop there names that round.
	human.stopOutcome = true;
	const press = api.press("ask/q1/o1", CHAT, 99);
	await vi.waitFor(() => expect(draftsOf(99)).toBeGreaterThanOrEqual(1));
	api.stopGeneration(press.callback_query.message.message_id, CHAT);
	await vi.waitFor(() => expect(human.stops).toEqual([`telegram:${id}`, "telegram:ask/q1"]));
	await settle();
	const pressed = draftsOf(99);
	await settle();
	expect(draftsOf(99)).toBe(pressed);

	// The stopped event alone ends the draft too, reacts and sends nothing.
	human.emit({ type: "stopped", requestId: `telegram:${id}` });
	await vi.waitFor(() => expect(api.reactions.at(-1)).toEqual({ message_id: id, emoji: "🫡" }));
	await settle();
	const stopped = draftsOf(id);
	await settle();
	expect(draftsOf(id)).toBe(stopped);
	expect(api.sent).toEqual([]);

	// A stop that throws is reported, and the updates after it are still taken.
	vi.spyOn(human, "stop").mockRejectedValueOnce(new Error("boom"));
	api.stopGeneration(id, CHAT);
	api.deliver("二", CHAT);
	await vi.waitFor(() => expect(human.inputs).toHaveLength(2));
	expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
});
