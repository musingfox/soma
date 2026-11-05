import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { createRexAgentPort } from "../../../src/adapters/rex/agent-port.ts";
import { AT, HANGAR, rex, SESSION, type Session } from "./fake.ts";

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

function port(fake: ReturnType<typeof rex>) {
	return createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		projectsDir: projects,
		sessionsDir,
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
