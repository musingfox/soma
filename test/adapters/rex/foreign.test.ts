import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { createRexAgentPort } from "../../../src/adapters/rex/agent-port.ts";
import { readBlockedScreen } from "../../../src/agent-cli/permission/blocked-screen.ts";
import { type ForeignStatusEvent, PromptRefused } from "../../../src/ports/agent.ts";
import { AT, AT_US, type Block, type Client, fixture, git, HANGAR, rex, SESSION, type Session } from "./fake.ts";

const root = mkdtempSync(join(tmpdir(), "soma-rex-foreign-"));
const projects = join(root, "projects");
const sessionsDir = join(root, "sessions");
mkdirSync(sessionsDir);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const unstarted = async () => undefined;
const line = (value: object) => `${JSON.stringify(value)}\n`;
const OTHER = "1b7e4f2a-9c3d-4e5f-8a6b-7c8d9e0f1a2b";

const work: Session = {
	id: "session:work",
	label: "work",
	blocks: [
		{
			name: "Window 1",
			block: "block:w1",
			argv0: "claude",
			pid: 101,
			cwd: "/repo/one",
			records: [{ state: "working", msg: "refactoring", updated_at: AT }],
		},
		{ name: "Window 2", block: "block:w2", argv0: "-fish", records: [{ state: "idle", updated_at: AT }] },
		// A split: the window's label alone would not tell its two blocks apart.
		{ name: "Window 3", block: "block:w3a", label: "left", window: "window:3", argv0: "vim" },
		{
			name: "Window 3",
			block: "block:w3b",
			label: "right",
			window: "window:3",
			argv0: "claude",
			pid: 102,
			cwd: "/repo/two",
			records: [
				{ state: "blocked", kind: "question", msg: "answer: which?", updated_at: AT },
				{ id: "sub-1", state: "working", updated_at: AT },
			],
		},
		{ name: "", block: "block:w4", label: "loose", detached: true, argv0: "claude", pid: 103 },
		{ name: "Window 5", block: "block:w5", creator: "com.superlogical.onboarding" },
	],
};
const home: Session = {
	id: "session:home",
	label: "home",
	blocks: [
		{ name: "notes", block: "block:h1", argv0: "claude", pid: 104, records: [{ state: "done", updated_at: AT }] },
	],
};

function port(fake: ReturnType<typeof rex>, foreignMs = 60_000) {
	return createRexAgentPort({
		label: "soma-test",
		processStart: unstarted,
		processChildren: async () => [],
		client: fake.client,
		sessionId: HANGAR,
		projectsDir: projects,
		sessionsDir,
		redrawMs: 0,
		keyGapMs: 0,
		settleMs: 0,
		confirmMs: 10,
		foreignMs,
	});
}

test("listForeign names every claude block outside soma's agents, across sessions, with its state and cwd", async () => {
	const fake = rex(
		[
			// soma's own agents: one at work, one whose claude exited.
			{
				name: "card-a",
				block: "block:a",
				label: SESSION,
				argv0: "claude",
				records: [{ state: "working", updated_at: AT }],
			},
			{ name: "card-b", block: "block:b", label: SESSION, argv0: "-fish" },
			// A block a human split off an agent's window is no agent of soma's.
			{ name: "card-a", block: "block:a2", label: "mine", window: "window:block:a", argv0: "claude", pid: 105 },
		],
		[work, home],
	);

	const listed = await port(fake).listForeign();

	expect(listed).toEqual([
		{ id: "block:a2", session: "hangar", label: "card-a / mine" },
		{
			id: "block:w1",
			session: "work",
			label: "Window 1",
			status: { state: "working", msg: "refactoring" },
			cwd: "/repo/one",
		},
		{
			id: "block:w3b",
			session: "work",
			label: "Window 3 / right",
			status: { state: "blocked", kind: "question", msg: "answer: which?" },
			cwd: "/repo/two",
		},
		{ id: "block:w4", session: "work", label: "loose" },
		{ id: "block:h1", session: "home", label: "notes", status: { state: "done" } },
	]);
	// Read only: nothing typed, pressed, opened or closed anywhere, and no session joined, the hangar neither.
	expect(new Set(fake.methods())).toEqual(
		new Set([
			"session.view",
			"session.attach_all",
			"session.list_blocks",
			"com.superlogical.terminal.process",
			"com.superlogical.terminal.program_status",
			// The blocked one's screen, which shows no prompt that parses.
			"com.superlogical.terminal.format",
		]),
	);
	expect(fake.attached).toEqual([]);
	expect(fake.calls.find((call) => call.method === "session.attach_all")?.payload).toEqual({ event_scope: "session" });
});

test("listForeign is empty when every claude block is one of soma's agents", async () => {
	const fake = rex(
		[{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude" }],
		[{ id: "session:quiet", label: "quiet", blocks: [{ name: "w", block: "block:q", argv0: "-zsh" }] }],
	);

	expect(await port(fake).listForeign()).toEqual([]);
});

test("readForeignResult reads the transcript of the session the block's claude is in now", async () => {
	const cwd = "/repo/one";
	const dir = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
	mkdirSync(dir, { recursive: true });
	// The session before a /clear, and the one claude's session file names now.
	writeFileSync(
		join(dir, `${SESSION}.jsonl`),
		line({ type: "assistant", uuid: "a-old", message: { content: [{ type: "text", text: "old" }] } }),
	);
	writeFileSync(
		join(dir, `${OTHER}.jsonl`),
		line({ type: "user", uuid: "u-1", message: { role: "user", content: "go" } }) +
			line({ type: "assistant", uuid: "a-1", message: { content: [{ type: "text", text: "結果：完成" }] } }),
	);
	writeFileSync(join(sessionsDir, "101.json"), JSON.stringify({ pid: 101, sessionId: OTHER, cwd, status: "idle" }));

	const result = await port(rex([], [work])).readForeignResult("block:w1");

	expect(result).toEqual({ id: "a-1", text: "結果：完成" });
});

test("readForeignResult is undefined when claude's session file is missing or not the pid's", async () => {
	writeFileSync(join(sessionsDir, "102.json"), JSON.stringify({ pid: 999, sessionId: OTHER }));
	const reader = port(rex([], [work]));

	expect(await reader.readForeignResult("block:w3b")).toBeUndefined();
	expect(await reader.readForeignResult("block:w4")).toBeUndefined();
});

test("readForeignResult refuses a block that is no foreign agent: soma's own, one without claude, or none", async () => {
	const reader = port(rex([{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude" }], [work]));

	await expect(reader.readForeignResult("block:a")).rejects.toThrow("no foreign agent block:a");
	await expect(reader.readForeignResult("block:w2")).rejects.toThrow("no foreign agent block:w2");
	await expect(reader.readForeignResult("block:gone")).rejects.toThrow("no foreign agent block:gone");
});

test("readForeignScreen reads the foreign agent's block in its own session at every call, read only", async () => {
	const claude: Block = {
		name: "Window 1",
		block: "block:w1",
		argv0: "claude",
		records: [{ state: "working", updated_at: AT }],
		screen: "✻ Building improve-report-readability…",
	};
	const fake = rex([], [{ id: "session:work", label: "work", blocks: [claude] }]);
	const reader = port(fake);

	expect(await reader.readForeignScreen("block:w1")).toBe("✻ Building improve-report-readability…");
	claude.screen = "Do you want to open the PR?\n❯ 1. Yes\n  2. No";
	expect(await reader.readForeignScreen("block:w1")).toBe("Do you want to open the PR?\n❯ 1. Yes\n  2. No");

	expect(fake.calls.filter((call) => call.method.endsWith(".format")).map((call) => call.payload)).toEqual(
		Array(2).fill({
			session_id: "session:work",
			block_id: "block:w1",
			args: { format: "text", trim: true, max_bytes: 65_536 },
		}),
	);
	expect(fake.methods().filter((method) => method.endsWith(".write") || method === "block.event")).toEqual([]);
	expect(fake.attached).toEqual([]);
});

test("readForeignScreen reads a pane the human opened in soma's own hangar", async () => {
	const fake = rex([
		{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude", screen: "a job" },
		{ name: "mine", block: "block:m", argv0: "claude", screen: "the human's claude" },
	]);

	expect(await port(fake).readForeignScreen("block:m")).toBe("the human's claude");
	expect(fake.calls.find((call) => call.method.endsWith(".format"))?.payload).toMatchObject({
		session_id: HANGAR,
		block_id: "block:m",
	});
});

test("readForeignScreen refuses a block that is no foreign agent: soma's own, one without claude, or none", async () => {
	const fake = rex([{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude" }], [work]);
	const reader = port(fake);

	await expect(reader.readForeignScreen("block:a")).rejects.toThrow("no foreign agent block:a");
	await expect(reader.readForeignScreen("block:w2")).rejects.toThrow("no foreign agent block:w2");
	await expect(reader.readForeignScreen("block:gone")).rejects.toThrow("no foreign agent block:gone");
	// Only the listing's reads of the blocked one's prompt; no screen of a block refused.
	expect(
		new Set(fake.calls.filter((call) => call.method.endsWith(".format")).map((call) => call.payload.block_id)),
	).toEqual(new Set(["block:w3b"]));
});

const BASH = fixture("claude-bash-prompt-2.1.302.txt");
const prompt = readBlockedScreen(BASH).prompt;

test("a blocked foreign agent's status carries the prompt read off its screen, in its own session", async () => {
	const fake = rex(
		[],
		[
			{
				id: "session:work",
				label: "work",
				blocks: [
					{
						name: "w",
						block: "block:w1",
						argv0: "claude",
						records: [{ state: "blocked", kind: "permission", updated_at: AT }],
						screen: BASH,
					},
				],
			},
		],
	);

	const [listed] = await port(fake).listForeign();

	expect(listed?.status).toMatchObject({
		state: "blocked",
		kind: "permission",
		fingerprint: prompt?.fingerprint,
		options: prompt?.options.map(({ id, label }) => ({ id, label })),
	});
	expect(fake.calls.find((call) => call.method.endsWith(".format"))?.payload).toMatchObject({
		session_id: "session:work",
		block_id: "block:w1",
	});
});

test("a foreign agent's trust dialog, which claude reports a record for, names the repository root a yes trusts", async () => {
	const trust = fixture("claude-trust-dialog-2.1.302.txt");
	const human: Block = {
		name: "w",
		block: "block:w1",
		argv0: "claude",
		cwd: "/repo/one/.claude/worktrees/x",
		records: [{ state: "blocked", kind: "permission", msg: "trust this folder", updated_at: AT }],
		screen: trust,
	};
	const fake = rex([], [{ id: "session:work", label: "work", blocks: [human] }]);
	const { git: run } = git("worktree /repo/one\nHEAD abc\nbranch refs/heads/main\n");

	const [listed] = await createRexAgentPort({
		label: "soma-test",
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		git: run,
		redrawMs: 0,
	}).listForeign();

	expect(listed?.status).toMatchObject({
		state: "blocked",
		kind: "permission",
		msg: `${readBlockedScreen(trust).msg}\nAnswering yes trusts the repository root /repo/one, and with it every worktree of that repository.`,
		fingerprint: readBlockedScreen(trust).prompt?.fingerprint,
	});
});

/** A session whose window "Window 1" holds a claude blocked at a Bash prompt and a shell beside it. */
function blockedWork(): { session: Session; claude: Block; shell: Block; other: Block } {
	const claude: Block = {
		name: "Window 1",
		block: "block:w1",
		window: "window:1",
		argv0: "claude",
		records: [{ state: "blocked", kind: "permission", updated_at: AT }],
		screen: BASH,
	};
	const shell: Block = { name: "Window 1", block: "block:w1b", window: "window:1", argv0: "-fish" };
	const other: Block = { name: "Window 2", block: "block:w2", argv0: "-fish" };
	return { session: { id: "session:work", label: "work", blocks: [claude, shell, other] }, claude, shell, other };
}

async function watching(fake: ReturnType<typeof rex>) {
	const events: ForeignStatusEvent[] = [];
	const off = port(fake, 1_000).onForeignStatus((event) => events.push(event));
	await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
	return { events, off };
}

test("onForeignStatus reports a blocked foreign agent unwatched while no rex app shows its pane", async () => {
	const { session, other } = blockedWork();
	// The app last showed another window; the phone is gone; a command line client asked last of all.
	other.desired = { "client:mac": "2026-10-27T01:05:00.000001+08:00", "client:cli": "2026-10-27T01:09:00+08:00" };
	session.blocks[0] = { ...session.blocks[0], desired: { "client:phone": "2026-10-27T01:08:00+08:00" } } as Block;
	const clients: Client[] = [
		{ id: "client:mac", kind: "app" },
		{ id: "client:phone", kind: "app", state: "lost" },
		{ id: "client:cli", kind: "cli" },
	];
	const { events, off } = await watching(rex([], [session], clients));
	off();

	expect(events).toEqual([
		{
			agent: expect.objectContaining({
				id: "block:w1",
				session: "work",
				status: expect.objectContaining({ state: "blocked", fingerprint: prompt?.fingerprint }),
			}),
			seq: AT_US,
			watched: false,
		},
	]);
});

test("onForeignStatus reports a blocked foreign agent watched while an app shows its window, and again once not", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	try {
		const { session, shell, other } = blockedWork();
		// The app last asked the size of the shell beside claude, so it shows the window both are in.
		shell.desired = { "client:mac": "2026-10-27T01:05:00.000002+08:00" };
		other.desired = { "client:mac": "2026-10-27T01:05:00.000001+08:00" };
		const fake = rex([], [session], [{ id: "client:mac", kind: "app", state: "connected" }]);
		const { events, off } = await watching(fake);
		expect(events.map(({ seq, watched }) => ({ seq, watched }))).toEqual([{ seq: AT_US, watched: true }]);

		// Looked at again with nothing changed: nothing new.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(events).toHaveLength(1);

		// The human went to the other window.
		other.desired = { "client:mac": "2026-10-27T01:06:00+08:00" };
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.waitFor(() => expect(events).toHaveLength(2));
		expect(events[1]).toMatchObject({ seq: AT_US, watched: false });
		off();
	} finally {
		vi.useRealTimers();
	}
});

test("onForeignStatus reports a new seq, and a status that is not blocked without reading who looks", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	try {
		const { session, claude } = blockedWork();
		claude.records = [{ state: "working", updated_at: AT }];
		const fake = rex([], [session], [{ id: "client:mac", kind: "app" }]);
		const { events, off } = await watching(fake);

		claude.records = [{ state: "idle", updated_at: "2026-10-27T01:02:04+08:00" }];
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.waitFor(() => expect(events).toHaveLength(2));
		off();

		expect(events.map(({ agent, watched }) => [agent.status.state, watched])).toEqual([
			["working", false],
			["idle", false],
		]);
		expect(fake.methods()).not.toContain("client.list");
		expect(fake.methods()).not.toContain("com.superlogical.terminal.size");
	} finally {
		vi.useRealTimers();
	}
});

const blockedRecord = [{ state: "blocked", kind: "permission", updated_at: AT }];

/** soma's own agent blocked in the hangar, and a foreign one in the session `work` with `block` set on it. */
function blockedForeign(block: Partial<Block> = {}) {
	return rex(
		[{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude", records: blockedRecord, screen: BASH }],
		[
			{
				id: "session:work",
				label: "work",
				blocks: [{ name: "w", block: "block:w1", argv0: "claude", records: blockedRecord, screen: BASH, ...block }],
			},
		],
	);
}

const pressed = (fake: ReturnType<typeof rex>) =>
	fake.calls
		.filter((call) => call.method === "block.event")
		.map((call) => {
			const { session_id, block_id, event } = call.payload as {
				session_id: string;
				block_id: string;
				event: { payload: { key: string; action: string } };
			};
			return `${session_id} ${block_id} ${event.payload.key}:${event.payload.action}`;
		});

test("respondForeign presses the option's key on the foreign agent's own block, in its own session", async () => {
	const fake = blockedForeign();

	const outcome = await port(fake).respondForeign("block:w1", { option: "1", fingerprint: prompt?.fingerprint ?? "" });

	expect(outcome).toEqual({ sent: true });
	expect(pressed(fake)).toEqual(["session:work block:w1 digit_1:press", "session:work block:w1 digit_1:release"]);
});

test("respondForeign presses no Enter while the foreign agent's screen does not show the cursor on the option", async () => {
	const screen = fixture("claude-trust-dialog-2.1.302.txt");
	const records = [{ state: "blocked", kind: "permission", updated_at: AT }];
	const human = { name: "shell", block: "block:w1", argv0: "claude", records, screen };
	const fake = rex([], [{ id: "session:work", label: "work", blocks: [human] }]);
	fake.replace("block.event", () => ({}));
	const fingerprint = readBlockedScreen(screen).prompt?.fingerprint ?? "";

	const outcome = await port(fake).respondForeign("block:w1", { option: "2", fingerprint });

	expect(outcome).toEqual({ sent: false, refusal: "unreadable" });
	const pressed = fake.calls
		.filter((call) => call.method === "block.event")
		.map((call) => (call.payload.event as { payload: { key: string; action: string } }).payload)
		.filter(({ action }) => action === "press");
	expect(pressed.map(({ key }) => key)).toEqual(["arrow_down"]);
});

test("respondForeign refuses auth whether the record or the screen names it, and any other refusal, pressing nothing", async () => {
	const cases: [Partial<Block>, string | undefined, string][] = [
		[{ records: [{ state: "blocked", kind: "auth", updated_at: AT }] }, prompt?.fingerprint, "auth"],
		[{ screen: fixture("claude-custom-api-key-2.1.302.txt") }, "f", "auth"],
		[{}, "0123456789abcdef", "stale"],
		[{ records: [{ state: "working", updated_at: AT }] }, prompt?.fingerprint, "not_blocked"],
		// No record: soma does not answer the trust dialog of a claude it did not start.
		[{ records: [], screen: fixture("claude-trust-dialog-2.1.302.txt") }, "1", "not_blocked"],
	];
	for (const [block, fingerprint, refusal] of cases) {
		const fake = blockedForeign(block);
		const outcome = await port(fake).respondForeign("block:w1", { option: "1", fingerprint: fingerprint ?? "" });
		expect(outcome).toEqual({ sent: false, refusal });
		expect(pressed(fake)).toEqual([]);
	}
});

test("respondForeign throws for an id that names no foreign agent: soma's own agent, or none", async () => {
	const fake = blockedForeign();
	const answer = { option: "1", fingerprint: prompt?.fingerprint ?? "" };

	await expect(port(fake).respondForeign("block:a", answer)).rejects.toThrow("no foreign agent block:a");
	await expect(port(fake).respondForeign("block:gone", answer)).rejects.toThrow("no foreign agent block:gone");
	expect(pressed(fake)).toEqual([]);
});

/** What was pasted or written, on which block of which session. */
const typed = (fake: ReturnType<typeof rex>) =>
	fake.calls
		.filter((call) => call.method === "block.event" || call.method.endsWith(".write"))
		.map((call) => {
			const { session_id, block_id, event, args } = call.payload as {
				session_id: string;
				block_id: string;
				event?: { type: string; payload: { text?: string } };
				args?: { data: string };
			};
			return `${session_id} ${block_id} ${event ? `${event.type}:${event.payload.text}` : `write:${JSON.stringify(args?.data)}`}`;
		});

test.each([
	// Still idle once confirmMs passes, so \r is sent once more, as for a job.
	[
		"idle",
		["session:work block:w1 paste:go on", 'session:work block:w1 write:"\\r"', 'session:work block:w1 write:"\\r"'],
	],
	["done", ["session:work block:w1 paste:go on", 'session:work block:w1 write:"\\r"']],
])("promptForeign sends a %s foreign agent the prompt on its own block, in its own session", async (state, sent) => {
	const fake = blockedForeign({ records: [{ state, updated_at: AT }] });

	await port(fake).promptForeign("block:w1", "go on");

	expect(typed(fake)).toEqual(sent);
});

test.each([
	["working", [{ state: "working", updated_at: AT }]],
	["blocked", blockedRecord],
	["without a status record", []],
])("promptForeign refuses a foreign agent that is %s, with the reason, typing nothing", async (state, records) => {
	const fake = blockedForeign({ records });

	const prompted = port(fake).promptForeign("block:w1", "go on");

	await expect(prompted).rejects.toThrow(`rex foreign agent block:w1 is ${state}: a prompt goes only to idle or done`);
	await expect(prompted).rejects.toBeInstanceOf(PromptRefused);
	expect(typed(fake)).toEqual([]);
});

test("promptForeign re-reads the state just before sending: one that turned working since it was listed is refused", async () => {
	const fake = blockedForeign({ records: [{ state: "idle", updated_at: AT }] });
	let reads = 0;
	fake.replace("com.superlogical.terminal.program_status", (payload) =>
		payload.block_id === "block:w1" && ++reads > 1
			? { records: [{ state: "working", updated_at: AT }] }
			: fake.original("com.superlogical.terminal.program_status")(payload),
	);

	const prompted = port(fake).promptForeign("block:w1", "go on");

	await expect(prompted).rejects.toThrow("rex foreign agent block:w1 is working");
	expect(reads).toBe(2);
	expect(typed(fake)).toEqual([]);
});

test("two prompts to one foreign agent at once go one after the other: the second finds it working and is refused", async () => {
	const fake = blockedForeign({ records: [{ state: "idle", updated_at: AT }] });
	// claude turns working once a \r reaches it.
	let entered = false;
	const write = fake.original("com.superlogical.terminal.write");
	const status = fake.original("com.superlogical.terminal.program_status");
	fake.replace("com.superlogical.terminal.write", (payload) => {
		entered = true;
		return write(payload);
	});
	fake.replace("com.superlogical.terminal.program_status", (payload) =>
		entered && payload.block_id === "block:w1" ? { records: [{ state: "working", updated_at: AT }] } : status(payload),
	);
	const sender = port(fake);

	const [first, second] = await Promise.allSettled([
		sender.promptForeign("block:w1", "first"),
		sender.promptForeign("block:w1", "second"),
	]);

	expect(first.status).toBe("fulfilled");
	expect(second).toMatchObject({ status: "rejected", reason: expect.any(PromptRefused) });
	expect(typed(fake)).toEqual(["session:work block:w1 paste:first", 'session:work block:w1 write:"\\r"']);
});

test("promptForeign refuses an id that names no foreign agent: soma's own agent, or none", async () => {
	const fake = blockedForeign({ records: [{ state: "idle", updated_at: AT }] });

	await expect(port(fake).promptForeign("block:a", "go")).rejects.toThrow("no foreign agent block:a");
	await expect(port(fake).promptForeign("block:a", "go")).rejects.toBeInstanceOf(PromptRefused);
	await expect(port(fake).promptForeign("block:gone", "go")).rejects.toThrow("no foreign agent block:gone");
	expect(typed(fake)).toEqual([]);
});

test("a session whose label starts with soma- never holds a foreign agent, any other session does", async () => {
	const claude = (block: string): Block => ({
		name: "w",
		block,
		argv0: "claude",
		records: blockedRecord,
		screen: BASH,
	});
	const fake = rex(
		[],
		[
			{ id: "session:prod", label: "soma-hangar", blocks: [claude("block:prod")] },
			{ id: "session:smoke", label: "soma-smoke-edde1b", blocks: [claude("block:smoke")] },
			{ id: "session:smoke-hangar", label: "soma-smoke-edde1b-hangar", blocks: [claude("block:smoke2")] },
			{ id: "session:mine", label: "somatic", blocks: [claude("block:mine")] },
			{ id: "session:work", label: "work", blocks: [claude("block:work")] },
		],
	);

	const listed = await port(fake).listForeign();

	expect(listed.map(({ id }) => id)).toEqual(["block:mine", "block:work"]);
	// Their blocks are not even looked at, so no screen of theirs is read or typed on.
	expect(fake.calls.filter((call) => call.method.endsWith(".process")).map((call) => call.payload.block_id)).toEqual([
		"block:mine",
		"block:work",
	]);
});

test("a claude pane a human opens in soma's own hangar is foreign, though the hangar's label starts with soma-", async () => {
	const fake = rex(
		[
			{
				name: "card-a",
				block: "block:a",
				label: SESSION,
				argv0: "claude",
				records: [{ state: "idle", updated_at: AT }],
			},
			{ name: "card-a", block: "block:split", label: "mine", window: "window:block:a", argv0: "claude", pid: 7 },
			{ name: "scratch", block: "block:scratch", argv0: "claude", pid: 8, cwd: "/repo/scratch" },
			{ name: "shell", block: "block:shell", argv0: "-fish" },
		],
		[],
		[],
		"soma-hangar",
	);

	const listed = await port(fake).listForeign();

	expect(listed).toEqual([
		{ id: "block:split", session: "soma-hangar", label: "card-a / mine" },
		{ id: "block:scratch", session: "soma-hangar", label: "scratch", cwd: "/repo/scratch" },
	]);
});

test("a pane running a soma job in the hangar is not foreign, whether the hangar is labelled soma- or not", async () => {
	for (const label of ["soma-hangar", "hangar"]) {
		const fake = rex(
			[
				{
					name: "card-a",
					block: "block:a",
					label: SESSION,
					argv0: "claude",
					records: [{ state: "working", updated_at: AT }],
				},
				{
					name: "card-b",
					block: "block:b",
					label: SESSION,
					argv0: "claude",
					records: [{ state: "idle", updated_at: AT }],
				},
			],
			[],
			[],
			label,
		);

		expect(await port(fake).listForeign()).toEqual([]);
	}
});

test("a soma job is never foreign, however its block sits in the hangar", async () => {
	const fake = rex(
		[
			// Detached, in no window.
			{ name: "", block: "block:detached", label: SESSION, detached: true, argv0: "claude" },
			// Behind a block a human split off, so the window's first block is not the job's.
			{ name: "card-b", block: "block:human", label: "mine", window: "window:b", argv0: "claude" },
			{ name: "card-b", block: "block:job", label: OTHER, window: "window:b", argv0: "claude" },
		],
		[],
		[],
		"soma-hangar",
	);

	const listed = await port(fake).listForeign();

	expect(listed.map(({ id }) => id)).toEqual(["block:human"]);
});

test("a hangar window whose block carries a label that is no session id is foreign", async () => {
	const fake = rex(
		[
			{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude" },
			{ name: "tab", block: "block:tab", label: "shell", argv0: "claude" },
			{ name: "almost", block: "block:almost", label: SESSION.slice(1), argv0: "claude" },
		],
		[],
		[],
		"soma-hangar",
	);

	const listed = await port(fake).listForeign();

	expect(listed.map(({ id }) => id)).toEqual(["block:tab", "block:almost"]);
});

test("another soma- session stays unlisted while soma's own hangar is listed", async () => {
	const claude = (block: string): Block => ({ name: "w", block, argv0: "claude" });
	const fake = rex(
		[
			{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude" },
			{ name: "scratch", block: "block:scratch", argv0: "claude" },
		],
		[
			{ id: "session:prod", label: "soma-hangar", blocks: [claude("block:prod")] },
			{ id: "session:dev-hangar", label: "soma-dev-1234", blocks: [claude("block:dev")] },
			{ id: "session:smoke", label: "soma-smoke-edde1b", blocks: [claude("block:smoke")] },
			{ id: "session:work", label: "work", blocks: [claude("block:work")] },
		],
		[],
		"soma-hangar-mine",
	);

	const listed = await port(fake).listForeign();

	expect(listed.map(({ id, session }) => [id, session])).toEqual([
		["block:scratch", "soma-hangar-mine"],
		["block:work", "work"],
	]);
	expect(fake.calls.filter((call) => call.method.endsWith(".process")).map((call) => call.payload.block_id)).toEqual([
		"block:scratch",
		"block:work",
	]);
});

/** A foreign agent blocked at the Bash prompt in a window of its own, and the app that showed another window last. */
function looked(shows: "claude" | "other") {
	const { session, claude, other } = blockedWork();
	const asked = "2026-10-27T01:05:00.000001+08:00";
	if (shows === "claude") claude.desired = { "client:mac": asked };
	else other.desired = { "client:mac": asked };
	return rex([], [session], [{ id: "client:mac", kind: "app" }]);
}

test("a null client_id in a size reply is ignored, and the other entries still count", async () => {
	const fake = looked("claude");
	const size = fake.original("com.superlogical.terminal.size");
	fake.replace("com.superlogical.terminal.size", (payload) => {
		const reply = size(payload) as { desired: object[] };
		return { ...reply, desired: [{ client_id: null, updated_at: AT }, ...reply.desired] };
	});

	const { events, off } = await watching(fake);
	off();

	expect(events.map(({ watched }) => watched)).toEqual([true]);
});

test("a pane whose presence cannot be read counts as not looked at, and is pushed", async () => {
	const unreadable = (): never => {
		throw new Error("closed");
	};
	const failures: [string, () => unknown][] = [
		["client.list", unreadable],
		["client.list", () => ({ clients: [{ client_id: 7 }] })],
		["session.list_blocks", unreadable],
		["session.list_blocks", () => ({ blocks: "none" })],
		["com.superlogical.terminal.size", unreadable],
		["com.superlogical.terminal.size", () => ({ desired: [{ client_id: "client:mac", updated_at: 5 }] })],
	];
	for (const [method, reply] of failures) {
		// The app is showing the pane's window, so a readable presence would say watched.
		const fake = looked("claude");
		const original = fake.original(method);
		// The listing of foreign agents reads list_blocks and size's neighbours first; only presence follows client.list.
		fake.replace(method, (payload) =>
			method !== "session.list_blocks" || fake.methods().includes("client.list") ? reply() : original(payload),
		);
		const { events, off } = await watching(fake);
		off();

		expect(
			events.map(({ watched }) => watched),
			method,
		).toEqual([false]);
	}
});

const HANDED = "7e33597b-e33d-4c6d-a700-e21b2f54223e";
// When each pid's process started, as ps tells it, and the same instant as claude writes it in its pid file.
const STARTED = Date.parse("2026-11-23T06:31:33Z");
const LSTART = "Mon Nov 23 06:31:33 2026";
const desk: Session = {
	id: "session:desk",
	label: "desk",
	blocks: [
		{ name: "one", block: "block:d1", argv0: "claude", pid: 201, records: [{ state: "idle", updated_at: AT }] },
		{ name: "two", block: "block:d2", argv0: "claude", pid: 202, records: [{ state: "done", updated_at: AT }] },
		{ name: "three", block: "block:d3", argv0: "claude", pid: 203, records: [{ state: "idle", updated_at: AT }] },
	],
};

/** A pid file as claude writes it, started when ps says unless `procStart` says otherwise, or with no start for null. */
const pidFile = (pid: number, sessionId: string, procStart: string | null = LSTART) =>
	writeFileSync(
		join(sessionsDir, `${pid}.json`),
		JSON.stringify({ pid, sessionId, ...(procStart === null ? {} : { procStart }), startedAt: STARTED + 905 }),
	);

/** A port on these sessions whose processes all started at STARTED but those in `gone`, and with these children. */
function finder(blocks: Block[], others: Session[], children: Record<number, number[]> = {}, gone: number[] = []) {
	return createRexAgentPort({
		label: "soma-test",
		processStart: async (pid) => (gone.includes(pid) ? undefined : STARTED),
		processChildren: async (pid) => children[pid] ?? [],
		client: rex(blocks, others).client,
		sessionId: HANGAR,
		projectsDir: projects,
		sessionsDir,
	});
}

test("findForeignSession names the foreign pane whose claude is in the session now, off its pid file", async () => {
	pidFile(201, OTHER);
	pidFile(202, HANDED.toUpperCase());
	// 203 has no pid file, nor a child.
	const port = finder([], [desk]);

	expect(await port.findForeignSession(HANDED)).toBe("block:d2");
	expect(await port.findForeignSession(OTHER)).toBe("block:d1");
	expect(await port.findForeignSession("0e9d6c1f-4a3b-4a52-9c85-2f6d3f6f2f10")).toBeUndefined();
});

test("findForeignSession matches no pane whose pid file names another session or is not its pid's, nor soma's own job", async () => {
	pidFile(201, OTHER);
	writeFileSync(join(sessionsDir, "202.json"), JSON.stringify({ pid: 999, sessionId: HANDED, procStart: LSTART }));
	pidFile(301, HANDED);
	// soma's own job runs that session in the hangar: it is no foreign agent.
	const port = finder([{ name: "card-a", block: "block:a", label: SESSION, argv0: "claude", pid: 301 }], [desk]);

	expect(await port.findForeignSession(HANDED)).toBeUndefined();
});

test("findForeignSession matches no pid file whose start is not its process's now, or cannot be read", async () => {
	const shells: Session = {
		id: "session:shells",
		label: "shells",
		blocks: [
			{ name: "one", block: "block:t1", argv0: "claude", pid: 211, records: [{ state: "idle", updated_at: AT }] },
			{ name: "two", block: "block:t2", argv0: "claude", pid: 212, records: [{ state: "idle", updated_at: AT }] },
			{ name: "three", block: "block:t3", argv0: "claude", pid: 213, records: [{ state: "idle", updated_at: AT }] },
		],
	};
	// A file a dead claude left an hour before the process now under its pid started; one with no start; one whose
	// process start ps cannot tell.
	pidFile(211, HANDED, "Mon Nov 23 05:31:33 2026");
	pidFile(212, HANDED, null);
	pidFile(213, HANDED);

	expect(await finder([], [shells], {}, [213]).findForeignSession(HANDED)).toBeUndefined();
	pidFile(212, HANDED);
	expect(await finder([], [shells], {}, [213]).findForeignSession(HANDED)).toBe("block:t2");
});

test("findForeignSession throws when rex cannot be listed", async () => {
	const fake = rex([], [desk]);
	fake.replace("session.attach_all", () => {
		throw new Error("rex is away");
	});

	await expect(port(fake).findForeignSession(HANDED)).rejects.toThrow("rex is away");
});

test("findForeignSession reads the pid file a pane's claude writes under its one child only when it has none of its own", async () => {
	const split: Session = {
		id: "session:split",
		label: "split",
		blocks: [
			{ name: "one", block: "block:s1", argv0: "claude", pid: 401, records: [{ state: "idle", updated_at: AT }] },
			{ name: "two", block: "block:s2", argv0: "claude", pid: 403, records: [{ state: "idle", updated_at: AT }] },
			{ name: "three", block: "block:s3", argv0: "claude", pid: 501, records: [{ state: "idle", updated_at: AT }] },
		],
	};
	// 401 writes no file of its own and its child 402 does. 403's child 404 has none, and 405 is no child of a pane.
	// 501 names another session in its own file, so its child 502, though it names the session, is not that pane's claude.
	pidFile(402, HANDED);
	pidFile(405, OTHER);
	pidFile(501, OTHER);
	pidFile(502, HANDED);
	const children = { 401: [402], 403: [404], 501: [502] };

	expect(await finder([], [split], children).findForeignSession(HANDED)).toBe("block:s1");
	expect(await finder([], [split], children).findForeignSession(OTHER)).toBe("block:s3");
	// The one child's file is stale, its pid reused by a process started since.
	expect(await finder([], [split], children, [402]).findForeignSession(HANDED)).toBeUndefined();
	// 501's own file is read, and its child's is not.
	expect(await finder([], [split], { 501: [502] }).findForeignSession(HANDED)).toBeUndefined();
});
