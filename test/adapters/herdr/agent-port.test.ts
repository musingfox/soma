import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { createHerdrAgentPort } from "../../../src/adapters/herdr/agent-port.ts";
import { createHerdrClient } from "../../../src/adapters/herdr/client.ts";
import { readBlockedScreen } from "../../../src/agent-cli/permission/blocked-screen.ts";
import { complete, observe } from "../../../src/core/domain/bridge.ts";
import type { Job } from "../../../src/core/domain/dispatch.ts";
import { NotImplemented, PromptRefused } from "../../../src/ports/agent.ts";

const agent = (name: string | null, agent_status: string) => ({
	terminal_id: "t",
	agent_status,
	workspace_id: "w1",
	tab_id: "w1:t1",
	pane_id: "w1:p1",
	focused: false,
	revision: 0,
	name,
});

function herdr(agents: ReturnType<typeof agent>[], branches: string[] = []) {
	const calls: { method: string; params: Record<string, unknown> }[] = [];
	const opened = { root_pane: { pane_id: "w9:p1" }, worktree: { path: "/nonexistent/worktree" } };
	const replies: Record<string, unknown> = {
		"agent.list": { type: "agent_list", agents },
		"worktree.list": {
			type: "worktree_list",
			worktrees: branches.map((branch) => ({ path: `/wt/${branch}`, branch })),
		},
		"worktree.create": { type: "worktree_created", ...opened },
		"worktree.open": { type: "worktree_opened", ...opened },
		"pane.process_info": {
			type: "pane_process_info",
			process_info: {
				pane_id: "w9:p1",
				shell_pid: 7,
				foreground_process_group_id: 7,
				foreground_processes: [{ pid: 7 }],
			},
		},
		"agent.start": { type: "agent_started", agent: agent("card-a", "unknown"), argv: [] },
	};
	const client = createHerdrClient({
		transport: {
			async request(method, params) {
				calls.push({ method, params: params as Record<string, unknown> });
				return replies[method];
			},
		},
	});
	return { client, calls };
}

const request = { name: "card-a", card: "card-a", cwd: "/nonexistent/repo", sessionId: "uuid-a" };

test("start creates fleet/<card> and starts claude there with the caller's session id", async () => {
	const { client, calls } = herdr([]);

	await createHerdrAgentPort({ client, cap: 1 }).start(request);

	expect(calls.map((c) => c.method)).toEqual([
		"agent.list",
		"worktree.list",
		"worktree.create",
		"pane.process_info",
		"agent.start",
	]);
	expect(calls[2]?.params).toMatchObject({ cwd: "/nonexistent/repo", branch: "fleet/card-a", focus: false });
	expect(calls[4]?.params).toEqual({
		name: "card-a",
		kind: "claude",
		pane_id: "w9:p1",
		args: ["--session-id", "uuid-a"],
	});
});

test("start reopens a worktree an earlier attempt left behind", async () => {
	const { client, calls } = herdr([], ["fleet/card-a"]);

	await createHerdrAgentPort({ client, cap: 1 }).start(request);

	expect(calls.map((c) => c.method)).toContain("worktree.open");
	expect(calls.map((c) => c.method)).not.toContain("worktree.create");
});

test("resume is not implemented, which it says with its own error, having called herdr for nothing", async () => {
	const { client, calls } = herdr([]);
	await expect(createHerdrAgentPort({ client, cap: 1 }).resume(request)).rejects.toBeInstanceOf(NotImplemented);
	expect(calls).toEqual([]);
});

test("herdr lists no foreign agents, and reads and prompts none, having called herdr for nothing", async () => {
	const { client, calls } = herdr([agent(null, "working"), agent("other", "idle")]);
	const port = createHerdrAgentPort({ client, cap: 1 });
	expect(await port.listForeign()).toEqual([]);
	await expect(port.readForeignResult("w1:p1")).rejects.toThrow("no foreign agent w1:p1");
	await expect(port.promptForeign("w1:p1", "go")).rejects.toThrow("no foreign agent w1:p1");
	await expect(port.promptForeign("w1:p1", "go")).rejects.toBeInstanceOf(PromptRefused);
	expect(calls).toEqual([]);
});

test("start refuses when the hangar already runs cap agents, counting agents soma did not start", async () => {
	const { client, calls } = herdr([agent(null, "working"), agent("other", "idle")]);

	await expect(createHerdrAgentPort({ client, cap: 2 }).start(request)).rejects.toThrow("2 of 2");
	expect(calls.map((c) => c.method)).toEqual(["agent.list"]);
});

const screen = (name: string) =>
	readFileSync(join(import.meta.dirname, "..", "..", "agent-cli", "permission", "fixtures", `${name}.txt`), "utf8");
const BASH = screen("claude-bash-prompt-2.1.302");
const TRUST = screen("claude-trust-dialog-2.1.302");
const API_KEY = screen("claude-custom-api-key-2.1.302");
const fingerprintOf = (text: string) => readBlockedScreen(text).prompt?.fingerprint ?? "";

/** A pane whose status and screen the test sets; every RPC is recorded. */
function pane(status: string, text: string) {
	const calls: { method: string; params: Record<string, unknown> }[] = [];
	const state = { status, text };
	const client = createHerdrClient({
		transport: {
			async request(method, params) {
				calls.push({ method, params: params as Record<string, unknown> });
				if (method === "agent.get") return { type: "agent_info", agent: agent("card-a", state.status) };
				if (method === "agent.list") return { type: "agent_list", agents: [agent("card-a", state.status)] };
				if (method === "pane.read") {
					return {
						type: "pane_read",
						read: { pane_id: "w1:p1", source: "detection", text: state.text, revision: 1, truncated: false },
					};
				}
				if (method === "pane.send_keys") return { type: "ok" };
				throw new Error(`unexpected ${method}`);
			},
		},
	});
	const keys = () => calls.filter((call) => call.method === "pane.send_keys").map((call) => call.params.keys);
	return { client, calls, state, keys, port: createHerdrAgentPort({ client, cap: 1, redrawMs: 0 }) };
}

test("list names each named agent with its state; unknown is no claim", async () => {
	const { client } = herdr([agent("a", "idle"), agent("b", "unknown"), agent(null, "working")]);

	expect(await createHerdrAgentPort({ client, cap: 1 }).list()).toEqual([
		{ name: "a", status: { state: "idle" } },
		{ name: "b", status: undefined },
	]);
});

test("list reads a blocked agent's screen for its kind, prompt and fingerprint", async () => {
	const { port } = pane("blocked", API_KEY);
	const [listed] = await port.list();
	expect(listed?.status).toMatchObject({ state: "blocked", kind: "auth", fingerprint: fingerprintOf(API_KEY) });
	expect(listed?.status?.msg).toContain("Do you want to use this API key?");
});

test("a blocked status carries the prompt's options as the parser read them", async () => {
	const { port } = pane("blocked", BASH);
	const [listed] = await port.list();
	const parsed = readBlockedScreen(BASH).prompt?.options.map(({ id, label }) => ({ id, label }));
	expect(parsed?.length).toBeGreaterThan(0);
	expect(listed?.status).toMatchObject({ state: "blocked", fingerprint: fingerprintOf(BASH), options: parsed });
});

test("respond presses the chosen option's key after a fresh status and screen read", async () => {
	const { port, calls, keys } = pane("blocked", BASH);
	expect(await port.respond("card-a", { option: "1", fingerprint: fingerprintOf(BASH) })).toEqual({ sent: true });
	expect(calls.map((call) => call.method)).toEqual(["agent.get", "pane.read", "pane.send_keys"]);
	expect(keys()).toEqual([["1"]]);
});

test("respond travels from the cursor on an unnumbered dialog", async () => {
	const { port, keys } = pane("blocked", TRUST);
	expect(await port.respond("card-a", { option: "2", fingerprint: fingerprintOf(TRUST) })).toEqual({ sent: true });
	expect(keys()).toEqual([["Down", "Enter"]]);
});

test("respond refuses, sending nothing, when the screen changed since the answer was decided", async () => {
	const { port, keys } = pane("blocked", BASH);
	expect(await port.respond("card-a", { option: "2", fingerprint: fingerprintOf(TRUST) })).toEqual({
		sent: false,
		refusal: "stale",
	});
	expect(keys()).toEqual([]);
});

test("respond refuses an auth dialog, an agent no longer blocked, and an option not offered", async () => {
	const auth = pane("blocked", API_KEY);
	expect(await auth.port.respond("card-a", { option: "1", fingerprint: fingerprintOf(API_KEY) })).toEqual({
		sent: false,
		refusal: "auth",
	});
	const moved = pane("working", BASH);
	expect(await moved.port.respond("card-a", { option: "1", fingerprint: fingerprintOf(BASH) })).toEqual({
		sent: false,
		refusal: "not_blocked",
	});
	const unknown = pane("blocked", BASH);
	expect(await unknown.port.respond("card-a", { option: "9", fingerprint: fingerprintOf(BASH) })).toEqual({
		sent: false,
		refusal: "unknown_option",
	});
	expect([...auth.keys(), ...moved.keys(), ...unknown.keys()]).toEqual([]);
});

const projects = mkdtempSync(join(tmpdir(), "soma-herdr-projects-"));
afterAll(() => rmSync(projects, { recursive: true, force: true }));

test("an idle re-reported under a new seq, with the transcript's last record unchanged, records no second turn", async () => {
	const session = "0b6f6c1e-8a1c-4d5e-9f00-1234567890ab";
	const cwd = "/nonexistent/worktree";
	const dir = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
	mkdirSync(dir, { recursive: true });
	// The human interrupted the first turn before claude replied: the transcript ends on the user.
	writeFileSync(
		join(dir, `${session}.jsonl`),
		[
			{ type: "user", uuid: "u-1", message: { role: "user", content: "go" } },
			{
				type: "user",
				uuid: "u-stop",
				message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
			},
		]
			.map((record) => `${JSON.stringify(record)}\n`)
			.join(""),
	);
	const client = createHerdrClient({
		transport: {
			async request(method) {
				if (method !== "agent.get") throw new Error(`unexpected ${method}`);
				return { type: "agent_info", agent: { ...agent("card-a", "idle"), agent_session: { value: session }, cwd } };
			},
		},
	});
	const port = createHerdrAgentPort({ client, cap: 1, projectsDir: projects });
	const fold = async (job: Job, seq: number) =>
		complete(observe(job, { state: "idle" }, seq), await port.readResult("card-a"));
	const working = observe(
		{ card: "card-a", agent: "card-a", sessionId: session, status: { state: "idle" }, seq: 1, decisions: [] },
		{ state: "working" },
		2,
	).job;

	const ended = await fold(working, 3);
	expect(ended).toMatchObject({ action: "complete", job: { outcome: "未知", resultId: "u-stop" } });
	const again = await fold(ended.job, 4);
	expect(again).toEqual({ action: "none", job: { ...ended.job, seq: 4 } });
});
