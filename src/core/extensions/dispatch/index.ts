import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { AgentPort } from "../../../ports/agent.ts";
import type { Decision, Job } from "../../domain/dispatch.ts";
import { composeLaunchPrompt } from "../../domain/launch-prompt.ts";
import { noticeEntry } from "../../notice.ts";

/** Every job dispatched from this conversation; one per card. */
export const Dispatches = defineDoc<{ jobs: Job[] }>({
	kind: "soma.dispatch.jobs",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ jobs: [] }),
});

const text = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });

/**
 * Starts the card's agent unless the dispatch list or the agents listed already have it. Shared by every tool that
 * dispatches: a rerun after a crash checks both before it starts anything, and memoizes the session id under the call.
 */
export async function startJob(
	agents: AgentPort,
	readCard: (repo: string, card: string) => Promise<string>,
	api: ToolExecutionApi,
	{ card, repo }: { card: string; repo: string },
	context: Context,
): Promise<Job> {
	const sessionId = await api.memo("sessionId", randomUUID(), context);
	const recorded = await api.commit(async (tx) => {
		const found = (await tx.doc(Dispatches, api.conversationId)).jobs.find((job) => job.card === card);
		// Copied out as JSON: a doc is a live proxy only valid inside its commit.
		return found && (JSON.parse(JSON.stringify(found)) as Job);
	}, context);
	if (recorded) return recorded;

	// Read before anything starts, so a card that does not exist starts nothing.
	const launch = composeLaunchPrompt(await readCard(repo, card));
	const listed = (await agents.list()).find((agent) => agent.name === card);
	if (listed === undefined) await agents.start({ name: card, card, cwd: repo, sessionId });
	const job: Job = {
		card,
		agent: card,
		sessionId: listed?.sessionId ?? sessionId,
		status: listed?.status ?? { state: "idle" },
		launch,
		decisions: [],
	};
	await api.commit(async (tx) => {
		(await tx.doc(Dispatches, api.conversationId)).jobs.push(job);
	}, context);
	return job;
}

/** `readCard` returns the card's markdown, read from wherever the repo's cards live. */
export function dispatchExtension(agents: AgentPort, readCard: (repo: string, card: string) => Promise<string>) {
	const dispatch = defineTool({
		name: "dispatch",
		description:
			"Start a coding agent on an obw task card, in a fleet/<card> worktree of the repo. " +
			"A card that already has a job, or a running agent named after it, is not started again.",
		parameters: Type.Object({
			card: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", description: "The card's file name, without .md" }),
			repo: Type.String({ description: "Absolute path of the git repository the card belongs to" }),
		}),
		// A rerun after a crash checks the dispatch list, then the agents listed, before it starts anything.
		replay: "safe",
		execute: async ({ card, repo }, api, context) =>
			text(await startJob(agents, readCard, api, { card, repo }, context)),
	});

	const jobs = defineTool({
		name: "jobs",
		description: "List every dispatched job with its card, agent, session id and last known status.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async (_args, api, context) =>
			text(
				await api.commit(
					async (tx) => JSON.parse(JSON.stringify((await tx.doc(Dispatches, api.conversationId)).jobs)) as Job[],
					context,
				),
			),
	});

	const card = Type.String({ description: "The blocked job's card" });
	const reason = Type.String({ description: "Why: written into the dispatch list for the human to check later" });
	const decide = (job: Job, decision: Omit<Decision, "at" | "kind">): Decision => ({
		at: new Date().toISOString(),
		kind: job.status.state === "blocked" ? job.status.kind : "permission",
		...decision,
	});
	const respond = defineTool({
		name: "respond",
		description:
			"Answer a blocked agent's prompt by choosing one of its options. The agent's screen is read again first: " +
			"if it no longer shows the prompt the fingerprint names, nothing is sent and the refusal is returned. " +
			"Never for kind=auth.",
		parameters: Type.Object({
			card,
			option: Type.String({ description: "The option's number as the wake listed it" }),
			fingerprint: Type.String({ description: "The fingerprint the wake gave for this prompt" }),
			reason,
		}),
		// Not replayed: a crash mid-call reports it interrupted rather than pressing keys a second time.
		replay: "unsafe",
		execute: async (args, api, context) => {
			// Copied out as JSON: a doc is a live proxy only valid inside its commit.
			const job = await api.commit(async (tx) => {
				const found = (await tx.doc(Dispatches, api.conversationId)).jobs.find((each) => each.card === args.card);
				return found && (JSON.parse(JSON.stringify(found)) as Job);
			}, context);
			if (job === undefined) return text({ sent: false, error: `no job for card ${args.card}` });
			const outcome = await agents.respond(job.agent, { option: args.option, fingerprint: args.fingerprint });
			if (outcome.sent) {
				const decision = decide(job, {
					action: "answered",
					option: args.option,
					fingerprint: args.fingerprint,
					reason: args.reason,
				});
				await api.commit(async (tx) => {
					const doc = await tx.doc(Dispatches, api.conversationId);
					const index = doc.jobs.findIndex((each) => each.card === args.card);
					const current = doc.jobs[index];
					if (current !== undefined) doc.jobs[index] = { ...current, decisions: [...current.decisions, decision] };
				}, context);
			}
			return text(outcome);
		},
	});

	const escalate = defineTool({
		name: "escalate",
		description: "Hand a blocked agent's prompt to the human instead of answering it, with the reason why.",
		parameters: Type.Object({
			card,
			question: Type.String({ description: "What the human needs to decide, in their language" }),
			reason,
		}),
		replay: "unsafe",
		execute: async (args, api, context) => {
			const escalated = await api.commit(async (tx) => {
				const doc = await tx.doc(Dispatches, api.conversationId);
				const index = doc.jobs.findIndex((each) => each.card === args.card);
				const current = doc.jobs[index];
				if (current === undefined) return false;
				doc.jobs[index] = {
					...current,
					decisions: [...current.decisions, decide(current, { action: "escalated", reason: args.reason })],
				};
				await tx.appendEntry(
					api.conversationId,
					noticeEntry("question", `agent ${current.agent}（卡片 ${current.card}）：${args.question}`),
				);
				return true;
			}, context);
			return text(escalated ? { escalated: true } : { escalated: false, error: `no job for card ${args.card}` });
		},
	});

	return defineExtension({ name: "soma.dispatch", tools: [dispatch, jobs, respond, escalate] });
}
