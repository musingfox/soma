import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { AgentPort } from "../../../ports/agent.ts";
import type { Job } from "../../domain/dispatch.ts";
import { composeLaunchPrompt } from "../../domain/launch-prompt.ts";

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
		execute: async ({ card, repo }, api, context) => {
			const sessionId = await api.memo("sessionId", randomUUID(), context);
			const recorded = await api.commit(
				async (tx) => (await tx.doc(Dispatches, api.conversationId)).jobs.find((job) => job.card === card),
				context,
			);
			if (recorded) return text(recorded);

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
			return text(job);
		},
	});

	const jobs = defineTool({
		name: "jobs",
		description: "List every dispatched job with its card, agent, session id and last known status.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async (_args, api, context) =>
			text(await api.commit(async (tx) => (await tx.doc(Dispatches, api.conversationId)).jobs, context)),
	});

	return defineExtension({ name: "soma.dispatch", tools: [dispatch, jobs] });
}
