import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import { FakeHumanPort } from "../../../src/adapters/fake-human/index.ts";
import { detectProgramStatus, jobRecordId, runTerminal } from "../../../src/adapters/terminal/index.ts";
import { formatProgramStatus } from "../../../src/adapters/terminal/program-status.ts";

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
	expect(await detectProgramStatus(input, output, {})).toBe(true);
	expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
});

test("a device attributes reply alone means unsupported, as under tmux", async () => {
	const { input, output } = tty(DA_REPLY);
	expect(await detectProgramStatus(input, output, {}, 5000)).toBe(false);
});

test("no reply at all times out as unsupported", async () => {
	const { input, output } = tty();
	expect(await detectProgramStatus(input, output, {}, 20)).toBe(false);
});

test("a stream that is not a terminal is never queried", async () => {
	const input = new PassThrough();
	const output = Object.assign(new PassThrough(), { isTTY: false });
	const write = vi.spyOn(output, "write");
	expect(await detectProgramStatus(input, output, {})).toBe(false);
	expect(write).not.toHaveBeenCalled();
});

test("SOMA_PROGRAM_STATUS forces the answer without a query", async () => {
	const { input, output, written } = tty(DA_REPLY);
	expect(await detectProgramStatus(input, output, { SOMA_PROGRAM_STATUS: "1" })).toBe(true);
	expect(await detectProgramStatus(input, output, { SOMA_PROGRAM_STATUS: "0" })).toBe(false);
	expect(written()).toBe("");
});

test("jobRecordId keeps a card within one id segment", () => {
	expect(jobRecordId("terminal-osc7501")).toBe("job/terminal-osc7501");
	expect(jobRecordId("a".repeat(40))).toBe(`job/${"a".repeat(32)}`);
	expect(jobRecordId("x y")).toBe("job/x-y");
});

async function session(env: Record<string, string>) {
	const human = new FakeHumanPort();
	const input = new PassThrough();
	const output = new PassThrough();
	let written = "";
	output.on("data", (chunk: Buffer) => {
		written += chunk.toString();
	});
	const running = runTerminal({ human, input, output, env });
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
	const { human, type, take, end } = await session({ SOMA_PROGRAM_STATUS: "0" });
	const first = await type("派 a");
	const second = await type("還有嗎");

	expect(first).toMatch(/^terminal:\d+$/);
	expect(Number(second.slice(9))).toBeGreaterThan(Number(first.slice(9)));
	expect(human.inputs[0]).toEqual({ content: "派 a", entry: { kind: "chat.terminal" }, requestId: first });
	human.emit({ type: "answer", requestId: first, content: "已派工。" });
	human.emit({ type: "answer", requestId: "terminal:1", content: "another terminal's answer" });
	human.emit({ type: "answer", requestId: "telegram:7", content: "telegram's answer" });
	human.emit({ type: "answer", requestId: "schedule:3", content: "提醒：喝水" });
	human.emit({ type: "answer", requestId: "digest:1", content: "報告的那一輪" });
	human.emit({ type: "notice", kind: "report", content: "報告" });

	expect(take()).toBe("已派工。\n[通知] 提醒：喝水\n[通知] 報告\n");
	await end();
});

test("the root record follows runs, questions and reports; jobs get child records", async () => {
	const { human, type, take, end } = await session({ SOMA_PROGRAM_STATUS: "1" });
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
	human.emit({ type: "notice", kind: "question", content: "a 要權限，准嗎？\n細節" });
	expect(take()).toBe(
		`[問題] a 要權限，准嗎？\n細節\n${root({ state: "blocked", kind: "question", message: "a 要權限，准嗎？" })}`,
	);
	human.emit({ type: "run", state: "idle" });
	human.emit({ type: "notice", kind: "report", content: "十分鐘報告" });
	expect(take()).toBe("[通知] 十分鐘報告\n");

	await type("准");
	expect(take()).toBe(root({ state: "idle" }));
	human.emit({ type: "notice", kind: "report", content: "下一份報告" });
	expect(take()).toBe(`[通知] 下一份報告\n${root({ state: "done", message: "下一份報告" })}`);
	await end();
});

test("a failed round of this client or of the core is printed and turns the root record to error", async () => {
	const { human, type, take, end } = await session({ SOMA_PROGRAM_STATUS: "1" });
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
	human.emit({ type: "failure", requestId: "herdr:a:3", reason: "內部錯誤：boom" });
	expect(take()).toBe(
		`[失敗] herdr:a:3 那一輪：內部錯誤：boom\n${root({ state: "error", message: "herdr:a:3 那一輪：內部錯誤：boom" })}`,
	);

	await type("再試一次");
	expect(take()).toBe(root({ state: "idle" }));
	await end();
});

test("an unsupported terminal gets no OSC 7501 bytes", async () => {
	const { human, type, take, end } = await session({ SOMA_PROGRAM_STATUS: "0" });
	await type("派 a");
	human.emit({ type: "run", state: "working" });
	human.emit({ type: "job", card: "a", agent: "a", status: { state: "blocked", kind: "auth" } });
	human.emit({ type: "notice", kind: "question", content: "?" });
	expect(take()).toBe("[問題] ?\n");
	await end();
});
