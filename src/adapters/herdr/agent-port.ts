import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { readPerfCoresViaSysctl, resolveHangarCapWithSource } from "../../agent-cli/hangar-cap.ts";
import { answerKeys, readBlockedScreen } from "../../agent-cli/permission/blocked-screen.ts";
import { readFinalMessage, resolveTranscriptPath } from "../../agent-cli/transcript.ts";
import type {
	AgentListing,
	AgentPort,
	AgentResult,
	AgentState,
	AgentStatusEvent,
	Answer,
	AnswerOutcome,
	StartRequest,
} from "../../ports/agent.ts";
import { STATE_BY_AGENT_STATUS } from "./agent-state.ts";
import type { HerdrClient } from "./client.ts";
import { waitForAvailableShell, waitForInteractiveReady } from "./readiness.ts";
import {
	AgentStartedResultSchema,
	PaneProcessInfoResultSchema,
	WorktreeListResultSchema,
	WorktreeOpenedResultSchema,
} from "./schema.ts";
import { createStatusWatch, type StatusWatchOptions } from "./status-watch.ts";

export interface HerdrAgentPortOptions {
	/** A client on the hangar session's socket: every agent there counts against the cap. */
	client: HerdrClient;
	cap?: number;
	/** Poll tier inputs for onStatus; see status-watch.ts. */
	listening?: StatusWatchOptions["listening"];
	onError?: StatusWatchOptions["onError"];
	/** Where claude keeps its transcripts; defaults to ~/.claude/projects. */
	projectsDir?: string;
	/** Pause between reads of a blocked screen that did not parse yet; claude may still be drawing it. */
	redrawMs?: number;
}

const BLOCKED_READS = 3;

/**
 * Starts each card's claude in its own `fleet/<card>` worktree of the repo at
 * `cwd`. Returns at agent.start's ack: herdr lists the agent by name from then on,
 * while `interactive_ready` can wait on a dialog (a folder trust prompt) for as
 * long as nobody answers it.
 */
export function createHerdrAgentPort(options: HerdrAgentPortOptions): AgentPort {
	const { client } = options;
	const cap = options.cap ?? resolveHangarCapWithSource(undefined, readPerfCoresViaSysctl).cap;

	// A crash between worktree.create and agent.start leaves the worktree behind; its rerun opens it.
	async function openWorktree(cwd: string, branch: string, label: string) {
		const { worktrees } = await client.call("worktree.list", { cwd }, WorktreeListResultSchema);
		const params = { cwd, branch, focus: false };
		return worktrees.some((worktree) => worktree.branch === branch)
			? client.call("worktree.open", params, WorktreeOpenedResultSchema)
			: client.call("worktree.create", { ...params, label }, WorktreeOpenedResultSchema);
	}

	const redrawMs = options.redrawMs ?? 500;

	async function readScreen(paneId: string) {
		return readBlockedScreen((await client.paneRead({ pane_id: paneId, source: "detection" })).text);
	}

	/** Never rejects: a screen that cannot be read is still a block, just one nobody can answer. */
	async function blockedState(paneId: string): Promise<AgentState> {
		try {
			let screen = await readScreen(paneId);
			for (let read = 1; read < BLOCKED_READS && screen.prompt === undefined; read++) {
				await new Promise((resolve) => setTimeout(resolve, redrawMs));
				screen = await readScreen(paneId);
			}
			const { kind, msg, prompt } = screen;
			const options = prompt?.options.map(({ id, label }) => ({ id, label }));
			return { state: "blocked", kind, msg, ...(prompt ? { fingerprint: prompt.fingerprint, options } : {}) };
		} catch (error) {
			return { state: "blocked", kind: "permission", msg: `pane.read failed: ${(error as Error).message}` };
		}
	}

	const notYet = (what: string) => () => Promise.reject(new Error(`herdr AgentPort: ${what} is not implemented`));

	// One watch for every listener, open while there is one.
	const listeners = new Set<(event: AgentStatusEvent) => void>();
	let watch: ReturnType<typeof createStatusWatch> | undefined;

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
			const named = (await client.agentList()).filter((agent) => agent.name);
			return Promise.all(
				named.map(async (agent) => ({
					name: agent.name as string,
					status:
						agent.agent_status === "blocked"
							? await blockedState(agent.pane_id)
							: STATE_BY_AGENT_STATUS[agent.agent_status],
					sessionId: agent.agent_session?.value,
				})),
			);
		},

		async prompt(agent: string, text: string): Promise<void> {
			// herdr refuses agent.prompt with agent_not_ready until claude's composer is up.
			await waitForInteractiveReady({ agentGet: client.agentGet, paneId: agent });
			await client.call("agent.prompt", { target: agent, text });
		},

		onStatus(listener: (event: AgentStatusEvent) => void): () => void {
			listeners.add(listener);
			if (watch === undefined) {
				watch = createStatusWatch({
					subscribe: client.subscribeEvents,
					snapshot: client.sessionSnapshot,
					onStatus: (event) => {
						for (const each of listeners) each(event);
					},
					blocked: (agent) => blockedState(agent.pane_id),
					listening: options.listening,
					onError: options.onError,
				});
				void watch.start();
			}
			return () => {
				listeners.delete(listener);
				if (listeners.size > 0) return;
				watch?.stop();
				watch = undefined;
			};
		},

		/** The agent's last assistant message, read off its claude transcript; undefined while there is none. */
		async readResult(agent: string): Promise<AgentResult | undefined> {
			const info = await client.agentGet(agent);
			const sessionId = info.agent_session?.value;
			if (!sessionId) return undefined;
			const path = await resolveTranscriptPath(sessionId, info.cwd, options.projectsDir);
			return path === undefined ? undefined : readFinalMessage(path);
		},

		// cc-mobile native-permission.ts:334-440: fresh status, fresh screen, then the keys read off that screen.
		async respond(agent: string, answer: Answer): Promise<AnswerOutcome> {
			const info = await client.agentGet(agent);
			if (info.agent_status !== "blocked") return { sent: false, refusal: "not_blocked" };
			const { kind, prompt } = await readScreen(info.pane_id);
			if (kind === "auth") return { sent: false, refusal: "auth" };
			if (prompt === undefined) return { sent: false, refusal: "unreadable" };
			if (prompt.fingerprint !== answer.fingerprint) return { sent: false, refusal: "stale" };
			if (!prompt.options.some((option) => option.id === answer.option)) {
				return { sent: false, refusal: "unknown_option" };
			}
			const keys = answerKeys(prompt, answer.option);
			if (keys === undefined) return { sent: false, refusal: "unreadable" };
			await client.paneSendKeys(info.pane_id, keys);
			return { sent: true };
		},
		stop: notYet("stop"),
	};
}
