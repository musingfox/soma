import type { AgentResult, AgentState } from "../../ports/agent.ts";
import type { HandedOver, Job } from "./dispatch.ts";
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
 * blocked agent is handed over unless its prompt is the one last handed over and no other status
 * was observed since; the same status after a turn may be a new turn between two samples, which
 * `complete` tells by the transcript's last record. The returned job no longer holds a launch prompt once the agent
 * has been seen to take work, from this prompt or anyone else's.
 */
export function observe(job: Job, status: AgentState, seq: number): Observed {
	if (job.seq === seq) return { job, action: "none" };
	const { launch, handedOver, ...rest } = job;
	const next: Job = { ...rest, status, seq };
	const from = job.status;
	const turned = job.seq !== undefined;
	switch (status.state) {
		case "blocked": {
			const { fingerprint, msg } = status;
			const held = launch === undefined ? next : { ...next, launch };
			if (handedOver !== undefined && handedOver.fingerprint === fingerprint && handedOver.msg === msg) {
				return { job: { ...held, handedOver }, action: "none" };
			}
			// Built without undefined members: a job is stored as JSON.
			const prompt: HandedOver = {
				...(fingerprint === undefined ? {} : { fingerprint }),
				...(msg === undefined ? {} : { msg }),
			};
			return { job: { ...held, handedOver: prompt }, action: status.kind === "auth" ? "escalate" : "wake" };
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
 * Settles a `complete` against what the agent's transcript ends on. The last record already recorded
 * is the same turn observed again, so only the observation is kept. A new one is a finished turn with
 * the outcome its reply's first line states, 未知 when it ends without one; so is a transcript that
 * could not be read at all, which leaves the recorded id alone. A job whose move could not read its last record takes the
 * first it reads as that record, with no turn of it, since nothing can tell what ended on it from what a cut turn left.
 */
export function complete(observed: Observed, result: AgentResult | undefined): Observed {
	if (observed.action !== "complete") return observed;
	const { job } = observed;
	if (job.resultUnread) {
		if (result === undefined) return { job, action: "none" };
		const { resultUnread: _read, ...rest } = job;
		return { job: { ...rest, resultId: result.id }, action: "none" };
	}
	if (result !== undefined && result.id === job.resultId) return { job, action: "none" };
	const outcome = outcomeOf(result?.text);
	return {
		job: result === undefined ? { ...job, outcome } : { ...job, outcome, resultId: result.id },
		action: "complete",
	};
}
