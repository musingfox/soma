import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, test, vi } from "vitest";
import { run } from "../smoke/driver.ts";
import { ConfigError, resolveConfig } from "../src/config.ts";
import { Dreams } from "../src/core/extensions/dream/index.ts";
import { dreamWiring } from "../src/dream.ts";
import { context, DREAM_ANSWER, DREAM_MODEL, openCore, ROOT_MODEL, textOf } from "./dream-core.ts";

const unused = {
	scanSubmissions: async () => {
		throw new Error("no submission is read when the dream is off");
	},
};
const CHILD = fileURLToPath(new URL("./dream-child.ts", import.meta.url));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const each of cleanup.splice(0).reverse()) await each();
});

async function directory() {
	const path = await mkdtemp(join(tmpdir(), "soma-dream-"));
	cleanup.push(() => rm(path, { recursive: true, force: true }));
	return path;
}

type Core = Awaited<ReturnType<typeof openCore>>;

async function core(options: Omit<Parameters<typeof openCore>[0], "db"> = {}) {
	const soma = await openCore({ db: join(await directory(), "soma.sqlite"), ...options });
	cleanup.push(() => soma.close());
	return soma;
}

let said = 0;
/** The human says `content` on the terminal and the round ends. */
async function say(soma: Core, content: string) {
	const requestId = `terminal:${++said}`;
	await soma.human.submit({ content, entry: { kind: "chat.terminal" }, requestId });
	await vi.waitFor(() => expect(soma.events).toContainEqual(expect.objectContaining({ type: "answer", requestId })));
	await soma.root.waitForIdle(context);
}

/** The human says `content`, then stops the round while the model is still at it. */
async function stopRound(soma: Core, content: string) {
	const requestId = `terminal:${++said}`;
	const before = soma.requests.length;
	await soma.human.submit({ content, entry: { kind: "chat.terminal" }, requestId });
	await vi.waitFor(() => expect(soma.requests.length).toBeGreaterThan(before));
	expect(await soma.human.stop(requestId)).toBe(true);
	await vi.waitFor(() => expect(soma.events).toContainEqual({ type: "stopped", requestId }));
	await soma.root.waitForIdle(context);
}

const dreamRequests = (soma: Core) => soma.requests.filter((request) => request.model === DREAM_MODEL);
const rootRequests = (soma: Core) => soma.requests.filter((request) => request.model === ROOT_MODEL);
const contentOf = (request: { context: { messages: readonly { role: string; content?: unknown }[] } } | undefined) =>
	(request?.context.messages ?? []).map((message) => textOf(message.content ?? "")).join("\n");

/** Starts the dream and waits for its notice. */
async function dreamOnce(soma: Core) {
	const before = soma.notices().length;
	await soma.startDream();
	await vi.waitFor(() => expect(soma.notices().length).toBeGreaterThan(before), { timeout: 5_000 });
	return soma.notices().at(-1);
}

test("a dream is due at once, reads the window's records and tells the human its answer without a root round", async () => {
	const soma = await core();
	await say(soma, "你好，今天要做什麼？");
	await say(soma, "幫我讀檔 notes.md");
	await stopRound(soma, "慢慢想一下這個問題");
	const entries = (await soma.root.entries({ order: "ascending" }, 1000, undefined, context)).items;
	const id = (kind: string, has: (entry: (typeof entries)[number]) => boolean) =>
		entries.find((entry) => entry.kind === kind && has(entry))?.id;
	const greeting = id("chat.terminal", (entry) => textOf(entry.model?.[0]?.content).includes("你好"));
	const answered = id("pi.assistant", (entry) => textOf(entry.model?.[0]?.content) === "好的。");
	const failed = id("pi.tool-result", () => true);
	const stopped = id("chat.terminal", (entry) => textOf(entry.model?.[0]?.content).includes("慢慢想"));
	const rounds = rootRequests(soma).length;
	const last = entries.at(-1)?.id ?? 0;

	const notice = await dreamOnce(soma);

	const [request, ...more] = dreamRequests(soma);
	expect(more).toEqual([]);
	const input = contentOf(request);
	expect(input).toMatch(
		new RegExp(`entry:${greeting} \\d\\d-\\d\\d \\d\\d:\\d\\d 人（terminal）：你好，今天要做什麼？`),
	);
	expect(input).toMatch(
		new RegExp(`entry:${answered} [^\\n]* soma：好的。 〔context \\d+，快取讀 \\d+，0\\.0123 USD，stop〕`),
	);
	expect(input).toMatch(new RegExp(`entry:${failed} [^\\n]* 工具結果 broken（錯誤）：ENOENT: 找不到檔案`));
	// The stopped round is the human's stop, not the bare `aborted` the backtest's models took for a fault.
	expect(input).toMatch(
		new RegExp(`entry:${stopped} [^\\n]*慢慢想一下這個問題（人自己按了停止，這一輪是人停下的，不是故障）`),
	);
	expect(input).not.toContain("aborted");
	// Per day: three root rounds at 0.0123, the first with no cache read.
	expect(input).toMatch(/\d{4}-\d\d-\d\d｜3｜0\.037｜1｜0\.012｜\d+/);
	expect(input).toContain("設定沒有指定 log 檔，這次沒有讀 log。");
	expect(input).toContain("長期記憶：沒有任何條目");
	// The model of the dream, thinking, with no tool to call.
	expect(request?.options?.reasoning).toBe("high");
	// No section of the root's prompt and no tool: the request is the one input.
	expect(request?.context.messages.map((message) => message.role)).toEqual(["user"]);

	expect(notice).toEqual({
		content: expect.stringMatching(
			/^soma 的 dream：\d{4}-\d\d-\d\d \d\d:\d\d 到 \d{4}-\d\d-\d\d \d\d:\d\d（Asia\/Taipei）/,
		),
		class: "ambient",
	});
	expect(notice?.content).toContain(DREAM_ANSWER);
	expect(soma.notices()).toHaveLength(1);
	// The root's model was not woken: no request, and the root got the notice alone.
	expect(rootRequests(soma)).toHaveLength(rounds);
	const after = (await soma.root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter(
		(entry) => entry.id > last,
	);
	expect(after.map((entry) => entry.kind)).toEqual(["notice"]);
	// The dream's cost is where inspect's usage reports it, in the dream's own conversation.
	await say(soma, "查用量");
	const usage = textOf(rootRequests(soma).at(-1)?.context.messages.at(-1)?.content);
	const rows = (JSON.parse(usage) as { items: { conversationId: number; tokens: { cost: number } }[] }).items;
	const dreamt = rows.filter((row) => row.tokens.cost === 0.4567);
	expect(dreamt).toHaveLength(1);
	expect(dreamt[0]?.conversationId).not.toBe(soma.root.id);
});

test("the root's next request after a dream holds none of the dream's input or answer", async () => {
	const soma = await core();
	await say(soma, "你好，記得 PINEAPPLE-INPUT-MARK");
	await dreamOnce(soma);
	expect(contentOf(dreamRequests(soma)[0])).toContain("PINEAPPLE-INPUT-MARK");
	const rounds = rootRequests(soma).length;

	await say(soma, "再見");

	const next = rootRequests(soma)[rounds];
	const sent = JSON.stringify(next?.context);
	expect(sent).toContain("再見");
	expect(sent).not.toContain("DREAM-ANSWER-MARK");
	expect(sent).not.toContain("soma 的 dream");
	expect(sent).not.toContain("你是 soma 的「dream」");
	expect(sent).not.toContain("每日用量");
});

test("a crash between the dream's answer and its commit gives one notice on restart, and the next dream a period later", {
	timeout: 30_000,
}, async () => {
	const db = join(await directory(), "soma.sqlite");
	const first = run(["answer", db], CHILD);
	await first.exited;
	expect(first.process.signalCode).toBe("SIGKILL");

	const second = run(["resume", db], CHILD);
	const done = await second.next("done");
	expect(await second.exited).toBe(0);
	const { notices, dreamCalls, checkpoint, pinned } = done as unknown as {
		notices: string[];
		dreamCalls: number;
		checkpoint: { since: number; next: number; until?: number };
		pinned: { since: number; until: number };
	};
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain(DREAM_ANSWER);
	// The answer was stored before the crash, so the restart asks no model again.
	expect(dreamCalls).toBe(0);
	expect(checkpoint.since).toBe(pinned.until);
	expect(checkpoint.next).toBe(pinned.until + 24 * 60 * 60_000);
	expect(checkpoint.until).toBeUndefined();
});

const LOG_KEY =
	"sk-ant-api03-Zq8vKxLmNpRtWyBcDfGhJk-QwErTyUiOpAsDfGhJkLzXcVbNm-Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLlMmNnOoPp-QqRrSsTtAA";

test("with a log, only its lines stamped in the window are profiled and starts counted; secrets reach no request", async () => {
	const now = Date.now();
	const at = (ms: number) => new Date(ms).toISOString();
	const log = [
		`${at(now - 30 * 24 * 60 * 60_000)} [soma] OLD-LINE-MARK from a month ago`,
		`${at(now - 30 * 24 * 60 * 60_000)} [soma] started`,
		`${at(now - 3 * 60 * 60_000)} [soma] started`,
		`${at(now - 2 * 60 * 60_000)} [soma] event bridge: request req011CVa1b2c3d4e5f failed after 12345 ms`,
		`${at(now - 60 * 60_000)} [soma] event bridge: request req011CVf9e8d7c6b5a failed after 67890 ms`,
		"    at handle (file:///soma/src/core/extensions/dispatch/bridge.ts:120:5)",
		`${at(now - 30 * 60_000)} [soma] telegram: 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ refused`,
		// Secrets the profile's id erasing leaves whole or in part, so only redaction keeps them out.
		`${at(now - 20 * 60_000)} [soma] anthropic: 401 for key ${LOG_KEY}`,
		`${at(now - 10 * 60_000)} [soma] mail to log-mark@example.com bounced`,
		`${at(now + 60 * 60_000)} [soma] FUTURE-LINE-MARK`,
	].join("\n");
	const soma = await core({ dream: { readLog: async () => log } });
	await say(soma, "我的金鑰是 sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123，信箱 me@example.com");

	await dreamOnce(soma);

	const input = contentOf(dreamRequests(soma)[0]);
	expect(input).toContain("程序啟動次數（[soma] started）：1");
	expect(input).toContain("2｜[soma] event bridge: request <id> failed after <n> ms");
	expect(input).toContain("沒有時間戳的行（整份 log，不分時間，沒有列出內容）：1");
	expect(input).not.toContain("OLD-LINE-MARK");
	expect(input).not.toContain("FUTURE-LINE-MARK");
	expect(input).not.toContain("handle (file://");
	const sent = JSON.stringify(dreamRequests(soma));
	for (const secret of [
		"sk-ant-api03",
		"AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ",
		"me@example.com",
		"QwErTyUiOpAsDfGhJkLzXcVbNm",
		"QqRrSsTtAA",
	])
		expect(sent).not.toContain(secret);
	expect(input).toContain("1｜[soma] anthropic: 401 for key [secret]");
	expect(input).toContain("1｜[soma] mail to [email] bounced");
	expect(input).toContain("[secret]");
	expect(input).toContain("[email]");
});

test("dream absent or false installs and starts nothing and asks no model; a wrong value is refused", async () => {
	for (const file of [undefined, { dream: false }]) {
		const config = resolveConfig(file, {}, "/home/me");
		const wiring = dreamWiring(config, unused, async () => {
			throw new Error("no log is read when the dream is off");
		});
		expect(wiring.extensions).toEqual([]);
		const soma = await core({ dream: false, extensions: wiring.extensions });
		await say(soma, "你好");
		const requests = soma.requests.length;
		await wiring.start(soma.root, context);
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(await soma.harness.snapshot(Dreams, soma.root.id, context)).toBeUndefined();
		expect(soma.requests).toHaveLength(requests);
		expect(soma.notices()).toEqual([]);
	}
	const on = dreamWiring(resolveConfig({ dream: {} }, {}, "/home/me"), unused);
	expect(on.extensions.map((extension) => extension.name)).toEqual(["soma.dream"]);
	expect(() => resolveConfig({ dream: true }, {}, "/home/me")).toThrow(ConfigError);
});

test("a dream whose call fails tells the human why, and its window is not asked about again", async () => {
	const soma = await core({
		dreamAnswer: () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid x-api-key" }),
	});
	await say(soma, "你好");

	const notice = await dreamOnce(soma);

	expect(notice?.content).toMatch(/^soma 的 dream：.*\n\ndream 沒有完成（.*invalid x-api-key.*）/s);
	const checkpoint = await soma.checkpoint();
	expect(checkpoint?.until).toBeUndefined();
	expect(checkpoint?.next).toBe((checkpoint?.since ?? 0) + 24 * 60 * 60_000);
	const calls = dreamRequests(soma).length;
	await new Promise((resolve) => setTimeout(resolve, 500));
	expect(dreamRequests(soma)).toHaveLength(calls);
	expect(soma.notices()).toHaveLength(1);
});

test("a dream whose model answers nothing tells the human it did not finish, not an empty report", async () => {
	const soma = await core({ dreamAnswer: () => fauxAssistantMessage(" \n") });
	await say(soma, "你好");

	const notice = await dreamOnce(soma);

	expect(dreamRequests(soma)).toHaveLength(1);
	expect(notice?.content).toMatch(/^soma 的 dream：.*\n\ndream 沒有完成（dream 的模型回了空的答案）。/s);
	const checkpoint = await soma.checkpoint();
	expect(checkpoint?.next).toBe((checkpoint?.since ?? 0) + 24 * 60 * 60_000);
	expect(soma.notices()).toHaveLength(1);
});

test("a dream task held while dream is off stays pending, and when it is on again one dream covers the gap", {
	timeout: 30_000,
}, async () => {
	const db = join(await directory(), "soma.sqlite");
	const period = 1_000;
	const first = await openCore({ db, dream: { periodMs: period } });
	await say(first, "你好");
	await dreamOnce(first);
	const taskId = (await first.harness.snapshot(Dreams, first.root.id, context))?.taskId;
	const covered = await first.checkpoint();
	await first.close();

	const off = await openCore({ db, dream: false });
	await new Promise((resolve) => setTimeout(resolve, 2.5 * period));
	expect(off.requests).toEqual([]);
	expect(off.notices()).toEqual([]);
	await off.close();

	const on = await openCore({ db, dream: { periodMs: period } });
	await on.startDream();
	await vi.waitFor(() => expect(on.notices()).toHaveLength(1), { timeout: 5_000 });
	expect((await on.harness.snapshot(Dreams, on.root.id, context))?.taskId).toBe(taskId);
	// One dream, from the end of the last one to now, over the periods missed.
	expect(dreamRequests(on)).toHaveLength(1);
	const now = await on.checkpoint();
	expect(now?.since).toBeGreaterThanOrEqual((covered?.since ?? 0) + 2.5 * period);
	expect(now?.next).toBe((now?.since ?? 0) + period);
	await on.close();
});
