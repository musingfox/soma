import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentListing, AgentPort, StartRequest } from "../../ports/agent.ts";
import { STATE_BY_AGENT_STATUS } from "./agent-state.ts";
import type { HerdrClient } from "./client.ts";
import { readPerfCoresViaSysctl, resolveHangarCapWithSource } from "./hangar-cap.ts";
import { waitForAvailableShell } from "./readiness.ts";
import {
	AgentStartedResultSchema,
	PaneProcessInfoResultSchema,
	WorktreeListResultSchema,
	WorktreeOpenedResultSchema,
} from "./schema.ts";

export interface HerdrAgentPortOptions {
	/** A client on the hangar session's socket: every agent there counts against the cap. */
	client: HerdrClient;
	cap?: number;
}

/**
 * Starts each card's claude in its own `fleet/<card>` worktree of the repo at
 * `cwd`. Returns at agent.start's ack: herdr lists the agent by name from then on,
 * while `interactive_ready` can wait on a dialog (a folder trust prompt) for as
 * long as nobody answers it.
 */
export function createHerdrAgentPort(options: HerdrAgentPortOptions): AgentPort {
	const { client } = options;
	const cap = options.cap ?? resolveHangarCapWithSource(process.env.SOMA_HANGAR_CAP, readPerfCoresViaSysctl).cap;

	// A crash between worktree.create and agent.start leaves the worktree behind; its rerun opens it.
	async function openWorktree(cwd: string, branch: string, label: string) {
		const { worktrees } = await client.call("worktree.list", { cwd }, WorktreeListResultSchema);
		const params = { cwd, branch, focus: false };
		return worktrees.some((worktree) => worktree.branch === branch)
			? client.call("worktree.open", params, WorktreeOpenedResultSchema)
			: client.call("worktree.create", { ...params, label }, WorktreeOpenedResultSchema);
	}

	const notYet = (what: string) => () => Promise.reject(new Error(`herdr AgentPort: ${what} is not implemented`));

	return {
		async start(request: StartRequest): Promise<void> {
			const running = (await client.agentList()).length;
			if (running >= cap) throw new Error(`hangar is full: ${running} of ${cap} agents running`);

			const opened = await openWorktree(request.cwd, `fleet/${request.card}`, request.name);
			// obw finds its vault through this untracked file, which a fresh worktree lacks.
			await copyFile(
				join(request.cwd, ".obsidian.yaml"),
				join(opened.worktree.path, ".obsidian.yaml"),
				constants.COPYFILE_EXCL,
			).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT" && error.code !== "EEXIST") throw error;
			});

			const paneId = opened.root_pane.pane_id;
			await waitForAvailableShell({
				paneId,
				processInfo: async (pane) =>
					(await client.call("pane.process_info", { pane_id: pane }, PaneProcessInfoResultSchema)).process_info,
			});
			await client.call(
				"agent.start",
				{ name: request.name, kind: "claude", pane_id: paneId, args: ["--session-id", request.sessionId] },
				AgentStartedResultSchema,
			);
		},

		async list(): Promise<readonly AgentListing[]> {
			return (await client.agentList()).flatMap((agent) =>
				agent.name
					? [
							{
								name: agent.name,
								status: STATE_BY_AGENT_STATUS[agent.agent_status],
								sessionId: agent.agent_session?.value,
							},
						]
					: [],
			);
		},

		prompt: notYet("prompt"),
		onStatus: () => {
			throw new Error("herdr AgentPort: onStatus is not implemented");
		},
		readResult: notYet("readResult"),
		respond: notYet("respond"),
		stop: notYet("stop"),
	};
}
