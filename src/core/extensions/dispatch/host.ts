import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { type Conversation, defineDoc } from "@earendil-works/pi-durable";
import type { AgentPort } from "../../../ports/agent.ts";
import type { DispatchReply, DispatchRequest, RepoCheck } from "../../../ports/dispatch.ts";
import { type JobLedger, JobNameTaken, startJobIn } from "./index.ts";

/**
 * The session id a host dispatch starts each card's agent with, from before the start until the commit that records
 * its job. A dispatch has no tool call to memoize it under, and a rerun of `soma dispatch` after a crash between the
 * start and that commit must record the agent it finds under the id it was started with, which herdr cannot list
 * until claude reports it.
 */
export const HostSessions = defineDoc<{ cards: Record<string, string> }>({
	kind: "soma.dispatch.host-sessions",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ cards: {} }),
	checkpointWhen: () => false,
});

// The dispatch tool's pattern: a card is named by its file, and the name is part of the card's path in the vault.
const CARD = /^[a-z0-9][a-z0-9-]*$/;

class CardUnread extends Error {}

/**
 * `soma dispatch`: starts a job as the dispatch tool does, from host code, with no turn of the model, and replies what
 * the CLI prints (ARCHITECTURE.md "Decisions made", 2026-11-17). `checkRepo` says whether the repo may take a job and
 * where it really is; the job records that path. Nothing is told to the human: the job shows in the jobs file and in
 * later reports as any job does. Card status and `blocked_by` are not checked, as the tool does not check them.
 */
export function hostDispatcher(
	agents: AgentPort,
	readCard: (repo: string, card: string) => Promise<string>,
	checkRepo: RepoCheck,
) {
	return async (
		conversation: Pick<Conversation, "id" | "commit">,
		{ repo: asked, card }: DispatchRequest,
		context: Context,
	): Promise<DispatchReply> => {
		if (!CARD.test(card)) {
			return {
				dispatched: false,
				reason: `"${card}" is not a card name: lowercase letters, digits and hyphens, not starting with a hyphen`,
			};
		}
		const checked = await checkRepo(asked);
		if ("refused" in checked) return { dispatched: false, reason: checked.refused };
		const { id } = conversation;
		const ledger: JobLedger = {
			conversationId: id,
			commit: (change) => conversation.commit(change, context),
			sessionId: () =>
				conversation.commit(async (tx) => {
					const { cards } = await tx.doc(HostSessions, id);
					cards[card] ??= randomUUID();
					return cards[card];
				}, context),
			recorded: async (tx) => {
				delete (await tx.doc(HostSessions, id)).cards[card];
			},
		};
		const read = (repo: string, name: string) =>
			readCard(repo, name).catch((error: Error) => {
				throw new CardUnread(`card ${name} could not be read from ${repo}'s vault project: ${error.message}`);
			});
		try {
			const { job, existing, started } = await startJobIn(agents, read, ledger, { card, repo: checked.repo });
			return {
				dispatched: true,
				how: existing ? "existing" : started ? "started" : "found",
				card: job.card,
				agent: job.agent,
				sessionId: job.sessionId,
				...(job.repo === undefined ? {} : { repo: job.repo }),
				state: job.status.state,
			};
		} catch (error) {
			if (error instanceof JobNameTaken) {
				return {
					dispatched: false,
					reason: `the job name ${card} is taken by a ticket job, so the card was not started`,
				};
			}
			if (error instanceof CardUnread) return { dispatched: false, reason: error.message };
			return { dispatched: false, reason: `soma could not dispatch card ${card}: ${(error as Error).message}` };
		}
	};
}
