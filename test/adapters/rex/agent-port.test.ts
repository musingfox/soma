import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tx } from "@earendil-works/pi-durable";
import { afterAll, describe, expect, test } from "vitest";
import { createRexAgentPort, launchCommand, seqOf, stateOf } from "../../../src/adapters/rex/agent-port.ts";
import { readBlockedScreen } from "../../../src/agent-cli/permission/blocked-screen.ts";
import type { Job } from "../../../src/core/domain/dispatch.ts";
import { type JobLedger, startJobIn } from "../../../src/core/extensions/dispatch/index.ts";
import { type AgentPort, type AgentResult, type AgentStatusEvent, PromptRefused } from "../../../src/ports/agent.ts";
import { AT, AT_US, type Block, fixture, git, HANGAR, rex, SESSION } from "./fake.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// A claude whose start ps cannot tell: no unit test runs ps.
const unstarted = async () => undefined;
const request = { name: "card-a", card: "card-a", cwd: "/nonexistent/repo", sessionId: SESSION };

test("start adds fleet/<card> under .claude/worktrees and types claude's command into an interactive shell", async () => {
	const fake = rex([]);
	const { git: run, runs } = git();

	await createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		git: run,
		env: { SOMA_SOCKET: "/run/soma.sock" },
		path: "/opt/soma/bin",
	}).start(request);

	expect(runs).toEqual([
		["/nonexistent/repo", "worktree", "list", "--porcelain"],
		["/nonexistent/repo", "branch", "--list", "fleet/card-a"],
		["/nonexistent/repo", "worktree", "add", "-b", "fleet/card-a", "/nonexistent/repo/.claude/worktrees/card-a"],
	]);
	expect(fake.attached).toEqual([HANGAR]);
	expect(fake.calls).toEqual([
		{ method: "session.view", payload: { session_id: HANGAR } },
		{
			method: "session.new_window",
			payload: {
				session_id: HANGAR,
				window_label: "card-a",
				focus: false,
				layout: {
					block: {
						flavor: "com.superlogical.terminal.shell",
						label: SESSION,
						options: {
							cwd: "/nonexistent/repo/.claude/worktrees/card-a",
							initial_input: `SOMA_SOCKET='/run/soma.sock' SOMA_AGENT='card-a' PATH='/opt/soma/bin':"$PATH" claude --session-id ${SESSION}\n`,
						},
					},
				},
			},
		},
	]);
});

test("the launch command names the card in SOMA_AGENT even with no other variable", () => {
	expect(launchCommand(request)).toBe(`SOMA_AGENT='card-a' claude --session-id ${SESSION}\n`);
});

test("the launch command sets SOMA_AGENT and PATH for claude in sh, zsh and fish alike", () => {
	const line = launchCommand(
		{ ...request, card: "卡 a" },
		{ SOMA_SOCKET: "/Users/me/Library/Application Support/soma.sock" },
		"/opt/soma bin",
	).replace(/claude --session-id \S+\n$/, `sh -c 'printf "%s|%s|%s" "$SOMA_AGENT" "$SOMA_SOCKET" "$PATH"'`);
	// Each without its startup files, which may change PATH.
	const shells = { "/bin/sh": [], "/bin/zsh": ["-f"], "/opt/homebrew/bin/fish": ["--no-config"] };
	for (const [shell, flags] of Object.entries(shells).filter(([path]) => existsSync(path))) {
		const out = spawnSync(shell, [...flags, "-c", line], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).stdout;
		expect([shell, out]).toEqual([
			shell,
			"卡 a|/Users/me/Library/Application Support/soma.sock|/opt/soma bin:/usr/bin:/bin",
		]);
	}
});

test("start refuses a card the launch command cannot quote, before git or rex is touched", async () => {
	const fake = rex([]);
	const { git: run, runs } = git();
	const port = createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR, git: run });

	await expect(port.start({ ...request, card: "it's" })).rejects.toThrow("cannot put");
	expect(runs).toEqual([]);
	expect(fake.calls).toEqual([]);
});

test("start refuses when the hangar's claude blocks already fill the cap, and leaves git and rex alone", async () => {
	const fake = rex([
		{ name: "card-b", block: "block:b", argv0: "claude" },
		{ name: "card-c", block: "block:c", argv0: "claude" },
	]);
	const { git: run, runs } = git();
	const port = createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		git: run,
		cap: 2,
	});

	await expect(port.start(request)).rejects.toThrow("hangar is full: 2 of 2 agents running");
	expect(runs).toEqual([]);
	expect(fake.methods()).not.toContain("session.new_window");
});

test("start does not count a hangar block whose foreground is not claude", async () => {
	const fake = rex([
		{ name: "card-b", block: "block:b", argv0: "claude" },
		{ name: "card-c", block: "block:c", argv0: "-fish" },
	]);
	const { git: run } = git();

	await createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR, git: run, cap: 2 }).start(
		request,
	);

	expect(fake.methods()).toContain("session.new_window");
});

test("start reopens the worktree an earlier attempt left on the branch", async () => {
	const fake = rex([]);
	const porcelain =
		"worktree /nonexistent/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt/card-a\nHEAD def\nbranch refs/heads/fleet/card-a\n";
	const { git: run, runs } = git(porcelain, "  fleet/card-a\n");

	await createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR, git: run }).start(
		request,
	);

	expect(runs).toHaveLength(1);
	expect(fake.calls.find((call) => call.method === "session.new_window")?.payload).toMatchObject({
		layout: { block: { options: { cwd: "/wt/card-a" } } },
	});
});

test("start checks out a branch that exists without a worktree", async () => {
	const { git: run, runs } = git("", "  fleet/card-a\n");

	await createRexAgentPort({ processStart: unstarted, client: rex([]).client, sessionId: HANGAR, git: run }).start(
		request,
	);

	expect(runs.at(-1)).toEqual([
		"/nonexistent/repo",
		"worktree",
		"add",
		"/nonexistent/repo/.claude/worktrees/card-a",
		"fleet/card-a",
	]);
});

test("list names each job's window, with the root record's status and seq while claude is in the foreground", async () => {
	const fake = rex([
		{
			name: "card-a",
			block: "block:a",
			label: SESSION,
			argv0: "claude",
			records: [
				{ state: "blocked", kind: "question", msg: "answer: which?", updated_at: AT },
				{ id: "agent-1", title: "sub", state: "working", updated_at: AT },
			],
		},
		{ name: "card-b", block: "block:b", label: SESSION, argv0: "-fish", records: [{ state: "idle", updated_at: AT }] },
		{ name: "card-c", block: "block:c", label: SESSION, argv0: "claude" },
	]);

	const listed = await createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		redrawMs: 0,
	}).list();

	expect(listed).toEqual([
		{
			name: "card-a",
			status: { state: "blocked", kind: "question", msg: "answer: which?" },
			seq: AT_US,
			sessionId: SESSION,
		},
		{ name: "card-b", sessionId: SESSION },
		{ name: "card-c", sessionId: SESSION },
	]);
});

test("onStatus reports root records off the event stream, one per observation", async () => {
	const block: Block = { name: "card-a", block: "block:a", label: SESSION, argv0: "claude", records: [] };
	const fake = rex([block, { name: "shell", block: "block:s", argv0: "-fish" }]);
	const port = createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR });
	const seen: AgentStatusEvent[] = [];
	const off = port.onStatus((event) => seen.push(event));
	await settle();
	const reads = () => fake.methods().filter((method) => method.endsWith(".program_status")).length;
	const readAtListen = reads();

	const working = { state: "working", app: "claude-code", updated_at: AT };
	fake.emit(fake.status("block:a", working));
	fake.emit(fake.status("block:a", working));
	fake.emit(fake.status("block:a", { state: "working", updated_at: AT }, "agent-1"));
	fake.emit(fake.status("block:s", { state: "idle", updated_at: AT }));
	fake.emit(fake.status("block:a", { state: "done", updated_at: "2026-10-27T01:02:04Z" }));
	await settle();

	expect(seen).toEqual([
		{ agent: "card-a", status: { state: "working" }, seq: AT_US },
		{ agent: "card-a", status: { state: "done" }, seq: Date.parse("2026-10-27T01:02:04Z") * 1000 },
	]);
	// Read once when the listener attached, never polled after.
	expect(reads()).toBe(readAtListen);
	off();
	fake.emit(fake.status("block:a", { state: "idle", updated_at: "2026-10-27T01:02:05Z" }));
	await settle();
	expect(seen).toHaveLength(2);
});

test("onStatus re-reads each block's program_status once after a reconnect", async () => {
	const block: Block = { name: "card-a", block: "block:a", label: SESSION, argv0: "claude", records: [] };
	const fake = rex([block]);
	const seen: AgentStatusEvent[] = [];
	createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR }).onStatus((event) =>
		seen.push(event),
	);
	await settle();
	const reads = () => fake.methods().filter((method) => method.endsWith(".program_status")).length;
	const before = reads();

	block.records = [{ state: "done", updated_at: AT }];
	fake.reconnect();
	await settle();

	expect(reads()).toBe(before + 1);
	expect(seen).toEqual([{ agent: "card-a", status: { state: "done" }, seq: AT_US }]);
});

test("onStatus drops a report older than one a resync already emitted", async () => {
	const block: Block = { name: "card-a", block: "block:a", label: SESSION, argv0: "claude", records: [] };
	const fake = rex([block]);
	const seen: AgentStatusEvent[] = [];
	createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR }).onStatus((event) =>
		seen.push(event),
	);
	await settle();
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const original = fake.client.call.bind(fake.client);
	fake.client.call = async (method, payload, schema) => {
		if (method.endsWith(".program_status")) await held;
		return original(method, payload, schema);
	};

	// The resync reads the newer record while the event for an older one is still on its way, so it queues behind.
	block.records = [{ state: "idle", updated_at: "2026-10-27T01:02:05Z" }];
	fake.reconnect();
	await settle();
	fake.emit(fake.status("block:a", { state: "working", updated_at: "2026-10-27T01:02:04Z" }));
	release();
	await settle();
	await settle();

	expect(seen).toEqual([
		{ agent: "card-a", status: { state: "idle" }, seq: Date.parse("2026-10-27T01:02:05Z") * 1000 },
	]);
});

test("prompt pastes the text and presses \\r, and presses it once more when claude is still idle", async () => {
	const fake = rex([
		{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude", records: [{ state: "idle", updated_at: AT }] },
	]);

	await createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR, confirmMs: 10 }).prompt(
		"card-a",
		"line 1\nline 2",
	);

	const sent = fake.calls.filter((call) => call.method === "block.event" || call.method.endsWith(".write"));
	expect(sent).toEqual([
		{
			method: "block.event",
			payload: {
				session_id: HANGAR,
				block_id: "block:a",
				event: { type: "paste", payload: { text: "line 1\nline 2" } },
			},
		},
		{
			method: "com.superlogical.terminal.write",
			payload: { session_id: HANGAR, block_id: "block:a", args: { data: "\r" } },
		},
		{
			method: "com.superlogical.terminal.write",
			payload: { session_id: HANGAR, block_id: "block:a", args: { data: "\r" } },
		},
	]);
});

test("prompt presses \\r only once when claude turns working", async () => {
	const fake = rex([
		{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude", records: [{ state: "done", updated_at: AT }] },
	]);
	const original = fake.client.call.bind(fake.client);
	fake.client.call = async (method, payload, schema) => {
		const result = await original(method, payload, schema);
		if (method === "com.superlogical.terminal.write")
			fake.emit(fake.status("block:a", { state: "working", updated_at: AT }));
		return result;
	};

	await createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		confirmMs: 1_000,
	}).prompt("card-a", "go");

	expect(fake.methods().filter((method) => method.endsWith(".write"))).toHaveLength(1);
});

test("prompt does not press \\r again when claude goes from idle straight to blocked", async () => {
	const block: Block = {
		name: "card-a",
		block: "block:a",
		label: SESSION,
		argv0: "claude",
		records: [{ state: "idle", updated_at: AT }],
	};
	const fake = rex([block]);
	const original = fake.client.call.bind(fake.client);
	fake.client.call = async (method, payload, schema) => {
		const result = await original(method, payload, schema);
		if (method === "com.superlogical.terminal.write") {
			block.records = [{ state: "blocked", kind: "permission", updated_at: "2026-10-27T01:02:04Z" }];
			fake.emit(fake.status("block:a", block.records[0] as object));
		}
		return result;
	};

	await createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR, confirmMs: 10 }).prompt(
		"card-a",
		"go",
	);

	expect(fake.methods().filter((method) => method.endsWith(".write"))).toHaveLength(1);
});

test("prompt does not press \\r again when the status cannot be read", async () => {
	const block: Block = {
		name: "card-a",
		block: "block:a",
		label: SESSION,
		argv0: "claude",
		records: [{ state: "idle", updated_at: AT }],
	};
	const fake = rex([block]);
	const original = fake.client.call.bind(fake.client);
	fake.client.call = async (method, payload, schema) => {
		const result = await original(method, payload, schema);
		if (method === "com.superlogical.terminal.write") block.records = [];
		return result;
	};

	await createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR, confirmMs: 10 }).prompt(
		"card-a",
		"go",
	);

	expect(fake.methods().filter((method) => method.endsWith(".write"))).toHaveLength(1);
});

test.each([
	["blocked", [{ state: "blocked", kind: "permission", updated_at: AT }], true],
	["working", [{ state: "working", updated_at: AT }], true],
	["without a status record", [], false],
])(
	"prompt refuses without typing anything when claude is %s, as busy only in a turn or on a prompt",
	async (state, records, busy) => {
		const fake = rex([{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude", records }]);

		const prompted = createRexAgentPort({
			processStart: unstarted,
			client: fake.client,
			sessionId: HANGAR,
			confirmMs: 10,
		}).prompt("card-a", "go");

		await expect(prompted).rejects.toThrow(`rex agent card-a is ${state}`);
		await expect(prompted).rejects.toBeInstanceOf(PromptRefused);
		await expect(prompted).rejects.toMatchObject({ busy });

		expect(fake.methods().filter((method) => method === "block.event" || method.endsWith(".write"))).toEqual([]);
	},
);

test("prompt that fails after the paste does not call it a refusal", async () => {
	const fake = rex([
		{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude", records: [{ state: "idle", updated_at: AT }] },
	]);
	const original = fake.client.call.bind(fake.client);
	fake.client.call = async (method, payload, schema) => {
		if (method === "com.superlogical.terminal.write") throw new Error("rex connection lost");
		return original(method, payload, schema);
	};

	const prompted = createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		confirmMs: 10,
	}).prompt("card-a", "go");

	await expect(prompted).rejects.toThrow("rex connection lost");
	await expect(prompted).rejects.not.toBeInstanceOf(PromptRefused);
	expect(fake.methods().filter((method) => method === "block.event")).toHaveLength(1);
});

const projects = mkdtempSync(join(tmpdir(), "soma-rex-projects-"));
afterAll(() => rmSync(projects, { recursive: true, force: true }));

test("readResult reads the last reply off the transcript of the session id the block was started with", async () => {
	const cwd = "/nonexistent/repo/.claude/worktrees/card-a";
	mkdirSync(join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true });
	writeFileSync(
		join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${SESSION}.jsonl`),
		`${JSON.stringify({ type: "assistant", uuid: "a-1", message: { id: "msg_1", content: [{ type: "text", text: "結果：完成" }] } })}\n`,
	);
	const fake = rex([{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude", cwd }]);

	const result = await createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		projectsDir: projects,
	}).readResult("card-a");

	expect(result).toEqual({ id: "a-1", text: "結果：完成" });
});

test("readResult of a closed window reads the transcript its session left, and is undefined for one never seen", async () => {
	const { cwd } = transcript([user("go"), reply("msg_1", "結果：完成")]);
	const blocks: Block[] = [{ name: "card-k", block: "block:k", label: SESSION, argv0: "claude", cwd }];
	const fake = rex(blocks);
	const port = createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		projectsDir: projects,
	});
	expect(await port.readResult("card-k")).toEqual({ id: "a-msg_1", text: "結果：完成" });

	// A reclaim closes the window once its turn was read; the digest reads the turn again later.
	blocks.splice(0);
	expect(await port.readResult("card-k")).toEqual({ id: "a-msg_1", text: "結果：完成" });
	// As after a restart: this process never saw the window.
	const fresh = createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR });
	expect(await fresh.readResult("card-k")).toBeUndefined();
});

/**
 * Feeds the watch a turn of `block` that ended at `at`: a working, then the done rex has on record from then on.
 * Returns the watch's unsubscribe.
 */
async function turnOver(fake: ReturnType<typeof rex>, port: AgentPort, block: Block, at: string): Promise<() => void> {
	const seen: AgentStatusEvent[] = [];
	const off = port.onStatus((event) => seen.push(event));
	await settle();
	fake.emit(fake.status(block.block, { state: "working", updated_at: new Date(Date.parse(at) - 1_000).toISOString() }));
	block.records = [{ state: "done", updated_at: at }];
	fake.emit(fake.status(block.block, { state: "done", updated_at: at }));
	await until(() => seen.at(-1)?.status.state === "done");
	return off;
}

/** A transcript for a fresh worktree of `projects`, holding `records`, and the cwd claude runs in to write it. */
function transcript(records: object[]) {
	const cwd = `/nonexistent/repo/.claude/worktrees/card-${Math.random().toString(36).slice(2)}`;
	const path = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${SESSION}.jsonl`);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, records.map(line).join(""));
	return { cwd, path };
}
const line = (value: object) => `${JSON.stringify(value)}\n`;
const reply = (id: string, text: string) => ({
	type: "assistant",
	uuid: `a-${id}`,
	message: { id, content: [{ type: "text", text }] },
});
const user = (content: string) => ({ type: "user", uuid: `u-${content}`, message: { role: "user", content } });

test.each([
	["a later turn", [user("go")]],
	["the first turn, before any of it is written", [{ type: "mode", mode: "default" }]],
	["a later turn, before any of it is written", [user("earlier"), reply("msg_1", "earlier")]],
])("readResult waits for a reply claude reported done before writing it: %s", async (_turn, before) => {
	const { cwd, path } = transcript(before);
	const block: Block = { name: "card-b", block: "block:b", label: SESSION, argv0: "claude", cwd, records: [] };
	const fake = rex([block]);
	const port = createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		projectsDir: projects,
	});
	// claude reports done a moment after the file was last written, and writes the turn only after that.
	const off = await turnOver(fake, port, block, new Date(Date.now() + 20).toISOString());
	setTimeout(() => writeFileSync(path, line(user("go")) + line(reply("msg_2", "結果：完成")), { flag: "a" }), 150);

	expect(await port.readResult("card-b")).toEqual({ id: "a-msg_2", text: "結果：完成" });
	off();
});

test("readResult is the transcript's last record after replyMs when nothing was written since the turn ended", async () => {
	const { cwd } = transcript([user("go"), reply("msg_1", "earlier")]);
	const block: Block = { name: "card-c", block: "block:c", label: SESSION, argv0: "claude", cwd, records: [] };
	const fake = rex([block]);
	const port = createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		projectsDir: projects,
		replyMs: 150,
	});
	// claude reported the turn a minute after it last wrote the transcript.
	const off = await turnOver(fake, port, block, new Date(Date.now() + 60_000).toISOString());

	// The core holds this id already, so the turn it could not read is not recorded under the turn before's.
	const asked = Date.now();
	expect(await port.readResult("card-c")).toEqual({ id: "a-msg_1", text: "earlier" });
	expect(Date.now() - asked).toBeGreaterThanOrEqual(140);
	expect(Date.now() - asked).toBeLessThan(400);
	off();
});

test("readResult names a turn that ended on the user by its last record after replyMs, without text", async () => {
	const { cwd, path } = transcript([user("go"), reply("msg_1", "earlier")]);
	const block: Block = { name: "card-g", block: "block:g", label: SESSION, argv0: "claude", cwd, records: [] };
	const fake = rex([block]);
	const port = createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		projectsDir: projects,
		replyMs: 150,
	});
	const off = await turnOver(fake, port, block, new Date(Date.now() + 20).toISOString());
	// The human interrupts the turn: claude writes the prompt and the interruption, and no reply ever.
	setTimeout(
		() => writeFileSync(path, line(user("go2")) + line(user("[Request interrupted by user]")), { flag: "a" }),
		50,
	);

	const asked = Date.now();
	expect(await port.readResult("card-g")).toEqual({ id: "u-[Request interrupted by user]" });
	expect(Date.now() - asked).toBeGreaterThanOrEqual(140);
	expect(Date.now() - asked).toBeLessThan(400);
	off();
});

test("readResult answers a re-stamp of the record that ended the turn with its reply at once", async () => {
	// The turn ended a second ago, and claude wrote its reply since.
	const ended = new Date(Date.now() - 1_000).toISOString();
	const { cwd } = transcript([user("go"), reply("msg_1", "結果：需要你")]);
	const block: Block = { name: "card-e", block: "block:e", label: SESSION, argv0: "claude", cwd, records: [] };
	const fake = rex([block]);
	const seen: AgentStatusEvent[] = [];
	const port = createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		projectsDir: projects,
	});
	const offTurn = await turnOver(fake, port, block, ended);
	const off = port.onStatus((event) => seen.push(event));
	expect(await port.readResult("card-e")).toEqual({ id: "a-msg_1", text: "結果：需要你" });

	// rex re-stamps the done a minute on, with no working in between: no new turn, so nothing is waited for.
	const restamp = { state: "done", updated_at: new Date(Date.now() + 59_000).toISOString() };
	block.records = [restamp];
	fake.emit(fake.status("block:e", restamp));
	await until(() => seen.length > 0);
	const asked = Date.now();
	expect(await port.readResult("card-e")).toEqual({ id: "a-msg_1", text: "結果：需要你" });
	expect(Date.now() - asked).toBeLessThan(500);
	off();
	offTurn();
});

test("readResult reads at once a turn whose start the watch never saw, as at the startup reconcile", async () => {
	const { cwd } = transcript([reply("msg_1", "結果：完成")]);
	// rex's record is a minute newer than the transcript, as after a re-stamp while soma was down.
	const records = [{ state: "done", updated_at: new Date(Date.now() + 60_000).toISOString() }];
	const fake = rex([{ name: "card-f", block: "block:f", label: SESSION, argv0: "claude", cwd, records }]);
	const port = createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		projectsDir: projects,
	});
	const ask = async () => {
		const asked = Date.now();
		expect(await port.readResult("card-f")).toEqual({ id: "a-msg_1", text: "結果：完成" });
		expect(Date.now() - asked).toBeLessThan(500);
	};

	await ask();
	// A watch that opened on the done saw no working before it.
	const seen: AgentStatusEvent[] = [];
	const off = port.onStatus((event) => seen.push(event));
	await until(() => seen.length > 0);
	await ask();
	off();
});

test("readResult waits for the turn a resync read the end of, though the working came after it, not the turn before", async () => {
	const { cwd, path } = transcript([user("go"), reply("msg_1", "one")]);
	const block: Block = { name: "card-h", block: "block:h", label: SESSION, argv0: "claude", cwd, records: [] };
	const fake = rex([block]);
	const port = createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		projectsDir: projects,
	});
	const seen: AgentStatusEvent[] = [];
	const off = port.onStatus((event) => seen.push(event));
	await settle();
	const at = (ms: number) => new Date(Date.now() + ms).toISOString();
	fake.emit(fake.status("block:h", { state: "working", updated_at: at(-3_000) }));
	block.records = [{ state: "done", updated_at: at(-2_000) }];
	fake.emit(fake.status("block:h", { state: "done", updated_at: at(-2_000) }));
	await until(() => seen.at(-1)?.status.state === "done");

	// Turn 2 starts and ends while the connection is down: the resync reads its done, and its working queues behind.
	block.records = [{ state: "done", updated_at: at(20) }];
	fake.reconnect();
	fake.emit(fake.status("block:h", { state: "working", updated_at: at(-500) }));
	await until(() => seen.length === 3);
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(seen.map((event) => event.status.state)).toEqual(["working", "done", "done"]);
	// claude writes turn 2 a moment after it reported it over.
	setTimeout(() => writeFileSync(path, line(user("go2")) + line(reply("msg_2", "two")), { flag: "a" }), 150);

	expect(await port.readResult("card-h")).toEqual({ id: "a-msg_2", text: "two" });
	off();
});

test("readResult asked at a resync's done waits for the working queued behind a slow resync of another block", async () => {
	const { cwd, path } = transcript([user("go"), reply("msg_1", "one")]);
	const block: Block = { name: "card-y", block: "block:y", label: SESSION, argv0: "claude", cwd, records: [] };
	// A block whose prompt never parses, so the resync reads its screen again and again.
	const other: Block = {
		name: "card-x",
		block: "block:x",
		label: SESSION,
		argv0: "claude",
		records: [],
		screen: "nothing",
	};
	const fake = rex([block, other]);
	const call = fake.client.call.bind(fake.client);
	fake.client.call = async (method, payload, schema) => {
		await new Promise((resolve) => setTimeout(resolve, 5));
		return call(method, payload, schema);
	};
	const port = createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		projectsDir: projects,
		redrawMs: 200,
	});
	const seen: AgentStatusEvent[] = [];
	let read: Promise<AgentResult | undefined> | undefined;
	// As the bridge does: the read is asked for as the event arrives.
	const off = port.onStatus((event) => {
		if (event.agent !== "card-y") return;
		seen.push(event);
		if (seen.length === 3) read = port.readResult("card-y");
	});
	await new Promise((resolve) => setTimeout(resolve, 100));
	const at = (ms: number) => new Date(Date.now() + ms).toISOString();
	fake.emit(fake.status("block:y", { state: "working", updated_at: at(-3_000) }));
	block.records = [{ state: "done", updated_at: at(-2_000) }];
	fake.emit(fake.status("block:y", { state: "done", updated_at: at(-2_000) }));
	await until(() => seen.length === 2);

	// Turn 2 starts and ends while the connection is down; the other block is blocked by then.
	other.records = [{ state: "blocked", kind: "permission", msg: "approve", updated_at: at(-100) }];
	block.records = [{ state: "done", updated_at: at(20) }];
	fake.reconnect();
	fake.emit(fake.status("block:y", { state: "working", updated_at: at(-500) }));
	setTimeout(() => writeFileSync(path, line(user("go2")) + line(reply("msg_2", "two")), { flag: "a" }), 150);
	await until(() => read !== undefined);

	expect(await read).toEqual({ id: "a-msg_2", text: "two" });
	off();
});

test("readResult does not wait for watch work queued after it was asked", async () => {
	const { cwd } = transcript([user("go"), reply("msg_1", "one")]);
	const block: Block = { name: "card-y", block: "block:y", label: SESSION, argv0: "claude", cwd, records: [] };
	const other: Block = {
		name: "card-x",
		block: "block:x",
		label: SESSION,
		argv0: "claude",
		records: [],
		screen: "nothing",
	};
	const fake = rex([block, other]);
	const port = createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		projectsDir: projects,
		redrawMs: 200,
		replyMs: 300,
	});
	const seen: AgentStatusEvent[] = [];
	const off = port.onStatus((event) => {
		if (event.agent === "card-y") seen.push(event);
	});
	await new Promise((resolve) => setTimeout(resolve, 100));
	const at = (ms: number) => new Date(Date.now() + ms).toISOString();
	fake.emit(fake.status("block:y", { state: "working", updated_at: at(-3_000) }));
	block.records = [{ state: "done", updated_at: at(-2_000) }];
	fake.emit(fake.status("block:y", { state: "done", updated_at: at(-2_000) }));
	await until(() => seen.length === 2);

	// The other block's prompt never parses, and rex re-sends its record faster than its screen is read three times.
	let n = 0;
	const report = () => {
		const record = { state: "blocked", kind: "permission", msg: `approve ${n++}`, updated_at: at(0) };
		other.records = [record];
		fake.emit(fake.status("block:x", record));
	};
	report();
	const busy = setInterval(report, 300);
	try {
		const asked = Date.now();
		expect(await port.readResult("card-y")).toEqual({ id: "a-msg_1", text: "one" });
		expect(Date.now() - asked).toBeLessThan(1_500);
	} finally {
		clearInterval(busy);
		off();
	}
});

test.each([
	["a resync read across a gap that swallowed its working", "resync"],
	["a done whose working the watch missed", "event"],
] as const)("readResult reads at once, not against the turn before's end, %s", async (_case, how) => {
	// The turn before ended on the user, so a read against its end would wait out replyMs.
	const { cwd } = transcript([user("go"), user("[Request interrupted by user]")]);
	const block: Block = { name: "card-i", block: "block:i", label: SESSION, argv0: "claude", cwd, records: [] };
	const fake = rex([block]);
	const port = createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		projectsDir: projects,
		replyMs: 300,
	});
	const off = await turnOver(fake, port, block, new Date(Date.now() - 1_000).toISOString());
	const seen: AgentStatusEvent[] = [];
	const offSeen = port.onStatus((event) => seen.push(event));
	const done = { state: "done", updated_at: new Date(Date.now() + 60_000).toISOString() };
	block.records = [done];
	if (how === "resync") fake.reconnect();
	else fake.emit(fake.status("block:i", done));
	await until(() => seen.length > 0);

	const asked = Date.now();
	expect(await port.readResult("card-i")).toEqual({ id: "u-[Request interrupted by user]" });
	expect(Date.now() - asked).toBeLessThan(150);
	offSeen();
	off();
});

test("readResult waits at most 2 s by default", async () => {
	let clock = 0;
	// A session no transcript was written for.
	const label = "7a1d2c3b-0000-4000-8000-000000000000";
	const block: Block = { name: "card-d", block: "block:d", label, argv0: "claude", cwd: "/nonexistent/none" };
	const fake = rex([block]);
	const port = createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		projectsDir: projects,
		// Each look at the clock is 400 ms on: no transcript is ever found, so the wait runs to its end.
		now: () => (clock += 400),
	});
	const off = await turnOver(fake, port, block, AT);
	clock = 0;

	expect(await port.readResult("card-d")).toBeUndefined();
	expect(clock).toBeGreaterThanOrEqual(2_000);
	expect(clock).toBeLessThanOrEqual(400 + 2_000 + 400);
	off();
});

test("stop closes the agent's block", async () => {
	const fake = rex([{ name: "card-a", block: "block:a", label: SESSION }]);

	await createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR }).stop("card-a");

	expect(fake.calls.at(-1)).toEqual({ method: "block.close", payload: { session_id: HANGAR, block_id: "block:a" } });
});

test("readScreen reads the agent's block in the hangar at every call, whatever its status says", async () => {
	const block: Block = {
		name: "card-a",
		block: "block:a",
		label: SESSION,
		argv0: "claude",
		records: [{ state: "done", updated_at: AT }],
		screen: "● Done: the tests pass.",
	};
	const fake = rex([{ name: "card-b", block: "block:b", label: SESSION, argv0: "claude", screen: "other" }, block]);
	const port = createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR });

	expect(await port.readScreen("card-a")).toBe("● Done: the tests pass.");
	// The human answered the agent at its pane since: the next read shows the new turn, not the done one.
	block.screen = "● Done: the tests pass.\n> also open the PR\n✻ Working…";
	expect(await port.readScreen("card-a")).toBe("● Done: the tests pass.\n> also open the PR\n✻ Working…");

	const reads = fake.calls.filter((call) => call.method === "com.superlogical.terminal.format");
	expect(reads.map((call) => call.payload)).toEqual(
		Array(2).fill({ session_id: HANGAR, block_id: "block:a", args: { format: "text", trim: true, max_bytes: 65_536 } }),
	);
	// Read only: nothing typed or pressed.
	expect(fake.methods().filter((method) => method.endsWith(".write") || method === "block.event")).toEqual([]);
});

test("readScreen reads the shell left in the block once claude exited, and refuses a name with no window", async () => {
	const fake = rex([{ name: "card-a", block: "block:a", label: SESSION, argv0: "-fish", screen: "$ " }]);
	const port = createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR });

	expect(await port.readScreen("card-a")).toBe("$ ");
	await expect(port.readScreen("card-z")).rejects.toThrow(`rex hangar ${HANGAR} has no window named card-z`);
});

test("readScreen reads only the tail of a scrollback too long for one reply", async () => {
	const fake = rex([{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude" }]);
	const original = fake.client.call.bind(fake.client);
	fake.client.call = async (method, payload, schema) => {
		if (method.endsWith(".format")) return schema.parse({ content: "old output", id: 7, total: 200_000, eof: false });
		if (method.endsWith(".blob_read")) {
			const offset = (payload as { args: { offset: number } }).args.offset;
			return schema.parse(
				offset < 200_000 - 1_000
					? { id: 7, data: "x".repeat(65_536 - 1_000), total: 200_000, eof: false }
					: { id: 7, data: "\nthe last line", total: 200_000, eof: true },
			);
		}
		return original(method, payload, schema);
	};

	const text = await createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR }).readScreen(
		"card-a",
	);

	expect(text).not.toContain("old output");
	expect(text.endsWith("\nthe last line")).toBe(true);
});

/** A session of its own that claude ran in `cwd`, with the projects directory holding only its transcript. */
function resumable(cwd: string) {
	const session = "5b1c0d2e-3f40-4a51-8b62-7c83d94e0a15";
	const dir = mkdtempSync(join(tmpdir(), "soma-rex-resume-"));
	mkdirSync(join(dir, cwd.replace(/[^a-zA-Z0-9]/g, "-")));
	writeFileSync(
		join(dir, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${session}.jsonl`),
		[
			{ type: "session-owner", sessionId: session },
			{ ...user("go"), cwd, sessionId: session },
		]
			.map(line)
			.join(""),
	);
	return { session, projectsDir: dir, request: { name: "card-a", card: "card-a", sessionId: session } };
}
const worktree = mkdtempSync(join(tmpdir(), "soma-rex-worktree-"));
afterAll(() => rmSync(worktree, { recursive: true, force: true }));

test("resume types claude --resume <id> with a dispatch's environment, in the directory the session ran in, past a full cap", async () => {
	const { session, projectsDir, request: resumed } = resumable(worktree);
	// Both slots taken by claude: a start would be refused.
	const fake = rex([
		{ name: "card-b", block: "block:b", label: SESSION, argv0: "claude" },
		{ name: "card-c", block: "block:c", label: SESSION, argv0: "claude" },
	]);
	const { git: run, runs } = git();
	const env = { SOMA_SOCKET: "/run/soma.sock", SOMA_NODE: "/opt/node/bin/node" };
	const port = createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		git: run,
		projectsDir,
		cap: 2,
		env,
		path: "/opt/soma/bin",
	});
	await expect(port.start(request)).rejects.toThrow("hangar is full");

	await port.resume(resumed);

	const dispatched = launchCommand({ ...request, sessionId: session }, env, "/opt/soma/bin");
	expect(dispatched).toMatch(/ claude --session-id /);
	const typed = dispatched.replace(" claude --session-id ", " claude --resume ");
	expect(typed).toBe(
		`SOMA_SOCKET='/run/soma.sock' SOMA_NODE='/opt/node/bin/node' SOMA_AGENT='card-a' PATH='/opt/soma/bin':"$PATH" claude --resume ${session}\n`,
	);
	expect(fake.calls.filter((call) => call.method === "session.new_window").map((call) => call.payload)).toEqual([
		{
			session_id: HANGAR,
			window_label: "card-a",
			focus: false,
			layout: {
				block: {
					flavor: "com.superlogical.terminal.shell",
					label: session,
					options: { cwd: worktree, initial_input: typed },
				},
			},
		},
	]);
	// No worktree is made, and the claude blocks the cap counts were never looked at for the resume.
	expect(runs).toEqual([]);
	const afterStart = fake.calls.findLastIndex((call) => call.method === "com.superlogical.terminal.process");
	expect(fake.calls.slice(afterStart + 1).map((call) => call.method)).toEqual(["session.view", "session.new_window"]);
	rmSync(projectsDir, { recursive: true, force: true });
});

test("resume refuses, and opens no window, a session whose directory is gone, one with no transcript, or a name already open", async () => {
	const gone = resumable(join(worktree, "removed"));
	const open = resumable(worktree);
	const cases = [
		{
			...gone,
			blocks: [],
			error: `the worktree ${join(worktree, "removed")} claude session ${gone.session} ran in no longer exists`,
		},
		{ ...open, projectsDir: worktree, blocks: [], error: `no transcript of claude session ${open.session}` },
		{ ...open, blocks: [{ name: "card-a", block: "block:a" }], error: "already has a window named card-a" },
		{ ...open, request: { ...open.request, sessionId: "x; rm -rf ~" }, blocks: [], error: "not a claude session id" },
	];
	for (const { projectsDir, request: resumed, blocks, error } of cases) {
		const fake = rex(blocks);
		const port = createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR, projectsDir });

		await expect(port.resume(resumed)).rejects.toThrow(error);
		expect(fake.methods()).not.toContain("session.new_window");
	}
	for (const { projectsDir } of [gone, open]) rmSync(projectsDir, { recursive: true, force: true });
});

const BASH = fixture("claude-bash-prompt-2.1.302.txt");
const TRUST = fixture("claude-trust-dialog-2.1.302.txt");
const fingerprintOf = (screen: string) => readBlockedScreen(screen).prompt?.fingerprint as string;
const blocked = [{ state: "blocked", kind: "permission", updated_at: AT }];
const keys = (fake: ReturnType<typeof rex>) =>
	fake.calls
		.filter((call) => call.method === "block.event")
		.map((call) => {
			const { block_id, event } = call.payload as { block_id: string; event: { type: string; payload: object } };
			const { key, text, action } = event.payload as { key: string; text: string; action: string };
			return { block_id, type: event.type, key, text, action };
		});

async function respond(block: Omit<Block, "name" | "block">, option: string, fingerprint: string) {
	const fake = rex([{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude", ...block }]);
	const port = createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR, keyGapMs: 0 });
	return { outcome: await port.respond("card-a", { option, fingerprint }), fake };
}

test("respond refuses not_blocked off a fresh read, before reading the screen", async () => {
	for (const block of [
		{ records: [{ state: "idle", updated_at: AT }], screen: BASH },
		{ records: [{ state: "working", updated_at: AT }], screen: BASH },
		// No record and no trust dialog on screen: claude is starting up, or a prompt it never reported.
		{ records: [], screen: BASH },
		// No record and no claude: a shell, whatever its screen shows.
		{ argv0: "-fish", records: [], screen: TRUST },
	]) {
		const { outcome, fake } = await respond(block, "1", fingerprintOf(BASH));
		expect(outcome).toEqual({ sent: false, refusal: "not_blocked" });
		expect(keys(fake)).toEqual([]);
	}
});

test("respond refuses auth, unreadable, stale and unknown_option off the screen read through rex", async () => {
	const cases = [
		[{ screen: fixture("claude-custom-api-key-2.1.302.txt") }, "1", "f", "auth"],
		[{ screen: "nothing anyone can answer" }, "1", "f", "unreadable"],
		[{ screen: BASH }, "1", "0123456789abcdef", "stale"],
		[{ screen: BASH }, "9", fingerprintOf(BASH), "unknown_option"],
	] as const;
	for (const [block, option, fingerprint, refusal] of cases) {
		const { outcome, fake } = await respond({ records: blocked, ...block }, option, fingerprint);
		expect(outcome).toEqual({ sent: false, refusal });
		expect(fake.methods()).toContain("com.superlogical.terminal.format");
		expect(keys(fake)).toEqual([]);
	}
});

test("respond presses the option's digit on a numbered prompt", async () => {
	const { outcome, fake } = await respond({ records: blocked, screen: BASH }, "1", fingerprintOf(BASH));

	expect(outcome).toEqual({ sent: true });
	expect(keys(fake)).toEqual([
		{ block_id: "block:a", type: "key", key: "digit_1", text: "1", action: "press" },
		{ block_id: "block:a", type: "key", key: "digit_1", text: "1", action: "release" },
	]);
	expect(fake.calls.find((call) => call.method.endsWith(".format"))?.payload).toEqual({
		session_id: HANGAR,
		block_id: "block:a",
		args: { format: "text", trim: true, max_bytes: 65_536 },
	});
});

test("respond answers the trust dialog that has no record, travelling from the cursor", async () => {
	const { outcome, fake } = await respond({ records: [], screen: TRUST }, "2", fingerprintOf(TRUST));

	expect(outcome).toEqual({ sent: true });
	expect(keys(fake).map(({ key, action }) => `${key}:${action}`)).toEqual([
		"arrow_down:press",
		"arrow_down:release",
		"enter:press",
		"enter:release",
	]);
});

describe("an answer that needs an arrow", () => {
	const pressedOf = (fake: ReturnType<typeof rex>) =>
		keys(fake).flatMap(({ key, action }) => (action === "press" ? [key] : []));
	const answerYes = { option: "2", fingerprint: fingerprintOf(TRUST) };
	const dialog = (): Block => ({
		name: "card-a",
		block: "block:a",
		label: SESSION,
		argv0: "claude",
		records: [],
		screen: TRUST,
	});
	const answering = (fake: ReturnType<typeof rex>) =>
		createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR, keyGapMs: 0 });
	const onYes = (block: Block) => /❯ Yes, I trust this folder/.test(block.screen ?? "");

	test("the arrow the pane drops gets no Enter, and the next answer travels from a fresh read", async () => {
		const block = dialog();
		const fake = rex([block]);
		let dropped = false;
		let enteredOn: boolean | undefined;
		fake.replace("block.event", (payload) => {
			const { key, action } = (payload.event as { payload: { key: string; action: string } }).payload;
			if (key === "arrow_down" && !dropped) {
				if (action === "release") dropped = true;
				return {};
			}
			if (key === "enter" && action === "press") enteredOn = onYes(block);
			return fake.original("block.event")(payload);
		});
		const port = answering(fake);

		expect(await port.respond("card-a", answerYes)).toEqual({ sent: false, refusal: "unreadable" });
		expect(pressedOf(fake)).toEqual(["arrow_down"]);

		expect(await port.respond("card-a", answerYes)).toEqual({ sent: true });
		expect(pressedOf(fake)).toEqual(["arrow_down", "arrow_down", "enter"]);
		expect(enteredOn).toBe(true);
	});

	test("a screen that never shows the cursor on the option gets no Enter, after a bounded number of reads", async () => {
		const fake = rex([dialog()]);
		fake.replace("block.event", () => ({}));

		expect(await answering(fake).respond("card-a", answerYes)).toEqual({ sent: false, refusal: "unreadable" });

		expect(pressedOf(fake)).toEqual(["arrow_down"]);
		expect(fake.methods().filter((method) => method.endsWith(".format")).length).toBeLessThanOrEqual(11);
	});

	test("a cursor seen on the option and then put back gets no Enter", async () => {
		const block = dialog();
		const fake = rex([block]);
		const format = "com.superlogical.terminal.format";
		fake.replace(format, (payload) => {
			const read = fake.original(format)(payload);
			// Claude Code puts the cursor back as it redraws a dialog it has just drawn.
			block.screen = TRUST;
			return read;
		});

		expect(await answering(fake).respond("card-a", answerYes)).toEqual({ sent: false, refusal: "unreadable" });

		expect(pressedOf(fake)).toEqual(["arrow_down"]);
	});

	test("another prompt drawn while the cursor is awaited is stale, and gets no Enter", async () => {
		const block = dialog();
		const fake = rex([block]);
		fake.replace("block.event", () => {
			block.screen = BASH;
			return {};
		});

		expect(await answering(fake).respond("card-a", answerYes)).toEqual({ sent: false, refusal: "stale" });

		expect(pressedOf(fake)).toEqual(["arrow_down"]);
	});

	test("an arrow travelling up gets its Enter once the cursor is on the option", async () => {
		const block = { ...dialog(), screen: TRUST.replace("❯ No, exit", "  No, exit").replace("  Yes, I", "❯ Yes, I") };
		const fake = rex([block]);

		expect(await answering(fake).respond("card-a", { ...answerYes, option: "1" })).toEqual({ sent: true });

		expect(pressedOf(fake)).toEqual(["arrow_up", "enter"]);
		expect(block.screen).toMatch(/❯ No, exit/);
	});
});

test("respond reads only the tail of a scrollback too long for one reply", async () => {
	const fake = rex([{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude", records: blocked }]);
	const original = fake.client.call.bind(fake.client);
	const reads: unknown[] = [];
	fake.client.call = async (method, payload, schema) => {
		if (method.endsWith(".format")) return schema.parse({ content: "old output", id: 7, total: 200_000, eof: false });
		if (method.endsWith(".blob_read")) {
			reads.push((payload as { args: unknown }).args);
			const offset = (payload as { args: { offset: number } }).args.offset;
			return schema.parse(
				offset < 200_000 - 1_000
					? { id: 7, data: "x".repeat(65_536 - 1_000), total: 200_000, eof: false }
					: { id: 7, data: BASH, total: 200_000, eof: true },
			);
		}
		return original(method, payload, schema);
	};

	const outcome = await createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		keyGapMs: 0,
	}).respond("card-a", {
		option: "1",
		fingerprint: fingerprintOf(BASH),
	});

	expect(outcome).toEqual({ sent: true });
	expect(reads).toEqual([
		{ id: 7, offset: 200_000 - 65_536 },
		{ id: 7, offset: 200_000 - 1_000 },
	]);
});

test("a blocked record carries the prompt read off the screen, whose fingerprint respond then answers", async () => {
	const block: Block = { name: "card-a", block: "block:a", label: SESSION, argv0: "claude", records: [], screen: BASH };
	const fake = rex([block]);
	const port = createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR, keyGapMs: 0 });
	const seen: AgentStatusEvent[] = [];
	const off = port.onStatus((event) => seen.push(event));
	await settle();

	block.records = [{ state: "blocked", kind: "permission", msg: "approve Bash: ls", updated_at: AT }];
	fake.emit(fake.status("block:a", block.records[0] as object));
	await until(() => seen.length > 0);
	off();
	const { kind, msg, prompt } = readBlockedScreen(BASH);
	const status = {
		state: "blocked",
		kind,
		msg,
		fingerprint: prompt?.fingerprint,
		options: prompt?.options.map(({ id, label }) => ({ id, label })),
	};
	expect(status.fingerprint).toBeDefined();
	expect(status.options?.length).toBeGreaterThan(1);
	expect(seen).toEqual([{ agent: "card-a", status, seq: AT_US }]);
	expect(await port.list()).toEqual([{ name: "card-a", status, seq: AT_US, sessionId: SESSION }]);

	const [{ status: emitted }] = seen as [AgentStatusEvent];
	const { fingerprint } = emitted as { fingerprint: string };
	expect(await port.respond("card-a", { option: "1", fingerprint })).toEqual({ sent: true });
});

test("a blocked record whose screen does not parse keeps the record's status, without a fingerprint", async () => {
	const fake = rex([
		{
			name: "card-a",
			block: "block:a",
			label: SESSION,
			argv0: "claude",
			records: [{ state: "blocked", kind: "question", msg: "answer: which?", updated_at: AT }],
			screen: "nothing anyone can answer",
		},
	]);

	const listed = await createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		redrawMs: 0,
	}).list();

	expect(listed).toEqual([
		{
			name: "card-a",
			status: { state: "blocked", kind: "question", msg: "answer: which?" },
			seq: AT_US,
			sessionId: SESSION,
		},
	]);
	// Read three times, in case claude was still drawing it.
	expect(fake.methods().filter((method) => method.endsWith(".format"))).toHaveLength(3);
});

test("a blocked record's screen that parses only once claude has drawn it carries the prompt", async () => {
	const block: Block = {
		name: "card-a",
		block: "block:a",
		label: SESSION,
		argv0: "claude",
		records: [],
		screen: "Bash command",
	};
	const fake = rex([block]);
	const original = fake.client.call.bind(fake.client);
	const reads: number[] = [];
	fake.client.call = async (method, payload, schema) => {
		const result = await original(method, payload, schema);
		// The first read catches the prompt half drawn; claude has finished it by the next.
		if (method.endsWith(".format")) {
			reads.push(Date.now());
			block.screen = BASH;
		}
		return result;
	};
	const seen: AgentStatusEvent[] = [];
	const off = createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		redrawMs: 50,
	}).onStatus((event) => seen.push(event));
	await settle();

	block.records = [{ state: "blocked", kind: "permission", msg: "approve Bash: ls", updated_at: AT }];
	fake.emit(fake.status("block:a", block.records[0] as object));
	await until(() => seen.length > 0);
	off();

	expect(reads).toHaveLength(2);
	expect((reads[1] as number) - (reads[0] as number)).toBeGreaterThanOrEqual(45);
	expect(seen).toEqual([
		{ agent: "card-a", status: expect.objectContaining({ fingerprint: fingerprintOf(BASH) }), seq: AT_US },
	]);
});

test("a second prompt under the same record text, with no other status between, carries its own fingerprint", async () => {
	const block: Block = { name: "card-a", block: "block:a", label: SESSION, argv0: "claude", records: [], screen: BASH };
	const fake = rex([block]);
	const seen: AgentStatusEvent[] = [];
	const port = createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR });
	const off = port.onStatus((event) => seen.push(event));
	await settle();
	const blocked = (updated_at: string) => ({ state: "blocked", kind: "permission", msg: "approve Bash", updated_at });

	block.records = [blocked("2026-10-27T01:02:04Z")];
	fake.emit(fake.status("block:a", block.records[0] as object));
	await until(() => seen.length === 1);
	// rex's record reads the same; the screen shows another command.
	const other = BASH.replaceAll("canary.txt", "other.txt");
	block.screen = other;
	block.records = [blocked("2026-10-27T01:02:09Z")];
	fake.emit(fake.status("block:a", block.records[0] as object));
	await until(() => seen.length === 2);
	off();

	expect(fingerprintOf(other)).not.toBe(fingerprintOf(BASH));
	expect(seen.map((event) => event.status)).toEqual([
		expect.objectContaining({ fingerprint: fingerprintOf(BASH) }),
		expect.objectContaining({ fingerprint: fingerprintOf(other) }),
	]);
	expect((await port.list())[0]?.status).toMatchObject({ fingerprint: fingerprintOf(other) });
});

async function until(ok: () => boolean, ms = 2_000): Promise<void> {
	for (const deadline = Date.now() + ms; !ok(); await new Promise((resolve) => setTimeout(resolve, 5))) {
		if (Date.now() > deadline) throw new Error("timed out");
	}
}

// claude in a card's worktree of a repo whose main checkout is /nonexistent/repo.
const WORKTREE = "/nonexistent/repo/.claude/worktrees/card-a";
const mainGit = git(
	`worktree /nonexistent/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree ${WORKTREE}\nHEAD def\nbranch refs/heads/fleet/card-a\n`,
);
const ROOT_LINE =
	"Answering yes trusts the repository root /nonexistent/repo, and with it every worktree of that repository.";

const TRUSTED = {
	state: "blocked",
	kind: "permission",
	msg: `${readBlockedScreen(TRUST).msg}\n${ROOT_LINE}`,
	fingerprint: fingerprintOf(TRUST),
	options: [
		{ id: "1", label: "No, exit" },
		{ id: "2", label: "Yes, I trust this folder" },
	],
};

test("onStatus reports the trust dialog once claude ran trustMs without a record, again while it stays, until a record", async () => {
	const started = Date.now();
	const block: Block = {
		name: "card-a",
		block: "block:a",
		label: SESSION,
		argv0: "claude",
		cwd: WORKTREE,
		records: [],
		screen: TRUST,
	};
	const fake = rex([block]);
	const seen: AgentStatusEvent[] = [];
	const port = createRexAgentPort({
		client: fake.client,
		sessionId: HANGAR,
		git: mainGit.git,
		trustMs: 100,
		processStart: async (pid) => (pid === 9 ? started : undefined),
	});
	const off = port.onStatus((event) => seen.push(event));
	const reads = () => fake.methods().filter((method) => method.endsWith(".format")).length;
	await settle();
	// Read at once on listening, but claude has not been up for trustMs yet.
	expect(seen).toEqual([]);
	expect(reads()).toBe(0);

	await until(() => seen.length >= 2);
	expect(seen[0]).toEqual({ agent: "card-a", status: TRUSTED, seq: (started + 100) * 1000 });
	expect(seen[1]?.status).toEqual(TRUSTED);
	expect(seen[1]?.seq).toBeGreaterThan(seen[0]?.seq as number);

	// claude's first record once the dialog is answered: rex stamped it before the adapter's last dialog seq.
	// The dialog's text is left on screen, so a check that went on would report it again.
	block.records = [{ state: "idle", updated_at: AT }];
	fake.emit(fake.status("block:a", { state: "idle", updated_at: AT }));
	await until(() => seen.at(-1)?.status.state === "idle");
	const readsAtRecord = reads();
	const count = seen.length;
	await new Promise((resolve) => setTimeout(resolve, 350));

	expect(seen.at(-1)).toEqual({ agent: "card-a", status: { state: "idle" }, seq: AT_US });
	expect(seen).toHaveLength(count);
	expect(reads()).toBe(readsAtRecord);
	off();
});

/** A rex whose screen reads wait, while `hold` is on, until `release`; `held` counts the reads that waited. */
function heldScreen(fake: ReturnType<typeof rex>) {
	const gate = { hold: false, held: 0, release: () => {} };
	let opened = Promise.resolve();
	const original = fake.client.call.bind(fake.client);
	fake.client.call = async (method, payload, schema) => {
		if (gate.hold && method.endsWith(".format")) {
			gate.held++;
			await opened;
		}
		return original(method, payload, schema);
	};
	return {
		gate,
		hold() {
			gate.hold = true;
			opened = new Promise((resolve) => {
				gate.release = () => {
					gate.hold = false;
					resolve();
				};
			});
		},
	};
}

test("a record arriving while the first dialog check reads the screen wins: the dialog is never reported", async () => {
	const block: Block = {
		name: "card-a",
		block: "block:a",
		label: SESSION,
		argv0: "claude",
		cwd: WORKTREE,
		records: [],
		screen: TRUST,
	};
	const fake = rex([block]);
	const screen = heldScreen(fake);
	screen.hold();
	const seen: AgentStatusEvent[] = [];
	const off = createRexAgentPort({
		client: fake.client,
		sessionId: HANGAR,
		git: mainGit.git,
		trustMs: 60_000,
		processStart: async () => Date.now() - 120_000,
	}).onStatus((event) => seen.push(event));
	// The read on listening finds claude up past trustMs, no record, and reads the screen.
	await until(() => screen.gate.held === 1);

	block.records = [{ state: "idle", updated_at: AT }];
	fake.emit(fake.status("block:a", { state: "idle", updated_at: AT }));
	screen.gate.release();
	await until(() => seen.length > 0);
	await settle();

	expect(seen).toEqual([{ agent: "card-a", status: { state: "idle" }, seq: AT_US }]);
	off();
});

test("a record arriving while a re-check reads the screen ends the dialog's reports at that record", async () => {
	const block: Block = {
		name: "card-a",
		block: "block:a",
		label: SESSION,
		argv0: "claude",
		cwd: WORKTREE,
		records: [],
		screen: TRUST,
	};
	const fake = rex([block]);
	const screen = heldScreen(fake);
	const seen: AgentStatusEvent[] = [];
	const off = createRexAgentPort({
		client: fake.client,
		sessionId: HANGAR,
		git: mainGit.git,
		trustMs: 30,
		processStart: async () => Date.now() - 120_000,
	}).onStatus((event) => seen.push(event));
	await until(() => seen.length > 0);
	expect(seen[0]?.status).toEqual(TRUSTED);

	screen.hold();
	await until(() => screen.gate.held === 1);
	const before = seen.length;
	// rex stamped claude's first record below the dialog's seq, so only the guards keep the stale dialog out.
	block.records = [{ state: "idle", updated_at: AT }];
	fake.emit(fake.status("block:a", { state: "idle", updated_at: AT }));
	screen.gate.release();
	await until(() => seen.at(-1)?.status.state === "idle");
	await new Promise((resolve) => setTimeout(resolve, 100));

	expect(seen.slice(before)).toEqual([{ agent: "card-a", status: { state: "idle" }, seq: AT_US }]);
	off();
});

test("onStatus never reads the screen of a claude that reports records", async () => {
	const fake = rex([
		{
			name: "card-a",
			block: "block:a",
			label: SESSION,
			argv0: "claude",
			records: [{ state: "idle", updated_at: AT }],
			screen: TRUST,
		},
	]);
	const seen: AgentStatusEvent[] = [];
	const off = createRexAgentPort({
		client: fake.client,
		sessionId: HANGAR,
		trustMs: 20,
		processStart: async () => Date.now() - 60_000,
	}).onStatus((event) => seen.push(event));
	await new Promise((resolve) => setTimeout(resolve, 100));

	expect(seen).toEqual([{ agent: "card-a", status: { state: "idle" }, seq: AT_US }]);
	expect(fake.methods().filter((method) => method.endsWith(".format"))).toEqual([]);
	off();
});

test("list reports the trust dialog under the seq of the time it first held, whichever port reads it", async () => {
	const started = Date.parse("2026-10-27T01:00:00Z");
	const block: Block = {
		name: "card-a",
		block: "block:a",
		label: SESSION,
		argv0: "claude",
		cwd: WORKTREE,
		records: [],
		screen: TRUST,
	};
	const at = (ms: number) =>
		createRexAgentPort({
			client: rex([block]).client,
			sessionId: HANGAR,
			git: mainGit.git,
			processStart: async () => started,
			now: () => started + ms,
		}).list();

	expect(await at(2_999)).toEqual([{ name: "card-a", sessionId: SESSION }]);
	const first = await at(3_000);
	expect(first).toEqual([{ name: "card-a", status: TRUSTED, seq: (started + 3_000) * 1000, sessionId: SESSION }]);
	expect(await at(600_000)).toEqual(first);
});

test("the trust dialog's msg ends naming the repository root a yes trusts, not the worktree claude runs in", async () => {
	const block: Block = {
		name: "card-a",
		block: "block:a",
		label: SESSION,
		argv0: "claude",
		cwd: WORKTREE,
		records: [],
		screen: TRUST,
	};
	const { git: run, runs } = git(`worktree /nonexistent/repo\nHEAD abc\nbranch refs/heads/main\n`);
	const list = (gitFor: typeof run) =>
		createRexAgentPort({
			client: rex([block]).client,
			sessionId: HANGAR,
			git: gitFor,
			processStart: async () => Date.now() - 60_000,
			onError: () => {},
		}).list();

	const msgOf = async (gitFor: typeof run) => (await list(gitFor))[0]?.status?.msg ?? "";

	const msg = await msgOf(run);
	expect(msg.split("\n").at(-1)).toBe(ROOT_LINE);
	expect(msg.startsWith(readBlockedScreen(TRUST).msg)).toBe(true);
	expect(runs).toEqual([[WORKTREE, "worktree", "list", "--porcelain"]]);

	// Where git cannot name a main checkout, claude trusts the folder itself.
	const plain = await msgOf(async () => {
		throw new Error("not a git repository");
	});
	expect(plain.split("\n").at(-1)).toBe(
		`Answering yes trusts the repository root ${WORKTREE}, and with it every worktree of that repository.`,
	);
});

test("a git failure's fallback stays the trust dialog's msg, so a git that recovers does not make it a new prompt", async () => {
	const block: Block = {
		name: "card-a",
		block: "block:a",
		label: SESSION,
		argv0: "claude",
		cwd: WORKTREE,
		records: [],
		screen: TRUST,
	};
	let fails = true;
	const port = createRexAgentPort({
		client: rex([block]).client,
		sessionId: HANGAR,
		git: async (repo, args) => {
			if (fails) throw new Error("index.lock exists");
			return mainGit.git(repo, args);
		},
		processStart: async () => Date.now() - 60_000,
		onError: () => {},
	});
	const msgOf = async () => (await port.list())[0]?.status?.msg ?? "";

	const first = await msgOf();
	fails = false;

	expect(first.split("\n").at(-1)).toContain(`root ${WORKTREE},`);
	expect(await msgOf()).toBe(first);
});

test("records map onto OSC 7501's vocabulary, and a blocked kind left out reads as permission", () => {
	expect(stateOf({ state: "blocked", updated_at: AT })).toEqual({ state: "blocked", kind: "permission" });
	expect(stateOf({ state: "blocked", kind: "auth", msg: "log in", updated_at: AT })).toEqual({
		state: "blocked",
		kind: "auth",
		msg: "log in",
	});
	expect(stateOf({ state: "sleeping", updated_at: AT })).toEqual({ state: "idle" });
	expect(stateOf({ state: "error", msg: "boom", updated_at: AT })).toEqual({ state: "error", msg: "boom" });
	expect(seqOf({ state: "idle", updated_at: "not a time" })).toBeUndefined();
});

test("seq is updated_at in microseconds, so reports 800 µs apart are two observations", async () => {
	expect(seqOf({ state: "idle", updated_at: AT })).toBe(AT_US);
	expect(seqOf({ state: "idle", updated_at: "2026-10-26T23:23:54.388938+08:00" })).toBe(
		Date.parse("2026-10-26T15:23:54Z") * 1000 + 388_938,
	);
	expect(seqOf({ state: "idle", updated_at: "2026-10-26T15:23:54.5Z" })).toBe(
		Date.parse("2026-10-26T15:23:54Z") * 1000 + 500_000,
	);
	expect(seqOf({ state: "idle", updated_at: "2026-10-26T15:23:54Z" })).toBe(Date.parse("2026-10-26T15:23:54Z") * 1000);
	expect(Number.isSafeInteger(seqOf({ state: "idle", updated_at: AT }))).toBe(true);

	const fake = rex([{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude", records: [] }]);
	const seen: AgentStatusEvent[] = [];
	createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR, redrawMs: 0 }).onStatus(
		(event) => seen.push(event),
	);
	await settle();
	fake.emit(fake.status("block:a", { state: "working", updated_at: "2026-10-27T01:02:03.456100Z" }));
	fake.emit(
		fake.status("block:a", { state: "blocked", kind: "permission", updated_at: "2026-10-27T01:02:03.456900Z" }),
	);
	await until(() => seen.length === 2);

	expect(seen.map((event) => event.status.state)).toEqual(["working", "blocked"]);
	expect(new Set(seen.map((event) => event.seq)).size).toBe(2);
});

describe("taking over a session another side ran", () => {
	const TRUST_SCREEN = fixture("claude-trust-dialog-2.1.302.txt");
	const CLAUDE = "5b1c0d2e-3f40-4a51-8b62-7c83d94e0a15";
	const idle = { state: "idle", updated_at: AT };

	/** A session claude ran in the worktree, whose reply names `model`, with the projects directory holding it. */
	function held(model = "claude-haiku-9") {
		const projectsDir = mkdtempSync(join(tmpdir(), "soma-rex-take-"));
		const directory = join(projectsDir, worktree.replace(/[^a-zA-Z0-9]/g, "-"));
		mkdirSync(directory);
		const reply = { role: "assistant", id: "m", content: [{ type: "text", text: "ok" }], ...(model && { model }) };
		writeFileSync(
			join(directory, `${CLAUDE}.jsonl`),
			`${JSON.stringify({ type: "assistant", uuid: "a-1", cwd: worktree, message: reply })}\n`,
		);
		const session = { name: "card-a", card: "card-a", sessionId: SESSION, claudeSession: CLAUDE, cwd: worktree };
		return { projectsDir, session };
	}

	/** A port on an in-memory rex whose new window becomes the block `opened` says, with the rest of `blocks`. */
	function port(projectsDir: string, opened: Partial<Block> = { records: [idle] }, blocks: Block[] = [], takeMs = 200) {
		const fake = rex(blocks);
		fake.replace("session.new_window", ({ window_label, layout }) => {
			const { label, options } = (layout as { block: { label: string; options: { cwd: string } } }).block;
			const name = window_label as string;
			blocks.push({ name, block: "block:new", label, argv0: "claude", cwd: options.cwd, ...opened });
			return { window_id: "window:new", block_ids: ["block:new"], revision: 2 };
		});
		const created = createRexAgentPort({
			processStart: unstarted,
			client: fake.client,
			sessionId: HANGAR,
			projectsDir,
			redrawMs: 5,
			keyGapMs: 1,
			takeMs,
			env: { SOMA_SOCKET: "/run/soma.sock" },
			path: "/opt/soma/bin",
			onError: () => {},
		});
		return { fake, blocks, created };
	}

	test("the launch line names the model, quoted as a value is", () => {
		expect(launchCommand({ card: "card-a", sessionId: CLAUDE }, {}, undefined, true, "claude-opus-5-5")).toBe(
			`SOMA_AGENT='card-a' claude --resume ${CLAUDE} --model 'claude-opus-5-5'\n`,
		);
		expect(() => launchCommand({ card: "card-a", sessionId: CLAUDE }, {}, undefined, true, "it's")).toThrow(
			"cannot put",
		);
	});

	test("take opens one window labelled as a job's, running claude --resume with the session's last model, in its directory", async () => {
		const { projectsDir, session } = held();
		const { fake, created } = port(projectsDir);

		expect(await created.takeable(session)).toBeUndefined();
		expect(await created.take(session)).toEqual({ window: "card-a", session: "hangar", ready: true });

		expect(fake.calls.filter((call) => call.method === "session.new_window").map((call) => call.payload)).toEqual([
			{
				session_id: HANGAR,
				window_label: "card-a",
				focus: false,
				layout: {
					block: {
						flavor: "com.superlogical.terminal.shell",
						label: CLAUDE,
						options: {
							cwd: worktree,
							initial_input: `SOMA_SOCKET='/run/soma.sock' SOMA_AGENT='card-a' PATH='/opt/soma/bin':"$PATH" claude --resume ${CLAUDE} --model 'claude-haiku-9'\n`,
						},
					},
				},
			},
		]);
		// The window is a job of the hangar, so it is listed by the label and is no foreign agent.
		expect(await created.list()).toEqual([
			{ name: "card-a", sessionId: CLAUDE, status: { state: "idle" }, seq: AT_US },
		]);
		expect(await created.listForeign()).toEqual([]);
		rmSync(projectsDir, { recursive: true, force: true });
	});

	test("takeable and take refuse, opening no window, what claude could not go on with", async () => {
		const fit = held();
		const cases: { session: typeof fit.session; projectsDir: string; blocks?: Block[]; error: string }[] = [
			{ session: fit.session, projectsDir: worktree, error: `claude session ${CLAUDE} has no transcript` },
			{ ...held(""), error: "names its model" },
			{
				session: { ...fit.session, cwd: join(worktree, "gone") },
				projectsDir: fit.projectsDir,
				error: "no longer exists",
			},
			{
				session: { ...fit.session, claudeSession: "x; rm -rf ~" },
				projectsDir: fit.projectsDir,
				error: "not a claude session id",
			},
			{ session: { ...fit.session, card: "it's" }, projectsDir: fit.projectsDir, error: "cannot put" },
			{
				...fit,
				blocks: [{ name: "card-a", block: "block:a" }],
				error: `rex hangar ${HANGAR} already has a window named card-a`,
			},
		];
		for (const { session, projectsDir, blocks, error } of cases) {
			const { fake, created } = port(projectsDir, undefined, blocks);
			expect(await created.takeable(session)).toContain(error);
			await expect(created.take(session)).rejects.toThrow(error);
			expect(fake.methods()).not.toContain("session.new_window");
		}
	});

	test("take answers the workspace trust dialog yes, once, from the cursor, and is ready at claude's first record", async () => {
		const { projectsDir, session } = held();
		const { fake, blocks, created } = port(projectsDir, { records: [], screen: TRUST_SCREEN });
		const pressed: string[] = [];
		fake.replace("block.event", (payload) => {
			const { key, action } = (payload.event as { payload: { key: string; action: string } }).payload;
			if (action === "press") pressed.push(key);
			// The dialog stays drawn a while after the Enter that answered it, and then claude reports.
			if (action === "press" && key === "enter") setTimeout(() => (blocks[0] as Block).records?.push(idle), 40);
			return fake.original("block.event")(payload);
		});

		expect(await created.take(session)).toMatchObject({ ready: true });

		expect(pressed).toEqual(["arrow_down", "enter"]);
		rmSync(projectsDir, { recursive: true, force: true });
	});

	/** A window on the dialog, where Enter takes the option under the cursor as claude does: a yes reports, a no exits. */
	function onDialog(projectsDir: string, oddly: (key: string, action: string, block: Block) => boolean) {
		const opening = port(projectsDir, { records: [], screen: TRUST_SCREEN });
		const pressed: string[] = [];
		opening.fake.replace("block.event", (payload) => {
			const { key, action } = (payload.event as { payload: { key: string; action: string } }).payload;
			const block = opening.blocks[0] as Block;
			if (action === "press") pressed.push(key);
			if (oddly(key, action, block)) return {};
			if (action === "press" && key === "enter") {
				if (/❯ Yes/.test(block.screen ?? "")) setTimeout(() => block.records?.push(idle), 5);
				else block.argv0 = "-fish";
			}
			return opening.fake.original("block.event")(payload);
		});
		return { ...opening, pressed };
	}

	test("take answers again when the dialog dropped its first arrow, and says yes", async () => {
		const { projectsDir, session } = held();
		let dropped = false;
		const { created, pressed } = onDialog(projectsDir, (key, action) => {
			if (key !== "arrow_down" || dropped) return false;
			dropped = action === "release";
			return true;
		});

		expect(await created.take(session)).toMatchObject({ ready: true });

		expect(pressed).toEqual(["arrow_down", "arrow_down", "enter"]);
		rmSync(projectsDir, { recursive: true, force: true });
	});

	test("take answers again when the dialog redrew and put the cursor back, and says yes", async () => {
		const { projectsDir, session } = held();
		const { fake, blocks, created, pressed } = onDialog(projectsDir, () => false);
		const format = "com.superlogical.terminal.format";
		let undone = false;
		fake.replace(format, (payload) => {
			const read = fake.original(format)(payload);
			const block = blocks[0] as Block;
			if (!undone && /❯ Yes/.test(block.screen ?? "")) {
				undone = true;
				block.screen = TRUST_SCREEN;
			}
			return read;
		});

		expect(await created.take(session)).toMatchObject({ ready: true });

		expect(pressed).toEqual(["arrow_down", "arrow_down", "enter"]);
		rmSync(projectsDir, { recursive: true, force: true });
	});

	test("take stops waiting as soon as a claude seen in the window has left it", async () => {
		const { projectsDir, session } = held();
		const { blocks, created } = port(projectsDir, { records: [], screen: "$ claude --resume" }, [], 60_000);
		const taking = created.take(session);
		await until(() => blocks.length > 0);
		await sleep(30);
		(blocks[0] as Block).argv0 = "-fish";
		const started = Date.now();

		expect(await taking).toEqual({ window: "card-a", session: "hangar", ready: false });

		expect(Date.now() - started).toBeLessThan(5_000);
		expect(blocks).toHaveLength(1);
		rmSync(projectsDir, { recursive: true, force: true });
	});

	test("take waits through the shell a window opens on, for the claude it types", async () => {
		const { projectsDir, session } = held();
		const { blocks, created } = port(projectsDir, { records: [], argv0: "-fish", screen: "$" }, [], 60_000);
		const taking = created.take(session);
		await until(() => blocks.length > 0);
		await sleep(30);
		const block = blocks[0] as Block;
		block.argv0 = "claude";
		await sleep(30);
		block.records?.push(idle);

		expect(await taking).toMatchObject({ ready: true });
		rmSync(projectsDir, { recursive: true, force: true });
	});

	test("take leaves the window open and not ready when claude never comes up, or the reads fail, and presses nothing but a dialog's keys", async () => {
		const { projectsDir, session } = held();
		const quiet = port(projectsDir, { records: [], screen: "$ claude --resume\nLoading" });
		expect(await quiet.created.take(session)).toEqual({ window: "card-a", session: "hangar", ready: false });
		expect(quiet.blocks).toHaveLength(1);
		expect(quiet.fake.methods()).not.toContain("block.event");

		const failing = port(projectsDir, { records: [] });
		failing.fake.replace("com.superlogical.terminal.program_status", () => {
			throw new Error("the block went away");
		});
		expect(await failing.created.take(session)).toMatchObject({ ready: false });
		expect(failing.blocks).toHaveLength(1);
		rmSync(projectsDir, { recursive: true, force: true });
	});

	test("take names the hangar by its id when its label cannot be read", async () => {
		const { projectsDir, session } = held();
		const { fake, created } = port(projectsDir);
		fake.replace("session.attach_all", () => {
			throw new Error("no answer");
		});
		expect(await created.take(session)).toMatchObject({ session: HANGAR, ready: true });
		rmSync(projectsDir, { recursive: true, force: true });
	});
});

describe("windows the human opens in the hangar", () => {
	const OTHER = "5b2a7f3e-1c4d-4e8f-9a0b-6c7d8e9f0a1b";

	test("two of one label are no jobs: list returns the job alone, and a dispatch goes on to start its card", async () => {
		const fake = rex([
			{ name: "claude", block: "block:h1", argv0: "claude" },
			{ name: "card-b", block: "block:b", label: OTHER, argv0: "claude", records: [{ state: "idle", updated_at: AT }] },
			{ name: "claude", block: "block:h2", argv0: "claude" },
		]);
		const port = createRexAgentPort({
			processStart: unstarted,
			client: fake.client,
			sessionId: HANGAR,
			git: git().git,
		});

		expect(await port.list()).toEqual([{ name: "card-b", status: { state: "idle" }, seq: AT_US, sessionId: OTHER }]);

		const doc = { jobs: [] as Job[] };
		const ledger: JobLedger = {
			conversationId: 1 as JobLedger["conversationId"],
			commit: (change) => change({ doc: async () => doc } as unknown as Tx),
			sessionId: async () => SESSION,
		};
		const started = await startJobIn(port, async () => "# card-a", ledger, {
			card: "card-a",
			repo: "/nonexistent/repo",
		});
		expect(started).toMatchObject({ existing: false, started: true });
		expect(fake.calls.find((call) => call.method === "session.new_window")?.payload).toMatchObject({
			window_label: "card-a",
		});
	});

	test("one named as a job leaves the job's prompt, readResult and statuses to the job's block", async () => {
		const { cwd } = transcript([user("go"), reply("msg_1", "結果：完成")]);
		const job: Block = { name: "card-a", block: "block:a", label: SESSION, argv0: "claude", cwd, records: [] };
		const human: Block = { name: "card-a", block: "block:h", argv0: "claude", records: [] };
		const fake = rex([human, job]);
		const port = createRexAgentPort({
			processStart: unstarted,
			client: fake.client,
			sessionId: HANGAR,
			projectsDir: projects,
			confirmMs: 10,
		});
		const seen: AgentStatusEvent[] = [];
		const off = port.onStatus((event) => seen.push(event));
		await settle();
		const views = () => fake.methods().filter((method) => method === "session.view").length;
		const viewed = views();

		fake.emit(fake.status("block:h", { state: "working", updated_at: AT }));
		fake.emit(fake.status("block:a", { state: "done", updated_at: AT }));
		await until(() => seen.length > 0);
		expect(seen).toEqual([{ agent: "card-a", status: { state: "done" }, seq: AT_US }]);
		// The human's block was known for no job's as the hangar was read, so its report reads the hangar no more.
		expect(views()).toBe(viewed);
		off();

		job.records = [{ state: "idle", updated_at: AT }];
		await port.prompt("card-a", "go on");
		const pasted = fake.calls.filter((call) => call.method === "block.event").map((call) => call.payload.block_id);
		expect(pasted).toEqual(["block:a"]);
		expect(await port.readResult("card-a")).toEqual({ id: "a-msg_1", text: "結果：完成" });
	});

	test("a job's window the human split is the job's, by its labelled block, whichever block comes first", async () => {
		const human: Block = { name: "card-a", block: "block:h", window: "window:a", argv0: "claude", records: [] };
		const job: Block = {
			name: "card-a",
			block: "block:a",
			window: "window:a",
			label: SESSION,
			argv0: "claude",
			records: [{ state: "idle", updated_at: AT }],
		};
		const fake = rex([human, job]);
		const port = createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR, confirmMs: 10 });
		const seen: AgentStatusEvent[] = [];
		const off = port.onStatus((event) => seen.push(event));
		await settle();

		expect(await port.list()).toEqual([{ name: "card-a", status: { state: "idle" }, seq: AT_US, sessionId: SESSION }]);
		await until(() => seen.length > 0);
		const views = () => fake.methods().filter((method) => method === "session.view").length;
		const viewed = views();
		fake.emit(fake.status("block:h", { state: "working", updated_at: AT }));
		fake.emit(fake.status("block:a", { state: "done", updated_at: "2026-10-27T01:02:04Z" }));
		await until(() => seen.length > 1);
		expect(seen).toEqual([
			{ agent: "card-a", status: { state: "idle" }, seq: AT_US },
			{ agent: "card-a", status: { state: "done" }, seq: Date.parse("2026-10-27T01:02:04Z") * 1000 },
		]);
		// The block split off the job's was read as no job's with the window, so its report reads the hangar no more.
		expect(views()).toBe(viewed);
		off();
		await port.prompt("card-a", "go on");
		const pasted = fake.calls.filter((call) => call.method === "block.event").map((call) => call.payload.block_id);
		expect(pasted).toEqual(["block:a"]);
	});

	test("a block with an ordinary label of its own is no job either", async () => {
		const fake = rex([
			{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude" },
			{ name: "card-b", block: "block:f", label: "fish", argv0: "claude" },
		]);
		const port = createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR });

		expect(await port.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
		await expect(port.prompt("card-b", "go")).rejects.toThrow("has no window named card-b");
	});

	test("two job windows of one card name still make list and prompt throw", async () => {
		const fake = rex([
			{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude" },
			{ name: "card-a", block: "block:b", label: OTHER, argv0: "claude" },
		]);
		const port = createRexAgentPort({ processStart: unstarted, client: fake.client, sessionId: HANGAR });

		await expect(port.list()).rejects.toThrow("more than one window named card-a");
		await expect(port.prompt("card-a", "go")).rejects.toThrow("has 2 windows named card-a");
	});
});
