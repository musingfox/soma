import { expect, test } from "vitest";
import { createHerdrAgentPort } from "../../../src/adapters/herdr/agent-port.ts";
import { createHerdrClient } from "../../../src/adapters/herdr/client.ts";

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

test("list names each named agent with its state; unknown is no claim", async () => {
	const { client } = herdr([agent("a", "blocked"), agent("b", "unknown"), agent(null, "working")]);

	expect(await createHerdrAgentPort({ client, cap: 1 }).list()).toEqual([
		{ name: "a", status: { state: "blocked", kind: "permission" } },
		{ name: "b", status: undefined },
	]);
});
