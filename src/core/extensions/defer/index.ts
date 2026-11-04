import type { Context } from "@earendil-works/chord/context";
import { type Conversation, defineDoc, defineExtension, defineTask, type Tx } from "@earendil-works/pi-durable";
import { type AgentPort, PromptRefused } from "../../../ports/agent.ts";
import type { DeferReply, DeferRequest } from "../../../ports/defer.ts";
import { type Deferred, deferAt, deferNotice, deferredPrompt } from "../../domain/defer.ts";
import { noticeEntry } from "../../notice.ts";
import { Dispatches } from "../dispatch/index.ts";
import { reclaimer } from "../dispatch/reclaim.ts";

/**
 * Pending deferrals by task id; one leaves in the commit that ends its task. `sending` is set in the commit before its
 * prompt, while its job's reclaim waits.
 */
export const Deferrals = defineDoc<{ items: Record<string, Deferred & { sending?: boolean }> }>({
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

/**
 * Marks deferral `id` of `agent` as no longer being sent. Its job, held `sending` while a prompt may go out, is due again
 * once no deferral of the agent is being sent.
 */
async function release(tx: Tx, conversation: Conversation["id"], id: string, agent: string): Promise<void> {
	const { items } = await tx.doc(Deferrals, conversation);
	const item = items[id];
	if (item?.sending) {
		const { sending: _sent, ...rest } = item;
		items[id] = rest;
	}
	if (Object.values(items).some((each) => each.agent === agent && each.sending)) return;
	const doc = await tx.doc(Dispatches, conversation);
	const index = doc.jobs.findIndex((job) => job.agent === agent);
	const current = doc.jobs[index];
	if (current?.reclaim?.phase === "sending") doc.jobs[index] = { ...current, reclaim: { phase: "due" } };
}

/**
 * Takes deferral `id` of `agent` off the pending ones. With none of the agent's left, its job is no longer due to be
 * stopped, so an agent that got its instruction while still open is not stopped when that turn ends, and a failed stop
 * is forgotten; a stopped one stays stopped. With some left, it is due again unless one is being sent.
 */
async function settle(tx: Tx, conversation: Conversation["id"], id: string, agent: string): Promise<void> {
	const { items } = await tx.doc(Deferrals, conversation);
	delete items[id];
	if (Object.values(items).some((item) => item.agent === agent)) return release(tx, conversation, id, agent);
	const doc = await tx.doc(Dispatches, conversation);
	const index = doc.jobs.findIndex((job) => job.agent === agent);
	const current = doc.jobs[index];
	const phase = current?.reclaim?.phase;
	if (current === undefined || (phase !== "due" && phase !== "sending" && phase !== "failed")) return;
	const { reclaim: _disarmed, ...rest } = current;
	doc.jobs[index] = rest;
}

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
 * crash between the prompt and the terminal commit ends the rerun with a notice instead of a second prompt. An accepted
 * defer arms its job's reclaim, and stops an agent already at rest; one soma stopped, or is stopping, takes the gone
 * path at fire time, until resuming it is built (`agent-defer-resume`). The `sending` commit also moves a due job to
 * `sending`, after checking its phase in the same commit, so a reclaim and a prompt never both go ahead: an idle the
 * agent reports between the prompt and its end stops nothing.
 */
export function deferExtension(agents: Pick<AgentPort, "list" | "prompt" | "stop">, options: DeferOptions = {}) {
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
				const ending = async (tx: Tx, outcome: DeferOutcome, notice?: string) => {
					await settle(tx, runtime.conversationId, id, task.input.agent);
					if (notice !== undefined) await tx.appendEntry(runtime.conversationId, noticeEntry("report", notice));
					return { status: "terminal" as const, outcome: { status: "completed" as const, result: outcome } };
				};
				const end = (outcome: DeferOutcome, notice?: string) =>
					runtime.commit((tx) => ending(tx, outcome, notice), context);
				const retry = (error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					const tried = checkpoint.tries + 1;
					if (tried >= tries) return end("failed", deferNotice.failed(id, task.input, tried, message));
					const until = runtime.now() + retryMs;
					return runtime.commit(async (tx) => {
						// A prompt refused before it typed holds the job no longer: it may be stopped while this waits.
						await release(tx, runtime.conversationId, id, task.input.agent);
						return {
							status: "sleeping",
							until,
							checkpoint: { phase: "wait", at: until, tries: tried, error: message },
						};
					}, context);
				};

				const job = (await runtime.snapshot(Dispatches, runtime.conversationId, context))?.jobs.find(
					(each) => each.agent === task.input.agent,
				);
				const reclaim = job?.reclaim?.phase;
				if (reclaim === "stopping" || reclaim === "stopped") return end("gone", deferNotice.gone(id, task.input));
				let listed: boolean;
				try {
					listed = (await agents.list()).some((agent) => agent.name === task.input.agent);
				} catch (error) {
					return retry(error);
				}
				if (!listed) return end("gone", deferNotice.gone(id, task.input));
				// The phase read above may be stale: a reclaim that committed `stopping` since wins, and nothing is sent.
				let sending = false;
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(Dispatches, runtime.conversationId);
					const index = doc.jobs.findIndex((each) => each.agent === task.input.agent);
					const current = doc.jobs[index];
					const phase = current?.reclaim?.phase;
					if (phase === "stopping" || phase === "stopped") return ending(tx, "gone", deferNotice.gone(id, task.input));
					if (current !== undefined && phase === "due") doc.jobs[index] = { ...current, reclaim: { phase: "sending" } };
					const { items } = await tx.doc(Deferrals, runtime.conversationId);
					const item = items[id];
					if (item !== undefined) items[id] = { ...item, sending: true };
					sending = true;
					return { status: "running", checkpoint: { phase: "sending", tries: checkpoint.tries } };
				}, context);
				if (!sending) return;
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
					await settle(tx, runtime.conversationId, id, task.input.agent);
					await tx.appendEntry(runtime.conversationId, noticeEntry("report", deferNotice.unsure(id, task.input)));
					return { status: "terminal", outcome: { status: "completed", result: "unsure" } };
				}, context);
			},
		},
		abort: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				await settle(tx, runtime.conversationId, String(task.id), task.input.agent);
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});

	/**
	 * Accepts `request` when its agent names a job of the conversation's dispatch list, and creates its task in the same
	 * commit, with the job due to be stopped; refuses it with a reason the agent can read otherwise. An agent the listing
	 * shows idle or done already is stopped before the reply, as one at work is when its turn ends; one that runs
	 * `soma defer` itself is at work, so it is not stopped under its own command.
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
		const { reply, agent } = await conversation.commit(async (tx) => {
			const doc = await tx.doc(Dispatches, conversation.id);
			const index = doc.jobs.findIndex((each) => each.card === request.agent);
			const job = doc.jobs[index];
			if (job === undefined) {
				const reply: DeferReply = {
					accepted: false,
					reason: `soma dispatched no agent for card "${request.agent}" (SOMA_AGENT); it defers instructions only for agents it dispatched`,
				};
				return { reply, agent: undefined };
			}
			const item: Deferred = { agent: job.agent, card: job.card, instruction, at, setAt };
			const id = await tx.createTask(Deferral, item, { ownership: { kind: "conversation" }, background: true });
			(await tx.doc(Deferrals, conversation.id)).items[String(id)] = item;
			// A failed stop is tried once more for a new deferral; one stopped or under way is left as it is.
			const phase = job.reclaim?.phase;
			if (phase === undefined || phase === "failed") doc.jobs[index] = { ...job, reclaim: { phase: "due" } };
			const reply: DeferReply = { accepted: true, id: String(id), at: new Date(at).toISOString() };
			return { reply, agent: job.agent };
		}, context);
		// The defer is committed whatever the reclaim meets: a job left due is stopped at its next idle or done, or by the
		// next restart's reconcile.
		if (agent !== undefined) await reclaimer(conversation, agents, context)(agent).catch(() => {});
		return reply;
	}

	return { extension: defineExtension({ name: "soma.defer", tasks: [Deferral] }), defer };
}
