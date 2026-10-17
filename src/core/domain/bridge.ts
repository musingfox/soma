import type { AgentState } from "../../ports/agent.ts";
import type { Job } from "./dispatch.ts";

/**
 * launch: send the job's held launch prompt. wake: hand the blocked agent to the model.
 * escalate: hand it to the human without the model, as every kind=auth block is.
 * complete: record a finished turn without the model.
 */
export type BridgeAction = "none" | "launch" | "wake" | "escalate" | "complete";

/**
 * Folds one observation of a job's agent into the job. `seq` is the agent side's transition
 * counter, so an observation carrying the job's own seq is a repeat and changes nothing, while
 * the same status under a new seq means the agent went somewhere and came back between two
 * samples. The returned job no longer holds a launch prompt once the agent has been seen to
 * take work, from this prompt or anyone else's.
 */
export function observe(job: Job, status: AgentState, seq: number): { job: Job; action: BridgeAction } {
	if (job.seq === seq) return { job, action: "none" };
	const { launch, ...rest } = job;
	const next: Job = { ...rest, status, seq };
	const from = job.status.state;
	const turned = job.seq !== undefined;
	switch (status.state) {
		case "blocked":
			return {
				job: launch === undefined ? next : { ...next, launch },
				action: status.kind === "auth" ? "escalate" : "wake",
			};
		case "idle":
			if (launch !== undefined) return { job: next, action: "launch" };
			// done → idle is herdr settling after the turn that `done` already recorded.
			return {
				job: next,
				action: from === "working" || from === "blocked" || (from === "idle" && turned) ? "complete" : "none",
			};
		case "done":
			return { job: next, action: from === "done" && !turned ? "none" : "complete" };
		case "working":
		case "error":
			return { job: next, action: "none" };
	}
}
