import type { Context } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import type { AgentPort, AgentStatusEvent } from "../../../ports/agent.ts";
import { observe } from "../../domain/bridge.ts";
import type { Job } from "../../domain/dispatch.ts";
import { reconcile } from "../../domain/reconcile.ts";
import { Dispatches } from "./index.ts";

/** Entry kind of a turn the bridge recorded as finished; it carries no model message. */
export const JOB_DONE = "soma.dispatch.done";
/** Entry kind of the input that wakes the model for a blocked agent. */
export const AGENT_BLOCKED = "soma.dispatch.blocked";

export const blockedRequestId = (agent: string, seq: number) => `herdr:${agent}:${seq}`;

/**
 * Host-side rules over agent status, outside the model loop (ARCHITECTURE.md「事件橋」).
 * A finished turn is committed to the dispatch list and the transcript, which starts no run;
 * only a blocked agent submits an input. Its requestId is the agent's transition counter, so a
 * resent event, from a repeated snapshot or a restarted core, is admitted once.
 */
export function eventBridge(conversation: Conversation, agents: AgentPort, context: Context) {
	// One event at a time: each reads the job, acts, then commits what it saw.
	let queue = Promise.resolve();

	async function apply(event: AgentStatusEvent): Promise<void> {
		// A doc is a live proxy only valid inside its commit, so the job is copied out as the JSON it is stored as.
		const job = await conversation.commit(async (tx) => {
			const found = (await tx.doc(Dispatches, conversation.id)).jobs.find(
				(candidate) => candidate.agent === event.agent,
			);
			return found && (JSON.parse(JSON.stringify(found)) as Job);
		}, context);
		if (job === undefined) return;
		const { job: next, action } = observe(job, event.status, event.seq);
		if (next === job) return;

		// Each side effect precedes the commit of its seq, so a crash in between redoes it on restart:
		// the requestId makes the second submit return the first.
		if (action === "wake" && event.status.state === "blocked") {
			const { kind, msg } = event.status;
			await conversation.submit(
				{
					type: "input",
					content:
						`[herdr] agent ${job.agent}（卡片 ${job.card}）卡住了，kind=${kind}${msg ? `：${msg}` : ""}。` +
						"判斷要代答還是轉給人；kind=auth 一律轉給人，不要代答。",
					whenBusy: "followUp",
					entry: { kind: AGENT_BLOCKED, data: { agent: job.agent, card: job.card, kind, seq: event.seq } },
					requestId: blockedRequestId(job.agent, event.seq),
				},
				context,
			);
		}
		if (action === "launch" && job.launch !== undefined) await agents.prompt(job.agent, job.launch);

		await conversation.commit(async (tx) => {
			const doc = await tx.doc(Dispatches, conversation.id);
			const index = doc.jobs.findIndex((candidate) => candidate.agent === event.agent);
			if (index === -1 || doc.jobs[index]?.seq === event.seq) return;
			doc.jobs[index] = next;
			if (action === "complete") {
				await tx.appendEntry(conversation.id, {
					kind: JOB_DONE,
					data: { agent: next.agent, card: next.card, state: next.status.state, seq: event.seq },
				});
			}
		}, context);
	}

	function handle(event: AgentStatusEvent): Promise<void> {
		const run = queue.then(() => apply(event));
		queue = run.catch(() => {});
		return run;
	}

	return {
		handle,
		/** Feeds every status the agent side reports from now on; returns the unsubscribe. */
		listen(onError: (error: unknown) => void): () => void {
			return agents.onStatus((event) => void handle(event).catch(onError));
		},
	};
}

/**
 * Startup step after `harness.resume()`: catch the dispatch list up with what changed while the
 * core was down. A listing with a transition counter goes through the bridge like any event, so a
 * turn that finished in the gap is recorded and a block that was already handed to the model is
 * not handed over again.
 */
export async function reconcileDispatches(conversation: Conversation, agents: AgentPort, context: Context) {
	const listed = await agents.list();
	const bridge = eventBridge(conversation, agents, context);
	for (const { name, status, seq } of listed) {
		if (status !== undefined && seq !== undefined) await bridge.handle({ agent: name, status, seq });
	}
	await conversation.commit(async (tx) => {
		const doc = await tx.doc(Dispatches, conversation.id);
		doc.jobs = [...reconcile(doc.jobs, listed)];
	}, context);
}
