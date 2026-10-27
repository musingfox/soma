import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import type { ZodType } from "zod";
import { createRexAgentPort, seqOf, stateOf } from "../../../src/adapters/rex/agent-port.ts";
import type { RexClient } from "../../../src/adapters/rex/client.ts";
import type { SessionEvent } from "../../../src/adapters/rex/schema.ts";
import { readBlockedScreen } from "../../../src/agent-cli/permission/blocked-screen.ts";
import type { AgentStatusEvent } from "../../../src/ports/agent.ts";

const HANGAR = "session:hangar";
const SESSION = "0e9d6c1f-4a3b-4a52-9c85-2f6d3f6f2f10";
const AT = "2026-10-27T01:02:03.456789+08:00";
/** AT in microseconds since the epoch. */
const AT_US = Date.parse("2026-10-27T01:02:03+08:00") * 1000 + 456_789;

type Block = {
	name: string;
	block: string;
	label?: string;
	argv0?: string;
	cwd?: string;
	records?: object[];
	screen?: string;
};

const fixture = (name: string) =>
	readFileSync(join(import.meta.dirname, "../../agent-cli/permission/fixtures", name), "utf8");

/** An in-memory rex: the hangar's windows, each with one block, and every call made on it. */
function rex(blocks: Block[]) {
	const calls: { method: string; payload: Record<string, unknown> }[] = [];
	const events = new Set<(event: SessionEvent) => void>();
	const connected = new Set<() => void>();
	const attached: string[] = [];
	const byId = (payload: Record<string, unknown>) => blocks.find((each) => each.block === payload.block_id);
	const replies: Record<string, (payload: Record<string, unknown>) => unknown> = {
		"session.view": () => ({
			revision: 1,
			session_id: HANGAR,
			windows: blocks.map(({ name, block, label }) => ({
				window_id: `window:${block}`,
				label: name,
				layers: [{ kind: "tiled", blocks: [{ block_id: block, ...(label === undefined ? {} : { label }) }] }],
			})),
		}),
		"session.new_window": () => ({ window_id: "window:new", block_ids: ["block:new"], revision: 2 }),
		"block.close": (payload) => ({ block_id: payload.block_id, revision: 3 }),
		"block.event": () => ({}),
		"com.superlogical.terminal.write": (payload) => ({
			bytes_written: String((payload.args as { data: string }).data).length,
		}),
		"com.superlogical.terminal.program_status": (payload) => ({ records: byId(payload)?.records ?? [] }),
		"com.superlogical.terminal.format": (payload) => ({ content: byId(payload)?.screen ?? "" }),
		"com.superlogical.terminal.process": (payload) => {
			const found = byId(payload);
			return {
				last_exit: null,
				foreground: { pid: 9, user_id: 501, name: "2.1.310", argv0: found?.argv0 ?? "-fish", cwd: found?.cwd },
			};
		},
	};
	const client: RexClient = {
		async call<T>(method: string, payload: unknown, schema: ZodType<T>): Promise<T> {
			calls.push({ method, payload: payload as Record<string, unknown> });
			const reply = replies[method];
			if (reply === undefined) throw new Error(`unexpected ${method}`);
			return schema.parse(reply(payload as Record<string, unknown>));
		},
		async attach(sessionId) {
			attached.push(sessionId);
		},
		onSessionEvent(listener) {
			events.add(listener);
			return () => events.delete(listener);
		},
		onConnected(listener) {
			connected.add(listener);
			return () => connected.delete(listener);
		},
		close() {},
	};
	const status = (block: string, record: object, id = "") =>
		({
			session_id: HANGAR,
			event: {
				type: "block_event",
				payload: {
					block_id: block,
					creator_name: "com.superlogical.terminal",
					name: "program_status_changed",
					payload: { id, record, reason: "report" },
				},
			},
		}) satisfies SessionEvent;
	return {
		client,
		calls,
		attached,
		emit: (event: SessionEvent) => {
			for (const listener of events) listener(event);
		},
		status,
		reconnect: () => {
			for (const listener of connected) listener();
		},
		methods: () => calls.map((call) => call.method),
	};
}

function git(porcelain = "", branches = "") {
	const runs: string[][] = [];
	return {
		runs,
		git: async (repo: string, args: readonly string[]) => {
			runs.push([repo, ...args]);
			if (args[0] === "worktree" && args[1] === "list") return porcelain;
			if (args[0] === "branch") return branches;
			return "";
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const request = { name: "card-a", card: "card-a", cwd: "/nonexistent/repo", sessionId: SESSION };

test("start adds fleet/<card> under .claude/worktrees and types claude's command into an interactive shell", async () => {
	const fake = rex([]);
	const { git: run, runs } = git();

	await createRexAgentPort({ client: fake.client, sessionId: HANGAR, git: run }).start(request);

	expect(runs).toEqual([
		["/nonexistent/repo", "worktree", "list", "--porcelain"],
		["/nonexistent/repo", "branch", "--list", "fleet/card-a"],
		["/nonexistent/repo", "worktree", "add", "-b", "fleet/card-a", "/nonexistent/repo/.claude/worktrees/card-a"],
	]);
	expect(fake.attached).toEqual([HANGAR]);
	expect(fake.calls).toEqual([
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
							initial_input: `claude --session-id ${SESSION}\n`,
						},
					},
				},
			},
		},
	]);
});

test("start reopens the worktree an earlier attempt left on the branch", async () => {
	const fake = rex([]);
	const porcelain =
		"worktree /nonexistent/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt/card-a\nHEAD def\nbranch refs/heads/fleet/card-a\n";
	const { git: run, runs } = git(porcelain, "  fleet/card-a\n");

	await createRexAgentPort({ client: fake.client, sessionId: HANGAR, git: run }).start(request);

	expect(runs).toHaveLength(1);
	expect(fake.calls[0]?.payload).toMatchObject({ layout: { block: { options: { cwd: "/wt/card-a" } } } });
});

test("start checks out a branch that exists without a worktree", async () => {
	const { git: run, runs } = git("", "  fleet/card-a\n");

	await createRexAgentPort({ client: rex([]).client, sessionId: HANGAR, git: run }).start(request);

	expect(runs.at(-1)).toEqual([
		"/nonexistent/repo",
		"worktree",
		"add",
		"/nonexistent/repo/.claude/worktrees/card-a",
		"fleet/card-a",
	]);
});

test("list names each window, with the root record's status and seq while claude is in the foreground", async () => {
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
		{ name: "card-b", block: "block:b", argv0: "-fish", records: [{ state: "idle", updated_at: AT }] },
		{ name: "card-c", block: "block:c", argv0: "claude" },
	]);

	const listed = await createRexAgentPort({ client: fake.client, sessionId: HANGAR, redrawMs: 0 }).list();

	expect(listed).toEqual([
		{
			name: "card-a",
			status: { state: "blocked", kind: "question", msg: "answer: which?" },
			seq: AT_US,
			sessionId: SESSION,
		},
		{ name: "card-b" },
		{ name: "card-c" },
	]);
});

test("list refuses two windows of one name rather than take the first", async () => {
	const fake = rex([
		{ name: "card-a", block: "block:a" },
		{ name: "card-a", block: "block:b" },
	]);

	await expect(createRexAgentPort({ client: fake.client, sessionId: HANGAR }).list()).rejects.toThrow(
		"more than one window named card-a",
	);
});

test("onStatus reports root records off the event stream, one per observation", async () => {
	const block: Block = { name: "card-a", block: "block:a", argv0: "claude", records: [] };
	const fake = rex([block, { name: "shell", block: "block:s", argv0: "-fish" }]);
	const port = createRexAgentPort({ client: fake.client, sessionId: HANGAR });
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
	const block: Block = { name: "card-a", block: "block:a", argv0: "claude", records: [] };
	const fake = rex([block]);
	const seen: AgentStatusEvent[] = [];
	createRexAgentPort({ client: fake.client, sessionId: HANGAR }).onStatus((event) => seen.push(event));
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
	const block: Block = { name: "card-a", block: "block:a", argv0: "claude", records: [] };
	const fake = rex([block]);
	const seen: AgentStatusEvent[] = [];
	createRexAgentPort({ client: fake.client, sessionId: HANGAR }).onStatus((event) => seen.push(event));
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
		{ name: "card-a", block: "block:a", argv0: "claude", records: [{ state: "idle", updated_at: AT }] },
	]);

	await createRexAgentPort({ client: fake.client, sessionId: HANGAR, confirmMs: 10 }).prompt(
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
		{ name: "card-a", block: "block:a", argv0: "claude", records: [{ state: "done", updated_at: AT }] },
	]);
	const original = fake.client.call.bind(fake.client);
	fake.client.call = async (method, payload, schema) => {
		const result = await original(method, payload, schema);
		if (method === "com.superlogical.terminal.write")
			fake.emit(fake.status("block:a", { state: "working", updated_at: AT }));
		return result;
	};

	await createRexAgentPort({ client: fake.client, sessionId: HANGAR, confirmMs: 1_000 }).prompt("card-a", "go");

	expect(fake.methods().filter((method) => method.endsWith(".write"))).toHaveLength(1);
});

test("prompt does not press \\r again when claude goes from idle straight to blocked", async () => {
	const block: Block = {
		name: "card-a",
		block: "block:a",
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

	await createRexAgentPort({ client: fake.client, sessionId: HANGAR, confirmMs: 10 }).prompt("card-a", "go");

	expect(fake.methods().filter((method) => method.endsWith(".write"))).toHaveLength(1);
});

test("prompt does not press \\r again when the status cannot be read", async () => {
	const block: Block = {
		name: "card-a",
		block: "block:a",
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

	await createRexAgentPort({ client: fake.client, sessionId: HANGAR, confirmMs: 10 }).prompt("card-a", "go");

	expect(fake.methods().filter((method) => method.endsWith(".write"))).toHaveLength(1);
});

test.each([
	["blocked", [{ state: "blocked", kind: "permission", updated_at: AT }]],
	["working", [{ state: "working", updated_at: AT }]],
	["without a status record", []],
])("prompt throws without typing anything when claude is %s", async (state, records) => {
	const fake = rex([{ name: "card-a", block: "block:a", argv0: "claude", records }]);

	await expect(
		createRexAgentPort({ client: fake.client, sessionId: HANGAR, confirmMs: 10 }).prompt("card-a", "go"),
	).rejects.toThrow(`rex agent card-a is ${state}`);

	expect(fake.methods().filter((method) => method === "block.event" || method.endsWith(".write"))).toEqual([]);
});

const projects = mkdtempSync(join(tmpdir(), "soma-rex-projects-"));
afterAll(() => rmSync(projects, { recursive: true, force: true }));

test("readResult reads the last reply off the transcript of the session id the block was started with", async () => {
	const cwd = "/nonexistent/repo/.claude/worktrees/card-a";
	mkdirSync(join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true });
	writeFileSync(
		join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${SESSION}.jsonl`),
		`${JSON.stringify({ type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "結果：完成" }] } })}\n`,
	);
	const fake = rex([{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude", cwd }]);

	const result = await createRexAgentPort({ client: fake.client, sessionId: HANGAR, projectsDir: projects }).readResult(
		"card-a",
	);

	expect(result).toEqual({ id: "msg_1", text: "結果：完成" });
});

test("stop closes the agent's block", async () => {
	const fake = rex([{ name: "card-a", block: "block:a" }]);

	await createRexAgentPort({ client: fake.client, sessionId: HANGAR }).stop("card-a");

	expect(fake.calls.at(-1)).toEqual({ method: "block.close", payload: { session_id: HANGAR, block_id: "block:a" } });
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
	const fake = rex([{ name: "card-a", block: "block:a", argv0: "claude", ...block }]);
	const port = createRexAgentPort({ client: fake.client, sessionId: HANGAR, keyGapMs: 0 });
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

test("respond reads only the tail of a scrollback too long for one reply", async () => {
	const fake = rex([{ name: "card-a", block: "block:a", argv0: "claude", records: blocked }]);
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

	const outcome = await createRexAgentPort({ client: fake.client, sessionId: HANGAR, keyGapMs: 0 }).respond("card-a", {
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
	const block: Block = { name: "card-a", block: "block:a", argv0: "claude", records: [], screen: BASH };
	const fake = rex([block]);
	const port = createRexAgentPort({ client: fake.client, sessionId: HANGAR, keyGapMs: 0 });
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
	expect(await port.list()).toEqual([{ name: "card-a", status, seq: AT_US }]);

	const [{ status: emitted }] = seen as [AgentStatusEvent];
	const { fingerprint } = emitted as { fingerprint: string };
	expect(await port.respond("card-a", { option: "1", fingerprint })).toEqual({ sent: true });
});

test("a blocked record whose screen does not parse keeps the record's status, without a fingerprint", async () => {
	const fake = rex([
		{
			name: "card-a",
			block: "block:a",
			argv0: "claude",
			records: [{ state: "blocked", kind: "question", msg: "answer: which?", updated_at: AT }],
			screen: "nothing anyone can answer",
		},
	]);

	const listed = await createRexAgentPort({ client: fake.client, sessionId: HANGAR, redrawMs: 0 }).list();

	expect(listed).toEqual([
		{ name: "card-a", status: { state: "blocked", kind: "question", msg: "answer: which?" }, seq: AT_US },
	]);
	// Read three times, in case claude was still drawing it.
	expect(fake.methods().filter((method) => method.endsWith(".format"))).toHaveLength(3);
});

test("a blocked record's screen that parses only once claude has drawn it carries the prompt", async () => {
	const block: Block = { name: "card-a", block: "block:a", argv0: "claude", records: [], screen: "Bash command" };
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
	const off = createRexAgentPort({ client: fake.client, sessionId: HANGAR, redrawMs: 50 }).onStatus((event) =>
		seen.push(event),
	);
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
	const block: Block = { name: "card-a", block: "block:a", argv0: "claude", records: [], screen: BASH };
	const fake = rex([block]);
	const seen: AgentStatusEvent[] = [];
	const port = createRexAgentPort({ client: fake.client, sessionId: HANGAR });
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

	const fake = rex([{ name: "card-a", block: "block:a", argv0: "claude", records: [] }]);
	const seen: AgentStatusEvent[] = [];
	createRexAgentPort({ client: fake.client, sessionId: HANGAR, redrawMs: 0 }).onStatus((event) => seen.push(event));
	await settle();
	fake.emit(fake.status("block:a", { state: "working", updated_at: "2026-10-27T01:02:03.456100Z" }));
	fake.emit(
		fake.status("block:a", { state: "blocked", kind: "permission", updated_at: "2026-10-27T01:02:03.456900Z" }),
	);
	await until(() => seen.length === 2);

	expect(seen.map((event) => event.status.state)).toEqual(["working", "blocked"]);
	expect(new Set(seen.map((event) => event.seq)).size).toBe(2);
});
