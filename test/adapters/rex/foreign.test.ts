import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { createRexAgentPort } from "../../../src/adapters/rex/agent-port.ts";
import { readBlockedScreen } from "../../../src/agent-cli/permission/blocked-screen.ts";
import type { ForeignStatusEvent } from "../../../src/ports/agent.ts";
import { AT, AT_US, type Block, type Client, fixture, HANGAR, rex, SESSION, type Session } from "./fake.ts";

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
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		projectsDir: projects,
		sessionsDir,
		redrawMs: 0,
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
	// Read only: nothing typed, pressed, opened or closed anywhere, and no session joined but the hangar.
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
	expect(fake.attached).toEqual([HANGAR]);
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
