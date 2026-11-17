import { PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../../../src/adapters/fake-agent/index.ts";
import { FakeHumanPort } from "../../../src/adapters/fake-human/index.ts";
import { detectProgramStatus, jobRecordId, runTerminal } from "../../../src/adapters/terminal/index.ts";
import { formatProgramStatus } from "../../../src/adapters/terminal/program-status.ts";
import { PRESETS } from "../../../src/core/domain/push.ts";
import { askExtension } from "../../../src/core/extensions/ask/index.ts";
import { openHumanPort } from "../../../src/core/human-port.ts";
import type { SomaEvent } from "../../../src/ports/human.ts";

const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

const QUERY = "\x1b]7501;?\x1b\\\x1b[c";
const DA_REPLY = "\x1b[?62;22c";

function tty(answer?: string) {
	const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
	const output = Object.assign(new PassThrough(), { isTTY: true });
	let written = "";
	output.on("data", (chunk: Buffer) => {
		written += chunk.toString();
		if (answer !== undefined && written.endsWith(QUERY)) input.write(answer);
	});
	return { input, output, written: () => written };
}

test("a 7501 reply before the device attributes reply means supported", async () => {
	const { input, output } = tty(`\x1b]7501;?:states=idle,working,done,blocked,error\x1b\\${DA_REPLY}`);
	expect(await detectProgramStatus(input, output, undefined)).toBe(true);
	expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
});

test("a device attributes reply alone means unsupported, as under tmux", async () => {
	const { input, output } = tty(DA_REPLY);
	expect(await detectProgramStatus(input, output, undefined, 5000)).toBe(false);
});

test("no reply at all times out as unsupported", async () => {
	const { input, output } = tty();
	expect(await detectProgramStatus(input, output, undefined, 20)).toBe(false);
});

test("a stream that is not a terminal is never queried", async () => {
	const input = new PassThrough();
	const output = Object.assign(new PassThrough(), { isTTY: false });
	const write = vi.spyOn(output, "write");
	expect(await detectProgramStatus(input, output, undefined)).toBe(false);
	expect(write).not.toHaveBeenCalled();
});

test("an override forces the answer without a query", async () => {
	const { input, output, written } = tty(DA_REPLY);
	expect(await detectProgramStatus(input, output, true)).toBe(true);
	expect(await detectProgramStatus(input, output, false)).toBe(false);
	expect(written()).toBe("");
});

test("jobRecordId keeps a card within one id segment", () => {
	expect(jobRecordId("terminal-osc7501")).toBe("job/terminal-osc7501");
	expect(jobRecordId("a".repeat(40))).toBe(`job/${"a".repeat(32)}`);
	expect(jobRecordId("x y")).toBe("job/x-y");
});

async function session(programStatus: boolean) {
	const human = new FakeHumanPort();
	const input = new PassThrough();
	const output = new PassThrough();
	let written = "";
	output.on("data", (chunk: Buffer) => {
		written += chunk.toString();
	});
	const running = runTerminal({ human, input, output, programStatus });
	const type = async (line: string) => {
		const count = human.inputs.length;
		input.write(`${line}\n`);
		await vi.waitFor(() => expect(human.inputs.length).toBe(count + 1));
		return human.inputs.at(-1)?.requestId as string;
	};
	const take = () => {
		const value = written;
		written = "";
		return value;
	};
	const end = () => {
		input.end();
		return running;
	};
	return { human, type, take, end };
}

const root = (status: Parameters<typeof formatProgramStatus>[0]) => formatProgramStatus({ ...status, app: "soma" });

test("each line is an input with a fresh terminal requestId; only this client's answers are printed", async () => {
	const { human, type, take, end } = await session(false);
	const first = await type("派 a");
	const second = await type("還有嗎");

	expect(first).toMatch(/^terminal:\d+$/);
	expect(Number(second.slice(9))).toBeGreaterThan(Number(first.slice(9)));
	expect(human.inputs[0]).toEqual({ content: "派 a", entry: { kind: "chat.terminal" }, requestId: first });
	human.emit({ type: "answer", requestId: first, content: "已派工。" });
	human.emit({ type: "answer", requestId: "terminal:1", content: "another terminal's answer" });
	human.emit({ type: "answer", requestId: "telegram:7", content: "telegram's answer" });
	human.emit({ type: "answer", requestId: "schedule:3", content: "提醒：喝水", class: "outcome" });
	human.emit({ type: "answer", requestId: "digest:1", content: "報告的那一輪" });
	human.emit({ type: "notice", kind: "report", class: "outcome", content: "報告" });
	human.emit({ type: "notice", kind: "forwarded", requestId: first });

	expect(take()).toBe("已派工。\n[通知] 提醒：喝水\n[通知] 報告\n");
	await end();
});

test("the root record follows runs, questions and reports; jobs get child records", async () => {
	const { human, type, take, end } = await session(true);
	await type("派 a");
	expect(take()).toBe(root({ state: "idle" }));

	human.emit({ type: "run", state: "working" });
	expect(take()).toBe(root({ state: "working" }));
	human.emit({ type: "job", card: "a", agent: "a", status: { state: "working" } });
	expect(take()).toBe(formatProgramStatus({ state: "working", id: "job/a", title: "a" }));
	human.emit({ type: "job", card: "a", agent: "a", status: { state: "blocked", kind: "permission", msg: "rm -rf?" } });
	expect(take()).toBe(
		formatProgramStatus({ state: "blocked", id: "job/a", title: "a", kind: "permission", message: "rm -rf?" }),
	);
	human.emit({ type: "notice", kind: "question", class: "action", content: "a 要權限，准嗎？\n細節" });
	expect(take()).toBe(
		`[問題] a 要權限，准嗎？\n細節\n${root({ state: "blocked", kind: "question", message: "a 要權限，准嗎？" })}`,
	);
	human.emit({ type: "run", state: "idle" });
	human.emit({ type: "notice", kind: "report", class: "outcome", content: "十分鐘報告" });
	expect(take()).toBe("[通知] 十分鐘報告\n");

	await type("准");
	expect(take()).toBe(root({ state: "idle" }));
	human.emit({ type: "notice", kind: "report", class: "outcome", content: "下一份報告" });
	expect(take()).toBe(`[通知] 下一份報告\n${root({ state: "done", message: "下一份報告" })}`);
	await end();
});

test("a failed round of this client or of the core is printed and turns the root record to error", async () => {
	const { human, type, take, end } = await session(true);
	const mine = await type("你好");
	take();

	human.emit({ type: "failure", requestId: "telegram:7", reason: "模型出錯：x" });
	human.emit({ type: "failure", requestId: "terminal:1", reason: "模型出錯：x" });
	human.emit({ type: "failure", requestId: "digest:1", reason: "模型出錯：x" });
	expect(take()).toBe("");
	human.emit({ type: "failure", requestId: mine, reason: "模型出錯：Provider is not configured: anthropic" });
	expect(take()).toBe(
		`[失敗] 模型出錯：Provider is not configured: anthropic\n${root({ state: "error", message: "模型出錯：Provider is not configured: anthropic" })}`,
	);
	human.emit({ type: "failure", requestId: "agent:a:3", reason: "內部錯誤：boom", class: "outcome" });
	expect(take()).toBe(
		`[失敗] agent:a:3 那一輪：內部錯誤：boom\n${root({ state: "error", message: "agent:a:3 那一輪：內部錯誤：boom" })}`,
	);

	await type("再試一次");
	expect(take()).toBe(root({ state: "idle" }));
	await end();
});

test("an unsupported terminal gets no OSC 7501 bytes", async () => {
	const { human, type, take, end } = await session(false);
	await type("派 a");
	human.emit({ type: "run", state: "working" });
	human.emit({ type: "job", card: "a", agent: "a", status: { state: "blocked", kind: "auth" } });
	human.emit({ type: "notice", kind: "question", class: "action", content: "?" });
	expect(take()).toBe("[問題] ?\n");
	await end();
});

test("a push shown quietly here is printed without raising the root record, and a logged one is not printed", async () => {
	const { human, type, take, end } = await session(true);
	await type("派 a");
	expect(take()).toBe(root({ state: "idle" }));

	const quiet = { "chat.telegram": "ring", "chat.terminal": "quiet" } as const;
	const logged = { "chat.telegram": "ring", "chat.terminal": "log" } as const;
	human.emit({ type: "notice", kind: "question", class: "action", content: "問 telegram", delivery: quiet });
	human.emit({ type: "failure", requestId: "schedule:1", reason: "boom", class: "outcome", delivery: quiet });
	expect(take()).toBe("[問題] 問 telegram\n[失敗] schedule:1 那一輪：boom\n");
	human.emit({ type: "notice", kind: "report", class: "ambient", content: "記下了", delivery: logged });
	human.emit({ type: "failure", requestId: "schedule:2", reason: "boom", class: "outcome", delivery: logged });
	human.emit({ type: "answer", requestId: "schedule:3", content: "喝水", class: "outcome", delivery: logged });
	expect(take()).toBe("");
	const here = { "chat.terminal": "ring" } as const;
	human.emit({ type: "notice", kind: "question", class: "action", content: "問這裡", delivery: here });
	expect(take()).toBe(`[問題] 問這裡\n${root({ state: "blocked", kind: "question", message: "問這裡" })}`);
	await end();
});

test("a question soma asked prints its options numbered, and the answer is typed; a prompt's options are not listed", async () => {
	const { human, type, take, end } = await session(false);
	const options = [
		{ id: "1", label: "好" },
		{ id: "2", label: "不用" },
	];
	human.emit({
		type: "notice",
		kind: "question",
		class: "action",
		content: "要我稍後再試嗎？",
		choices: { question: "q", options },
	});
	human.emit({
		type: "notice",
		kind: "question",
		class: "action",
		content: "要讓它執行嗎？",
		choices: { card: "c", fingerprint: "f", options },
	});
	human.emit({ type: "said", question: "q", label: "好" });
	expect(take()).toBe("[問題] 要我稍後再試嗎？\n  1. 好\n  2. 不用\n[問題] 要讓它執行嗎？\n");

	const typed = await type("2");
	expect(human.inputs.at(-1)).toEqual({ content: "2", entry: { kind: "chat.terminal" }, requestId: typed });
	expect(human.said).toEqual([]);
	await end();
});

test("a round that asked a question here and wrote nothing after it prints no empty line, and its question rang", async () => {
	const { human, type, take, end } = await session(true);
	const asked = await type("問我晚餐");
	expect(take()).toBe(root({ state: "idle" }));

	human.emit({ type: "run", state: "working" });
	const here = { "chat.terminal": "ring" } as const;
	human.emit({ type: "notice", kind: "question", class: "action", content: "晚餐吃什麼？", delivery: here });
	human.emit({ type: "answer", requestId: asked, content: "", asked: true });
	human.emit({ type: "run", state: "idle" });
	// The question raised the root record over working; the round's end leaves it there, with nothing printed.
	expect(take()).toBe(
		`${root({ state: "working" })}[問題] 晚餐吃什麼？\n${root({ state: "blocked", kind: "question", message: "晚餐吃什麼？" })}`,
	);

	const typed = await type("問我午餐");
	expect(take()).toBe(root({ state: "idle" }));
	human.emit({ type: "answer", requestId: typed, content: "想好再說。", asked: true });
	const plain = await type("嗯");
	human.emit({ type: "answer", requestId: plain, content: "" });
	expect(take()).toBe("想好再說。\n\n");
	await end();
});

/**
 * A terminal fed by a real core whose model can ask, the terminal at `summary`, so a question reaches it only as part
 * of the reply to its own input. Every event is kept in `seen`.
 */
async function coreSession() {
	const storage = new MemoryStorage();
	const registry = createRegistry();
	registry.install(askExtension({ storage, interfaces: ["chat.terminal", "chat.telegram"] }));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(storage, { models, registry }, context);
	cleanup.push(() => harness.close(context));
	const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const human = await openHumanPort(harness, conversation, new FakeAgentPort(), context, {
		policies: { "chat.terminal": PRESETS.summary },
		storage,
	});
	cleanup.push(() => human.close());
	const seen: SomaEvent[] = [];
	human.subscribe((event) => seen.push(event));
	const submit = vi.spyOn(human, "submit");
	const input = new PassThrough();
	const output = new PassThrough();
	let written = "";
	output.on("data", (chunk: Buffer) => {
		written += chunk.toString();
	});
	const running = runTerminal({ human, input, output, programStatus: true });
	cleanup.push(() => {
		input.end();
		return running;
	});
	const type = async (line: string) => {
		const count = submit.mock.calls.length;
		input.write(`${line}\n`);
		await vi.waitFor(() => expect(submit.mock.calls.length).toBe(count + 1));
		await submit.mock.results.at(-1)?.value;
		await conversation.waitForIdle(context);
	};
	const take = () => {
		const value = written;
		written = "";
		return value;
	};
	return { faux, human, conversation, seen, type, take };
}

test("from a real core: a question asked in reply here rings, nothing follows it, and a press elsewhere clears it", async () => {
	const { faux, human, conversation, seen, type, take } = await coreSession();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("ask", { question: "晚餐吃什麼？", options: ["拉麵", "咖哩"] })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(""),
		fauxAssistantMessage("好，拉麵。"),
	]);
	// The terminal hears each event in the same emit as `seen`, after it.
	const answered = (prefix: string) =>
		vi.waitFor(() =>
			expect(seen.some((event) => event.type === "answer" && event.requestId.startsWith(prefix))).toBe(true),
		);
	await type("問我晚餐");
	await answered("terminal:");
	expect(seen.find((event) => event.type === "answer")).toMatchObject({ content: "", asked: true });
	const blocked = root({ state: "blocked", kind: "question", message: "晚餐吃什麼？" });
	// No empty line after the options; the question holds the root record over the round's end.
	expect(take()).toBe(
		`${root({ state: "idle" })}${root({ state: "working" })}[問題] 晚餐吃什麼？\n  1. 拉麵\n  2. 咖哩\n${blocked}`,
	);

	const [question = ""] = seen.flatMap((event) =>
		event.type === "notice" && event.kind === "question" && event.choices && "question" in event.choices
			? [event.choices.question]
			: [],
	);
	await human.say(question, "1", { entry: { kind: "chat.telegram" }, requestId: "telegram:ask/1" });
	await conversation.waitForIdle(context);
	await answered("telegram:");
	// Said on Telegram: the terminal stops waiting, and the round it started, Telegram's, is not printed here.
	expect(take().endsWith(root({ state: "idle" }))).toBe(true);
});

test("a question that blocks the terminal stays blocked when another question is said, and a prompt is not cleared by a press", async () => {
	const { human, take, end } = await session(true);
	const options = [
		{ id: "1", label: "好" },
		{ id: "2", label: "不用" },
	];
	human.emit({
		type: "notice",
		kind: "question",
		class: "action",
		content: "問一",
		choices: { question: "q1", options },
	});
	human.emit({
		type: "notice",
		kind: "question",
		class: "action",
		content: "權限？",
		choices: { card: "c", fingerprint: "f", options },
	});
	take();
	human.emit({ type: "said", question: "q1", label: "好" });
	expect(take()).toBe("");
	human.emit({
		type: "notice",
		kind: "question",
		class: "action",
		content: "問二",
		choices: { question: "q2", options },
	});
	take();
	human.emit({ type: "said", question: "q1", label: "好" });
	expect(take()).toBe("");
	human.emit({ type: "said", question: "q2", label: "不用" });
	expect(take()).toBe(root({ state: "idle" }));
	await end();
});
