import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createTtyAgentPort, type Pty, type SpawnPty } from "../../../src/adapters/tty/agent-port.ts";
import type { AgentPort, AgentStatusEvent } from "../../../src/ports/agent.ts";
import { git } from "../rex/fake.ts";

const SESSION = "0e9d6c1f-4a3b-4a52-9c85-2f6d3f6f2f10";
const request = { name: "card-a", card: "card-a", cwd: "/nonexistent/repo", sessionId: SESSION };
const fixture = (name: string) =>
	readFileSync(join(import.meta.dirname, "../../agent-cli/permission/fixtures", name), "utf8");
const herdrFixture = (name: string) => readFileSync(join(import.meta.dirname, "../herdr/fixtures", name), "utf8");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const report = (body: string) => `\x1b]7501;${body}\x1b\\`;

/** A pty whose output the test writes and whose input it reads back. */
class FakePty implements Pty {
	readonly written: string[] = [];
	killed = false;
	#data = new Set<(data: string) => void>();
	#exit = new Set<(event: { exitCode: number }) => void>();
	onData(listener: (data: string) => void) {
		this.#data.add(listener);
		return { dispose: () => this.#data.delete(listener) };
	}
	onExit(listener: (event: { exitCode: number }) => void) {
		this.#exit.add(listener);
		return { dispose: () => this.#exit.delete(listener) };
	}
	write(data: string) {
		this.written.push(data);
	}
	kill() {
		this.killed = true;
	}
	/** What claude draws: a screen as the fixtures hold it, with the newlines a terminal needs. */
	out(data: string) {
		for (const listener of this.#data) listener(data.replace(/\r?\n/g, "\r\n"));
	}
	exit(exitCode: number) {
		for (const listener of this.#exit) listener({ exitCode });
	}
}

function harness(options: { cap?: number; env?: NodeJS.ProcessEnv } = {}) {
	const ptys: FakePty[] = [];
	const spawns: { file: string; args: string[]; cwd: string; env: Record<string, string> }[] = [];
	const spawn: SpawnPty = (file, args, { cwd, env }) => {
		spawns.push({ file, args, cwd, env });
		const pty = new FakePty();
		ptys.push(pty);
		return pty;
	};
	const { git: run, runs } = git();
	const port = createTtyAgentPort({
		spawn,
		git: run,
		env: options.env ?? { PATH: "/bin" },
		cap: options.cap ?? 4,
		trustMs: 20,
		redrawMs: 1,
		confirmMs: 30,
		keyGapMs: 0,
		onError: (error) => {
			throw error;
		},
	});
	const events: AgentStatusEvent[] = [];
	port.onStatus((event) => events.push(event));
	return { port, ptys, spawns, runs, events };
}

/** Lets the emulator parse what was written and the adapter's queue run. */
const settle = () => sleep(20);

async function started(port: AgentPort, ptys: FakePty[], name = "card-a") {
	await port.start({ ...request, name, card: name });
	const pty = ptys.at(-1);
	if (pty === undefined) throw new Error("nothing spawned");
	return pty;
}

test("start runs claude with its session id in fleet/<card>, without the marks of a claude session soma runs in", async () => {
	const { port, spawns, runs } = harness({
		env: { PATH: "/bin", HOME: "/home", CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "x" },
	});
	await port.start(request);
	expect(runs).toContainEqual([
		"/nonexistent/repo",
		"worktree",
		"add",
		"-b",
		"fleet/card-a",
		"/nonexistent/repo/.claude/worktrees/card-a",
	]);
	expect(spawns).toEqual([
		{
			file: "claude",
			args: ["--session-id", SESSION],
			cwd: "/nonexistent/repo/.claude/worktrees/card-a",
			env: { PATH: "/bin", HOME: "/home" },
		},
	]);
});

test("the 7501 probe is answered, so claude reports its status", async () => {
	const { port, ptys } = harness();
	const pty = await started(port, ptys);
	pty.out(report("?"));
	await settle();
	expect(pty.written).toContain("\x1b]7501;?\x1b\\");
});

test("root reports become statuses under rising seqs; child records and unknown states are ignored", async () => {
	const { port, ptys, events } = harness();
	const pty = await started(port, ptys);
	pty.out(report("state=idle:app=claude-code"));
	pty.out(report("state=working:id=agent/1"));
	pty.out(report("state=working:app=claude-code"));
	pty.out(report("state=sleeping"));
	pty.out(report(`state=done:msg=${b64("all done")}`));
	await settle();

	expect(events.map(({ agent, status }) => ({ agent, status }))).toEqual([
		{ agent: "card-a", status: { state: "idle" } },
		{ agent: "card-a", status: { state: "working" } },
		{ agent: "card-a", status: { state: "done", msg: "all done" } },
	]);
	const seqs = events.map((event) => event.seq);
	expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
	expect(new Set(seqs).size).toBe(3);
	expect(await port.list()).toEqual([
		{ name: "card-a", sessionId: SESSION, status: { state: "done", msg: "all done" }, seq: seqs[2] },
	]);
});

test("a blocked report carries the prompt read off the screen, and an answer types its key", async () => {
	const { port, ptys, events } = harness();
	const pty = await started(port, ptys);
	pty.out(report("state=working"));
	pty.out(herdrFixture("blocked-bash-prompt.txt"));
	pty.out(report("state=blocked:kind=permission"));
	await settle();

	const blocked = events.at(-1)?.status;
	if (blocked?.state !== "blocked" || blocked.fingerprint === undefined) throw new Error("no readable block");
	expect(blocked.options?.map((option) => option.id)).toEqual(["1", "2", "3"]);
	expect(await port.respond("card-a", { option: "1", fingerprint: "other" })).toEqual({
		sent: false,
		refusal: "stale",
	});
	expect(await port.respond("card-a", { option: "9", fingerprint: blocked.fingerprint })).toEqual({
		sent: false,
		refusal: "unknown_option",
	});
	expect(await port.respond("card-a", { option: "1", fingerprint: blocked.fingerprint })).toEqual({ sent: true });
	expect(pty.written.at(-1)).toBe("1");
});

test("the trust dialog, drawn before any record, is a block answered with Down and Enter", async () => {
	const { port, ptys, events } = harness();
	const pty = await started(port, ptys);
	pty.out(report("state=clear"));
	pty.out(fixture("claude-trust-dialog-2.1.302.txt"));
	await sleep(80);

	const blocked = events.at(-1)?.status;
	if (blocked?.state !== "blocked" || blocked.fingerprint === undefined) throw new Error("no trust dialog");
	expect(blocked.msg).toContain("trusts the repository root /nonexistent/repo/.claude/worktrees/card-a");
	expect(events).toHaveLength(1);
	expect(await port.respond("card-a", { option: "2", fingerprint: blocked.fingerprint })).toEqual({ sent: true });
	expect(pty.written.slice(-2)).toEqual(["\x1b[B", "\r"]);
});

test("a prompt goes only to an idle or done agent, as a bracketed paste when claude asked for one", async () => {
	const { port, ptys } = harness();
	const pty = await started(port, ptys);
	await expect(port.prompt("card-a", "hi")).rejects.toThrow(/without a status record/);
	pty.out(`\x1b[?2004h${report("state=idle")}`);
	await settle();

	const sent = port.prompt("card-a", "line one\nline two");
	await sleep(5);
	pty.out(report("state=working"));
	await sent;
	expect(pty.written.filter((data) => !data.startsWith("\x1b]"))).toEqual([
		"\x1b[200~line one\nline two\x1b[201~",
		"\r",
	]);
	await expect(port.prompt("card-a", "hi")).rejects.toThrow(/is working/);
});

test("an idle claude that did not take the prompt gets one more Enter", async () => {
	const { port, ptys } = harness();
	const pty = await started(port, ptys);
	pty.out(report("state=idle"));
	await settle();
	await port.prompt("card-a", "hi");
	expect(pty.written.filter((data) => !data.startsWith("\x1b]"))).toEqual(["hi", "\r", "\r"]);
});

test("one name runs once, and the cap counts the agents still running", async () => {
	const { port, ptys } = harness({ cap: 2 });
	await started(port, ptys, "card-a");
	await expect(port.start(request)).rejects.toThrow(/already runs an agent named card-a/);
	const b = await started(port, ptys, "card-b");
	await expect(port.start({ ...request, name: "card-c", card: "card-c" })).rejects.toThrow(/hangar is full/);
	b.exit(0);
	await started(port, ptys, "card-c");
});

test("claude exiting is an error, listed until the name is started again or stopped", async () => {
	const { port, ptys, events } = harness();
	const pty = await started(port, ptys);
	pty.out(report("state=working"));
	pty.exit(1);
	await settle();
	expect(events.at(-1)?.status).toEqual({ state: "error", msg: "claude exited with code 1" });
	expect((await port.list())[0]?.status).toEqual({ state: "error", msg: "claude exited with code 1" });

	const again = await started(port, ptys);
	expect(again).not.toBe(pty);
	await port.stop("card-a");
	expect(again.killed).toBe(true);
	expect(await port.list()).toEqual([]);
});

test("an agent a restart lost has no result and waits on nothing", async () => {
	const { port } = harness();
	expect(await port.readResult("card-a")).toBeUndefined();
	expect(await port.respond("card-a", { option: "1", fingerprint: "fp" })).toEqual({
		sent: false,
		refusal: "not_blocked",
	});
});

test("an exited agent takes no prompt", async () => {
	const { port, ptys } = harness();
	const pty = await started(port, ptys);
	pty.out(report("state=idle"));
	pty.exit(0);
	await settle();
	await expect(port.prompt("card-a", "hi")).rejects.toThrow(/has exited/);
	expect(pty.written.filter((data) => !data.startsWith("\x1b]"))).toEqual([]);
});

test("a block whose screen moved on before it was read is not reported", async () => {
	const { port, ptys, events } = harness();
	const pty = await started(port, ptys);
	pty.out(herdrFixture("blocked-bash-prompt.txt"));
	pty.out(report("state=blocked:kind=permission"));
	pty.out(`\x1b[2J${report("state=working")}`);
	await settle();
	expect(events.map((event) => event.status.state)).toEqual(["working"]);
});
