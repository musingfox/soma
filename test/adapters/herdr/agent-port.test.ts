import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createHerdrAgentPort } from "../../../src/adapters/herdr/agent-port.ts";
import { createHerdrClient } from "../../../src/adapters/herdr/client.ts";
import { readBlockedScreen } from "../../../src/adapters/herdr/permission/blocked-screen.ts";

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

test("start refuses when the hangar already runs cap agents, counting agents soma did not start", async () => {
	const { client, calls } = herdr([agent(null, "working"), agent("other", "idle")]);

	await expect(createHerdrAgentPort({ client, cap: 2 }).start(request)).rejects.toThrow("2 of 2");
	expect(calls.map((c) => c.method)).toEqual(["agent.list"]);
});

const screen = (name: string) =>
	readFileSync(join(import.meta.dirname, "permission", "fixtures", `${name}.txt`), "utf8");
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
