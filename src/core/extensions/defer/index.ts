import type { Context } from "@earendil-works/chord/context";
import { type Conversation, defineDoc, defineExtension, defineTask } from "@earendil-works/pi-durable";
import { type AgentPort, PromptRefused } from "../../../ports/agent.ts";
import type { DeferReply, DeferRequest } from "../../../ports/defer.ts";
import { type Deferred, deferAt, deferNotice, deferredPrompt } from "../../domain/defer.ts";
import { noticeEntry } from "../../notice.ts";
import { Dispatches } from "../dispatch/index.ts";

/** Pending deferrals by task id; one leaves in the commit that ends its task. */
export const Deferrals = defineDoc<{ items: Record<string, Deferred> }>({
	kind: "soma.defer.items",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: {} }),
	checkpointWhen: () => false,
});

/** How a deferral ended: sent, or why it was not, each but `sent` told to the human in one notice. */
export type DeferOutcome = "sent" | "gone" | "unsure" | "failed";

type Checkpoint =
	| { phase: "wait"; at: number; tries: number; error?: string }
	// Committed before the prompt goes out: a rerun that finds it cannot tell whether the agent got it.
	| { phase: "sending"; tries: number };

export interface DeferOptions {
	/** How long after a prompt that failed, say to a busy agent, it is tried again. */
	readonly retryMs?: number;
	/** Prompts tried, the first included, before the human is told it was not sent. */
	readonly tries?: number;
}

/**
 * Deferrals an agent asks for with `soma defer` (ARCHITECTURE.md "Event bridge": host code, not the model). Each is a
 * background task of the root conversation that sleeps until `at` and then prompts the agent through `agents`,
 * submitting nothing to the conversation. The prompt goes out at most once: the task commits `sending` before it, so a
 * crash between the prompt and the terminal commit ends the rerun with a notice instead of a second prompt.
 */
export function deferExtension(agents: Pick<AgentPort, "list" | "prompt">, options: DeferOptions = {}) {
	const retryMs = options.retryMs ?? 30_000;
	const tries = options.tries ?? 20;

	const Deferral = defineTask<Deferred, Checkpoint, DeferOutcome>({
		name: "soma.defer",
		version: 1,
		initial: ({ at }) => ({ phase: "wait", at, tries: 0 }),
		phases: {
			wait: async (task, runtime, context) => {
				const checkpoint = task.state.checkpoint;
				if (runtime.now() < checkpoint.at) return runtime.sleepUntil(checkpoint.at, checkpoint, context);
				const id = String(task.id);
				const end = (outcome: DeferOutcome, notice?: string) =>
					runtime.commit(async (tx) => {
						delete (await tx.doc(Deferrals, runtime.conversationId)).items[id];
						if (notice !== undefined) await tx.appendEntry(runtime.conversationId, noticeEntry("report", notice));
						return { status: "terminal", outcome: { status: "completed", result: outcome } };
					}, context);
				const retry = (error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					const tried = checkpoint.tries + 1;
					if (tried >= tries) return end("failed", deferNotice.failed(id, task.input, tried, message));
					const until = runtime.now() + retryMs;
					return runtime.commit(
						() => ({
							status: "sleeping",
							until,
							checkpoint: { phase: "wait", at: until, tries: tried, error: message },
						}),
						context,
					);
				};

				let listed: boolean;
				try {
					listed = (await agents.list()).some((agent) => agent.name === task.input.agent);
				} catch (error) {
					return retry(error);
				}
				if (!listed) return end("gone", deferNotice.gone(id, task.input));
				await runtime.commit(
					() => ({ status: "running", checkpoint: { phase: "sending", tries: checkpoint.tries } }),
					context,
				);
				try {
					await agents.prompt(task.input.agent, deferredPrompt(id, task.input));
				} catch (error) {
					// Tried again only when the adapter refused before it typed, as rex does for a busy agent: any other
					// failure may come after the text reached the agent, and the prompt goes out at most once.
					if (error instanceof PromptRefused) return retry(error);
					return end(
						"unsure",
						deferNotice.unsure(id, task.input, error instanceof Error ? error.message : String(error)),
					);
				}
				await end("sent");
			},
			// Reached only by a rerun: the run that committed `sending` went on to prompt without ending.
			sending: async (task, runtime, context) => {
				const id = String(task.id);
				await runtime.commit(async (tx) => {
					delete (await tx.doc(Deferrals, runtime.conversationId)).items[id];
					await tx.appendEntry(runtime.conversationId, noticeEntry("report", deferNotice.unsure(id, task.input)));
					return { status: "terminal", outcome: { status: "completed", result: "unsure" } };
				}, context);
			},
		},
		abort: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				delete (await tx.doc(Deferrals, runtime.conversationId)).items[String(task.id)];
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});

	/**
	 * Accepts `request` when its agent names a job of the conversation's dispatch list, and creates its task in the same
	 * commit; refuses it with a reason the agent can read otherwise.
	 */
	async function defer(conversation: Conversation, request: DeferRequest, context: Context): Promise<DeferReply> {
		const setAt = Date.now();
		let at: number;
		try {
			at = deferAt(request.at, setAt);
		} catch (error) {
			return { accepted: false, reason: (error as Error).message };
		}
		const instruction = request.instruction.trim();
		if (instruction === "") return { accepted: false, reason: "the instruction is empty" };
		return conversation.commit(async (tx): Promise<DeferReply> => {
			const job = (await tx.doc(Dispatches, conversation.id)).jobs.find((each) => each.card === request.agent);
			if (job === undefined) {
				return {
					accepted: false,
					reason: `soma dispatched no agent for card "${request.agent}" (SOMA_AGENT); it defers instructions only for agents it dispatched`,
				};
			}
			const item: Deferred = { agent: job.agent, card: job.card, instruction, at, setAt };
			const id = await tx.createTask(Deferral, item, { ownership: { kind: "conversation" }, background: true });
			(await tx.doc(Deferrals, conversation.id)).items[String(id)] = item;
			return { accepted: true, id: String(id), at: new Date(at).toISOString() };
		}, context);
	}

	return { extension: defineExtension({ name: "soma.defer", tasks: [Deferral] }), defer };
}
