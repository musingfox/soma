import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { createRexAgentPort, type RexAgentPortOptions } from "../../../src/adapters/rex/agent-port.ts";
import { RexRpcError } from "../../../src/adapters/rex/client.ts";
import { hangarFile } from "../../../src/adapters/rex/hangar-file.ts";
import { readBlockedScreen } from "../../../src/agent-cli/permission/blocked-screen.ts";
import { AT, type Block, fixture, git, HANGAR, rex, SESSION, type Session } from "./fake.ts";

const root = mkdtempSync(join(tmpdir(), "soma-rex-hangar-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const unstarted = async () => undefined;
const request = { name: "card-a", card: "card-a", cwd: "/nonexistent/repo", sessionId: SESSION };
const MADE = "session:made-1";
const BASH = fixture("claude-bash-prompt-2.1.302.txt");

const work: Session = {
	id: "session:work",
	label: "work",
	blocks: [
		{
			name: "Window 1",
			block: "block:w1",
			argv0: "claude",
			records: [{ state: "idle", updated_at: AT }],
			screen: "> ",
		},
		{
			name: "Window 2",
			block: "block:w2",
			argv0: "claude",
			records: [{ state: "blocked", kind: "permission", updated_at: AT }],
			screen: BASH,
		},
	],
};

function port(fake: ReturnType<typeof rex>, options: Partial<RexAgentPortOptions> = {}) {
	return createRexAgentPort({
		processStart: unstarted,
		client: fake.client,
		sessionId: HANGAR,
		git: git().git,
		confirmMs: 5,
		keyGapMs: 1,
		settleMs: 0,
		redrawMs: 1,
		takeMs: 200,
		onError: () => {},
		...options,
	});
}

const creates = (fake: ReturnType<typeof rex>) =>
	fake.calls.filter((call) => call.method === "session.create").map((call) => call.payload);
const windows = (fake: ReturnType<typeof rex>) =>
	fake.calls.filter((call) => call.method === "session.new_window").map((call) => call.payload.session_id);

test("a hangar rex does not know is made anew with the configured label, and start opens its window there", async () => {
	const fake = rex([]);
	fake.lose();
	const fleet = port(fake, { label: "fleet-hangar" });

	await fleet.start(request);

	expect(creates(fake)).toEqual([{ label: "fleet-hangar" }]);
	expect(fake.made.map(({ id, label }) => ({ id, label }))).toEqual([{ id: MADE, label: "fleet-hangar" }]);
	expect(fleet.hangar).toBe(MADE);
	expect(windows(fake)).toEqual([MADE]);
	expect(fake.attached).not.toContain(HANGAR);
	expect(fake.attached).toContain(MADE);
});

test("with no label configured, the hangar made is labelled soma-hangar, and a handover opens its window there", async () => {
	const worktree = join(root, "worktree");
	const projectsDir = join(root, "projects");
	const claude = "5b1c0d2e-3f40-4a51-8b62-7c83d94e0a15";
	const transcripts = join(projectsDir, worktree.replace(/[^a-zA-Z0-9]/g, "-"));
	mkdirSync(worktree, { recursive: true });
	mkdirSync(transcripts, { recursive: true });
	const reply = { role: "assistant", id: "m", content: [{ type: "text", text: "ok" }], model: "claude-haiku-9" };
	writeFileSync(
		join(transcripts, `${claude}.jsonl`),
		`${JSON.stringify({ type: "assistant", uuid: "a-1", cwd: worktree, message: reply })}\n`,
	);
	const fake = rex([]);
	fake.lose();
	// The window opens in whichever session it names, as rex's does.
	fake.replace("session.new_window", ({ session_id, window_label, layout }) => {
		const { label } = (layout as { block: { label: string } }).block;
		const records = [{ state: "idle", updated_at: AT }];
		const block: Block = { name: window_label as string, block: "block:new", label, argv0: "claude", records };
		fake.made.find(({ id }) => id === session_id)?.blocks.push(block);
		return { window_id: "window:new", block_ids: ["block:new"], revision: 2 };
	});
	const taker = port(fake, { projectsDir });

	const taken = await taker.take({
		name: "card-a",
		card: "card-a",
		sessionId: SESSION,
		claudeSession: claude,
		cwd: worktree,
	});

	expect(creates(fake)).toEqual([{ label: "soma-hangar" }]);
	expect(taken).toEqual({ window: "card-a", session: "soma-hangar", ready: true });
	expect(windows(fake)).toEqual([MADE]);
	expect(taker.hangar).toBe(MADE);
	expect((await taker.list()).map(({ name }) => name)).toEqual(["card-a"]);
});

test("a port made again over what was remembered uses the hangar made before, and makes one more once it is gone", async () => {
	const memory = join(root, "rex-hangar.json");
	const fake = rex([]);
	fake.lose();
	const first = port(fake, { memory: hangarFile(memory) });
	expect(await first.list()).toEqual([]);
	expect(first.hangar).toBe(MADE);

	const restarted = port(fake, { memory: hangarFile(memory) });
	expect(restarted.hangar).toBe(MADE);
	await restarted.list();
	await restarted.start(request);
	expect(creates(fake)).toHaveLength(1);
	expect(windows(fake)).toEqual([MADE]);

	fake.lose(MADE);
	await restarted.list();
	expect(creates(fake)).toHaveLength(2);
	expect(restarted.hangar).toBe("session:made-2");
	expect(port(fake, { memory: hangarFile(memory) }).hangar).toBe("session:made-2");
	// What was made in place of one configured hangar is nothing to a config that names another.
	expect(port(fake, { memory: hangarFile(memory), sessionId: "session:other" }).hangar).toBe("session:other");
});

test("foreign agents of other sessions are listed, read, answered and prompted while the hangar is gone and none can be made", async () => {
	const fake = rex([], [work]);
	fake.lose();
	const reader = port(fake);
	const listed = [
		{ id: "block:w1", session: "work", label: "Window 1", status: { state: "idle" } },
		{ id: "block:w2", session: "work", label: "Window 2", status: expect.objectContaining({ state: "blocked" }) },
	];

	expect(await reader.listForeign()).toEqual(listed);

	fake.replace("session.create", () => {
		throw new RexRpcError("session.create", "conflict", "the server has as many sessions as it allows", 409);
	});
	expect(await reader.list()).toEqual([]);
	expect(await reader.listForeign()).toEqual(listed);
	expect(await reader.readForeignScreen("block:w1")).toBe("> ");
	await reader.promptForeign("block:w1", "go on");
	const fingerprint = readBlockedScreen(BASH).prompt?.fingerprint ?? "";
	expect(await reader.respondForeign("block:w2", { option: "1", fingerprint })).toEqual({ sent: true });
	expect(
		fake.calls.filter((call) => call.method === "block.event").map((call) => call.payload.session_id),
	).not.toContain(HANGAR);
	expect(fake.made).toEqual([]);
});

test("a lost hangar is logged once, naming it and the one made, however many calls find it gone", async () => {
	const fake = rex([], [work]);
	fake.lose();
	const errors: string[] = [];
	const logged = port(fake, { onError: (error) => errors.push(error.message) });
	const seen: unknown[] = [];
	const off = logged.onStatus((event) => seen.push(event));

	await Promise.all([logged.list(), logged.list(), logged.listForeign(), logged.start(request)]);
	fake.reconnect();
	await logged.list();
	await logged.listForeign();
	// The watch's reads, after the first and after the reconnect, are done.
	await new Promise((resolve) => setTimeout(resolve, 20));
	off();

	expect(creates(fake)).toHaveLength(1);
	expect(errors).toEqual([
		`rex hangar ${HANGAR} does not exist: made ${MADE}, labelled soma-hangar, the hangar from now on`,
	]);
});

test("a hangar rex will not make is logged once, however often the watch reads the hangar", async () => {
	const fake = rex([]);
	fake.lose();
	fake.replace("session.create", () => {
		throw new RexRpcError("session.create", "conflict", "the server has as many sessions as it allows", 409);
	});
	const errors: string[] = [];
	const watched = port(fake, { trustMs: 5, onError: (error) => errors.push(error.message) });
	const off = watched.onStatus(() => {});

	// The trust check reads the hangar every trustMs while none could be read.
	await new Promise((resolve) => setTimeout(resolve, 60));
	expect(await watched.list()).toEqual([]);
	off();

	expect(creates(fake).length).toBeGreaterThan(2);
	expect(errors).toEqual([
		`rex hangar ${HANGAR} does not exist, and no hangar was made in its place: session.create: conflict: the server has as many sessions as it allows`,
	]);
});

/** A watched hangar holding a job's block with no root record, which the trust check reads every trustMs. */
async function watchedShell() {
	const fake = rex([{ name: "shell", block: "block:s", label: SESSION, argv0: "-fish", records: [] }]);
	const errors: string[] = [];
	const watched = port(fake, { trustMs: 5, onError: (error) => errors.push(error.message) });
	const off = watched.onStatus(() => {});
	await new Promise((resolve) => setTimeout(resolve, 30));
	/** The calls on the shell's block after the hangar was made anew. */
	const afterMade = () => {
		const made = fake.calls.findIndex((call) => call.method === "session.create");
		return fake.calls.slice(made).filter((call) => call.payload.block_id === "block:s");
	};
	return { fake, errors, watched, off, afterMade };
}

test("a hangar lost under the watch, the connection up, is made anew once, and its blocks are read no more", async () => {
	const { fake, errors, watched, off, afterMade } = await watchedShell();

	fake.lose();
	await new Promise((resolve) => setTimeout(resolve, 100));
	off();

	expect(creates(fake)).toHaveLength(1);
	expect(watched.hangar).toBe(MADE);
	expect(afterMade()).toEqual([]);
	expect(errors).toEqual([
		`rex hangar ${HANGAR} does not exist: made ${MADE}, labelled soma-hangar, the hangar from now on`,
	]);
});

test("a status event read from a hangar lost since makes it anew and is not retried as a failed read", async () => {
	const block: Block = { name: "card-a", block: "block:a", label: SESSION, argv0: "claude", records: [] };
	const fake = rex([block]);
	const errors: string[] = [];
	const watched = port(fake, { retryMs: 5, onError: (error) => errors.push(error.message) });
	const off = watched.onStatus(() => {});
	await new Promise((resolve) => setTimeout(resolve, 20));

	fake.lose();
	fake.emit(fake.status("block:a", { state: "done", updated_at: AT }));
	await new Promise((resolve) => setTimeout(resolve, 100));
	off();

	expect(creates(fake)).toHaveLength(1);
	expect(watched.hangar).toBe(MADE);
	const made = fake.calls.findIndex((call) => call.method === "session.create");
	expect(fake.calls.slice(made).filter((call) => call.payload.block_id === "block:a")).toEqual([]);
	expect(errors).toEqual([
		`rex hangar ${HANGAR} does not exist: made ${MADE}, labelled soma-hangar, the hangar from now on`,
	]);
});

test("a hangar another call made anew holds none of the blocks the watch read from the lost one", async () => {
	const { fake, errors, watched, off, afterMade } = await watchedShell();

	fake.lose();
	await watched.list();
	await new Promise((resolve) => setTimeout(resolve, 100));
	off();

	expect(creates(fake)).toHaveLength(1);
	expect(afterMade()).toEqual([]);
	expect(errors).toHaveLength(1);
});

test("a hangar lost under the watch that rex will not make anew is logged once, and its blocks are read no more", async () => {
	const { fake, errors, off, afterMade } = await watchedShell();

	fake.replace("session.create", () => {
		throw new RexRpcError("session.create", "conflict", "the server has as many sessions as it allows", 409);
	});
	fake.lose();
	await new Promise((resolve) => setTimeout(resolve, 100));
	off();

	expect(creates(fake).length).toBeGreaterThan(1);
	expect(afterMade()).toEqual([]);
	expect(errors).toEqual([expect.stringContaining(`rex hangar ${HANGAR} does not exist, and no hangar was made`)]);
});

test("a hangar rex will not make at startup lists no job, is logged once, and is made by a later call once rex allows it", async () => {
	const fake = rex([], [work]);
	fake.lose();
	fake.replace("session.create", () => {
		throw new RexRpcError("session.create", "conflict", "the server has as many sessions as it allows", 409);
	});
	const errors: string[] = [];
	const started = port(fake, { onError: (error) => errors.push(error.message) });

	// The startup reconcile's listing, and the ones after it.
	expect(await started.list()).toEqual([]);
	expect(await started.list()).toEqual([]);
	expect((await started.listForeign()).map(({ id }) => id)).toEqual(["block:w1", "block:w2"]);
	expect(errors).toEqual([expect.stringContaining(`rex hangar ${HANGAR} does not exist, and no hangar was made`)]);
	expect(started.hangar).toBe(HANGAR);

	fake.replace("session.create", fake.original("session.create"));
	expect(await started.list()).toEqual([]);
	expect(started.hangar).toBe(MADE);
	expect(fake.made.map(({ id }) => id)).toEqual([MADE]);
	expect(errors).toHaveLength(2);
	expect(errors[1]).toContain(`made ${MADE}`);
});
