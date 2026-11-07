import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import {
	type Conversation,
	defineDoc,
	defineExtension,
	defineTool,
	type ToolExecutionApi,
	type Tx,
} from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { type AgentPort, type Answer, PromptRefused } from "../../../ports/agent.ts";
import type { Choices, HumanAnswerOutcome } from "../../../ports/human.ts";
import type { Decision, Job } from "../../domain/dispatch.ts";
import { composeLaunchPrompt, composeTicketPrompt } from "../../domain/launch-prompt.ts";
import { FORWARDED, noticeEntry } from "../../notice.ts";

/** Every job dispatched from this conversation; one per card. */
export const Dispatches = defineDoc<{ jobs: Job[] }>({
	kind: "soma.dispatch.jobs",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ jobs: [] }),
	checkpointWhen: () => false,
});

const text = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });

// How many of a pane's last lines the screen tool returns when not told, and at most.
export const SCREEN_LINES = 60;
export const SCREEN_LINES_MAX = 400;

/** The last `lines` lines of a pane's text, past the blank ones below what it shows; `more` when some were left out. */
export function tailOf(screen: string, lines: number): { text: string; more?: true } {
	const all = screen.split("\n");
	while (all.length > 0 && all.at(-1)?.trim() === "") all.pop();
	const tail = all.slice(-lines);
	return { text: tail.join("\n"), ...(all.length > tail.length ? { more: true as const } : {}) };
}

/**
 * A job of the name exists for another request, or for a card where this asks for a ticket, or the other way round. A
 * ticket can take another job name; a card cannot, its job being named after its file.
 */
export class JobNameTaken extends Error {
	constructor(card: string, { taken, asked }: { taken: "card" | "ticket"; asked: "card" | "ticket" }) {
		const head = `Not dispatched: the job name ${card} is taken by `;
		super(
			asked === "card"
				? `${head}a ticket job, so the card was not started. Dispatch a card only under its own file name; if the ` +
						"card has the ticket job's name, tell the human."
				: `${head}${taken === "ticket" ? "another ticket" : "a card's job"}, so this ticket was not started. ` +
						"Call dispatch again with the same ticket and a new job name, such as ticket-<topic>.",
		);
	}
}

/**
 * Starts the card's agent unless the dispatch list or the agents listed already have it. Shared by every tool that
 * dispatches: a rerun after a crash checks both before it starts anything, and memoizes the session id under the call.
 * With a `ticket`, the agent's brief is the human's request for a card it is to write, and no card is read. A recorded
 * job of the name with another request throws `JobNameTaken`: the same call rerun has the same request, so it still
 * gets its own job back.
 */
export async function startJob(
	agents: AgentPort,
	readCard: (repo: string, card: string) => Promise<string>,
	api: ToolExecutionApi,
	{ card, repo, ticket }: { card: string; repo: string; ticket?: string },
	context: Context,
): Promise<Job> {
	const sessionId = await api.memo("sessionId", randomUUID(), context);
	const recorded = await api.commit(async (tx) => {
		const found = (await tx.doc(Dispatches, api.conversationId)).jobs.find((job) => job.card === card);
		// Copied out as JSON: a doc is a live proxy only valid inside its commit.
		return found && (JSON.parse(JSON.stringify(found)) as Job);
	}, context);
	if (recorded) {
		if (recorded.ticket !== ticket) {
			const kind = (each?: string) => (each === undefined ? "card" : "ticket");
			throw new JobNameTaken(card, { taken: kind(recorded.ticket), asked: kind(ticket) });
		}
		return recorded;
	}

	// Read before anything starts, so a card that does not exist starts nothing.
	const launch = ticket === undefined ? composeLaunchPrompt(await readCard(repo, card)) : composeTicketPrompt(ticket);
	const listed = (await agents.list()).find((agent) => agent.name === card);
	if (listed === undefined) await agents.start({ name: card, card, cwd: repo, sessionId });
	const job: Job = {
		card,
		agent: card,
		sessionId: listed?.sessionId ?? sessionId,
		status: listed?.status ?? { state: "idle" },
		launch,
		...(ticket === undefined ? {} : { ticket }),
		decisions: [],
	};
	await api.commit(async (tx) => {
		(await tx.doc(Dispatches, api.conversationId)).jobs.push(job);
	}, context);
	return job;
}

const decide = (job: Job, decision: Omit<Decision, "at" | "kind">): Decision => ({
	at: new Date().toISOString(),
	kind: job.status.state === "blocked" ? job.status.kind : "permission",
	...decision,
});

/**
 * Sends `answer` to the card's blocked agent and, once sent, records the decision with `reason`. Shared by the respond
 * tool and the human choosing an option themselves, which goes through no model round.
 */
export async function answerJob(
	agents: Pick<AgentPort, "respond">,
	commit: <T>(change: (tx: Tx) => Promise<T>) => Promise<T>,
	conversationId: Conversation["id"],
	{ card, answer, reason }: { card: string; answer: Answer; reason: string },
): Promise<HumanAnswerOutcome> {
	// Copied out as JSON: a doc is a live proxy only valid inside its commit.
	const job = await commit(async (tx) => {
		const found = (await tx.doc(Dispatches, conversationId)).jobs.find((each) => each.card === card);
		return found && (JSON.parse(JSON.stringify(found)) as Job);
	});
	if (job === undefined) return { sent: false, refusal: "no_job" };
	const outcome = await agents.respond(job.agent, answer);
	if (outcome.sent) {
		const decision = decide(job, { action: "answered", ...answer, reason });
		await commit(async (tx) => {
			const doc = await tx.doc(Dispatches, conversationId);
			const index = doc.jobs.findIndex((each) => each.card === card);
			const current = doc.jobs[index];
			if (current !== undefined) doc.jobs[index] = { ...current, decisions: [...current.decisions, decision] };
		});
	}
	return outcome;
}

/** `readCard` returns the card's markdown, read from wherever the repo's cards live. */
export function dispatchExtension(agents: AgentPort, readCard: (repo: string, card: string) => Promise<string>) {
	const dispatch = defineTool({
		name: "dispatch",
		description:
			"Start a coding agent on an obw task card, in a fleet/<card> worktree of the repo. " +
			"A card that already has a job, or a running agent named after it, is not started again. " +
			"When the human asks for a ticket, card or task to be opened or written, call this with ticket set to their " +
			"request: the agent writes the card, and its name comes to the human once it is written. Never write that " +
			"card yourself, and never ask the human for evidence ids or a format; ask only which repo, when no repo " +
			"you know fits.",
		parameters: obj({
			card: str({
				pattern: "^[a-z0-9][a-z0-9-]*$",
				description: "The card's file name, without .md; with ticket, a new name for the job, such as ticket-<topic>",
			}),
			repo: str({ description: "Absolute path of the git repository the card belongs to" }),
			ticket: opt(
				str({
					pattern: "\\S",
					description:
						"The human's request for a new ticket, word for word, as the agent's brief instead of an existing card",
				}),
			),
		}),
		// A rerun after a crash checks the dispatch list, then the agents listed, before it starts anything.
		replay: "safe",
		execute: async ({ card, repo, ticket }, api, context) => {
			try {
				return text(
					await startJob(agents, readCard, api, { card, repo, ...(ticket === undefined ? {} : { ticket }) }, context),
				);
			} catch (error) {
				if (error instanceof JobNameTaken) return text({ dispatched: false, reason: error.message });
				throw error;
			}
		},
	});

	const jobs = defineTool({
		name: "jobs",
		description:
			"List every job soma dispatched, with its card, agent, session id and last known status. " +
			"Only soma's own: every other agent running is listed by foreign_agents.",
		parameters: obj({}),
		replay: "safe",
		execute: async (_args, api, context) =>
			text(
				await api.commit(
					async (tx) => JSON.parse(JSON.stringify((await tx.doc(Dispatches, api.conversationId)).jobs)) as Job[],
					context,
				),
			),
	});

	const card = str({ description: "The blocked job's card" });
	const reason = str({ description: "Why: written into the dispatch list for the human to check later" });
	const respond = defineTool({
		name: "respond",
		description:
			"Answer a blocked agent's prompt by choosing one of its options: a job's, named by its card, or a foreign " +
			"agent's, named by its id. The agent's screen is read again first: if it no longer shows the prompt the " +
			"fingerprint names, nothing is sent and the refusal is returned. Never for kind=auth.",
		parameters: obj({
			card: opt(card),
			foreign: opt(
				str({ description: "The foreign agent's id, as its wake or foreign_agents gave it, instead of card" }),
			),
			option: str({ description: "The option's number as the wake listed it" }),
			fingerprint: str({ description: "The fingerprint the wake gave for this prompt" }),
			reason,
		}),
		// Not replayed: a crash mid-call reports it interrupted rather than pressing keys a second time.
		replay: "unsafe",
		execute: async ({ card, foreign, option, fingerprint, reason }, api, context) => {
			const answer = { option, fingerprint };
			if ((card === undefined) === (foreign === undefined)) {
				return text({ sent: false, error: "name either card, for a job, or foreign, for a foreign agent" });
			}
			// A foreign agent has no job, so the reason stays in this call only.
			if (foreign !== undefined) {
				return text(
					await agents.respondForeign(foreign, answer).catch((error: Error) => ({ sent: false, error: error.message })),
				);
			}
			const outcome = await answerJob(agents, (change) => api.commit(change, context), api.conversationId, {
				card: card as string,
				answer,
				reason,
			});
			return text(
				!outcome.sent && outcome.refusal === "no_job" ? { sent: false, error: `no job for card ${card}` } : outcome,
			);
		},
	});

	const escalate = defineTool({
		name: "escalate",
		description: "Hand a blocked agent's prompt to the human instead of answering it, with the reason why.",
		parameters: obj({
			card,
			question: str({ description: "What the human needs to decide, in their language" }),
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
				const { status } = current;
				// Only a prompt the agent side could read into options can be answered by choosing one.
				const choices: Choices | undefined =
					status.state === "blocked" && status.fingerprint !== undefined && (status.options?.length ?? 0) > 0
						? { card: current.card, fingerprint: status.fingerprint, options: status.options ?? [] }
						: undefined;
				await tx.appendEntry(
					api.conversationId,
					noticeEntry(
						"question",
						"action",
						`agent ${current.agent}（卡片 ${current.card}）：${args.question}`,
						choices,
					),
				);
				return true;
			}, context);
			return text(escalated ? { escalated: true } : { escalated: false, error: `no job for card ${args.card}` });
		},
	});

	const reply = defineTool({
		name: "reply",
		description:
			"Send the human's answer to an agent whose result was 需要你, as its next prompt. " +
			"Its next result comes back in the report like any other.",
		parameters: obj({
			card: str({ description: "The card of the job that asked" }),
			text: str({ description: "What to send the agent: the human's answer, in their words" }),
			reason,
		}),
		// Not replayed: a crash mid-call reports it interrupted rather than sending the answer a second time.
		replay: "unsafe",
		execute: async (args, api, context) => {
			// Copied out as JSON: a doc is a live proxy only valid inside its commit.
			const job = await api.commit(async (tx) => {
				const found = (await tx.doc(Dispatches, api.conversationId)).jobs.find((each) => each.card === args.card);
				return found && (JSON.parse(JSON.stringify(found)) as Job);
			}, context);
			if (job === undefined) return text({ sent: false, error: `no job for card ${args.card}` });
			await agents.prompt(job.agent, args.text);
			const decision: Decision = {
				at: new Date().toISOString(),
				kind: "question",
				action: "replied",
				text: args.text,
				reason: args.reason,
			};
			await api.commit(async (tx) => {
				const doc = await tx.doc(Dispatches, api.conversationId);
				const index = doc.jobs.findIndex((each) => each.card === args.card);
				const current = doc.jobs[index];
				if (current !== undefined) doc.jobs[index] = { ...current, decisions: [...current.decisions, decision] };
			}, context);
			return { ...text({ sent: true }), details: FORWARDED };
		},
	});

	const foreignAgents = defineTool({
		name: "foreign_agents",
		description:
			"List every claude agent running now that soma did not dispatch: each terminal pane, in any session, " +
			"with claude in the foreground and no job of soma's in it, the human's own sessions included. " +
			"Each has an id, its session's label, the pane's label, its state (idle, working, blocked, done or error; " +
			"absent when it cannot be told; a blocked one with its prompt's options and fingerprint when its screen could be " +
			"read) and its cwd. A blocked one's prompt can be answered with respond, by its id as foreign, never for " +
			"kind=auth; an idle or done one can be sent a new prompt with foreign_prompt; what any one's pane shows now is " +
			"read with screen, by its id as foreign. soma never stops or resumes these. The jobs soma dispatched are listed " +
			"by jobs, not here.",
		parameters: obj({}),
		replay: "safe",
		execute: async () => text(await agents.listForeign()),
	});

	const foreignResult = defineTool({
		name: "foreign_result",
		description:
			"Read what a foreign agent's claude transcript ends on: id names its last record, and text is its last reply, " +
			"absent while the transcript ends awaiting one. An error when the id names no foreign agent now, or none of " +
			"its transcript can be read. What its pane shows now, as while it works, is read with screen.",
		parameters: obj({ id: str({ description: "The agent's id as foreign_agents listed it" }) }),
		replay: "safe",
		execute: async ({ id }) => {
			try {
				return text(
					(await agents.readForeignResult(id)) ?? { error: `no transcript of foreign agent ${id} can be read` },
				);
			} catch (error) {
				return text({ error: (error as Error).message });
			}
		},
	});

	const screen = defineTool({
		name: "screen",
		description:
			"Read what an agent's terminal pane shows now: the last lines of its screen and the output above it, as plain " +
			"text, read off the pane at this call, never from a status or result read before. Name a job by its card, as " +
			"jobs lists it, or a foreign agent by its id, as foreign_agents lists it; exactly one. Use it to see what an " +
			"agent is doing, asking or has printed, whatever jobs, foreign_agents or foreign_result last said of it. " +
			"more: true means earlier lines were left out; ask for more lines to see them. Read only: nothing is typed.",
		parameters: obj({
			card: opt(str({ description: "The job's card, as jobs listed it" })),
			foreign: opt(str({ description: "The foreign agent's id, as foreign_agents listed it, instead of card" })),
			lines: opt(
				int({
					minimum: 1,
					maximum: SCREEN_LINES_MAX,
					description: `How many of the pane's last lines to read; ${SCREEN_LINES} when left out`,
				}),
			),
		}),
		replay: "safe",
		execute: async ({ card, foreign, lines = SCREEN_LINES }, api, context) => {
			if ((card === undefined) === (foreign === undefined)) {
				return text({ error: "name either card, for a job, or foreign, for a foreign agent" });
			}
			try {
				if (foreign !== undefined) return text(tailOf(await agents.readForeignScreen(foreign), lines));
				const agent = await api.commit(
					async (tx) => (await tx.doc(Dispatches, api.conversationId)).jobs.find((each) => each.card === card)?.agent,
					context,
				);
				if (agent === undefined) return text({ error: `no job for card ${card}` });
				return text(tailOf(await agents.readScreen(agent), lines));
			} catch (error) {
				return text({ error: (error as Error).message });
			}
		},
	});

	const foreignPrompt = defineTool({
		name: "foreign_prompt",
		description:
			"Send a foreign agent a new prompt, as if typed at its pane: only one that is idle or done. Its state is read " +
			"again just before sending, and one that is working or blocked is refused with the reason, so the text never " +
			"lands in the middle of a turn or answers a dialog. No notice comes when its turn ends: read its reply with " +
			'foreign_result, or its pane with screen. sent: "unknown" means sending failed after some of the text may have ' +
			"reached the agent; look with foreign_agents and screen before sending again.",
		parameters: obj({
			id: str({ description: "The agent's id as foreign_agents listed it" }),
			text: str({ description: "The prompt to send" }),
		}),
		// Not replayed: a crash mid-call reports it interrupted rather than sending the prompt a second time.
		replay: "unsafe",
		execute: async ({ id, text: prompt }) => {
			try {
				await agents.promptForeign(id, prompt);
			} catch (error) {
				const message = (error as Error).message;
				return text(
					error instanceof PromptRefused ? { sent: false, refused: message } : { sent: "unknown", error: message },
				);
			}
			return { ...text({ sent: true }), details: FORWARDED };
		},
	});

	return defineExtension({
		name: "soma.dispatch",
		tools: [dispatch, jobs, respond, escalate, reply, foreignAgents, foreignResult, screen, foreignPrompt],
	});
}
