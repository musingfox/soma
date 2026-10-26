import type { AgentResult, AgentState } from "../../ports/agent.ts";
import type { Job } from "./dispatch.ts";
import { outcomeOf } from "./report.ts";

/**
 * launch: send the job's held launch prompt. wake: hand the blocked agent to the model.
 * escalate: hand it to the human without the model, as every kind=auth block is.
 * complete: record a finished turn without the model.
 */
export type BridgeAction = "none" | "launch" | "wake" | "escalate" | "complete";

export type Observed = { readonly job: Job; readonly action: BridgeAction };

/**
 * Folds one observation of a job's agent into the job. `seq` names the observation: one carrying
 * the job's own seq is a repeat and changes nothing, but a new seq does not promise the agent went
 * through a transition, so a status re-reported under a new seq acts only on what changed. A
 * blocked agent is handed over again only when the prompt differs; the same status after a turn
 * may be a new turn between two samples, which `complete` tells by the reply. The returned job no
 * longer holds a launch prompt once the agent has been seen to take work, from this prompt or
 * anyone else's.
 */
export function observe(job: Job, status: AgentState, seq: number): Observed {
	if (job.seq === seq) return { job, action: "none" };
	const { launch, ...rest } = job;
	const next: Job = { ...rest, status, seq };
	const from = job.status;
	const turned = job.seq !== undefined;
	switch (status.state) {
		case "blocked": {
			const held = launch === undefined ? next : { ...next, launch };
			if (from.state === "blocked" && from.fingerprint === status.fingerprint && from.msg === status.msg) {
				return { job: held, action: "none" };
			}
			return { job: held, action: status.kind === "auth" ? "escalate" : "wake" };
		}
		case "idle":
			if (launch !== undefined) return { job: next, action: "launch" };
			// done → idle is the agent side settling after the turn that `done` already recorded.
			return {
				job: next,
				action:
					from.state === "working" || from.state === "blocked" || (from.state === "idle" && turned)
						? "complete"
						: "none",
			};
		case "done":
			return { job: next, action: from.state === "done" && !turned ? "none" : "complete" };
		case "working":
		case "error":
			return { job: next, action: "none" };
	}
}

/**
 * Settles a `complete` against the reply read for it. The reply already recorded is the same turn
 * observed again, so only the observation is kept; a new reply, or none that could be read, is a
 * finished turn with the outcome its first line states.
 */
export function complete(observed: Observed, result: AgentResult | undefined): Observed {
	if (observed.action !== "complete") return observed;
	const { job } = observed;
	if (result !== undefined && result.id === job.resultId) return { job, action: "none" };
	const outcome = outcomeOf(result?.text);
	return {
		job: result === undefined ? { ...job, outcome } : { ...job, outcome, resultId: result.id },
		action: "complete",
	};
}
