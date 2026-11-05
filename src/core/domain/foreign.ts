import type { AgentState } from "../../ports/agent.ts";
import type { HandedOver } from "./dispatch.ts";

/**
 * By foreign agent id, the prompt last told to the human, until a status other than blocked is seen for that agent: the
 * same prompt observed again is not told twice. The one rule `Job.handedOver` keeps for a job.
 */
export type Told = Record<string, HandedOver>;

/** push: tell the human of the prompt on screen. forget: the agent is past the prompt it was told of. */
export type ForeignAction = "none" | "push" | "forget";

/**
 * Folds one observation of a foreign agent into what was told of it (ARCHITECTURE.md "Foreign agents"). A blocked
 * agent is pushed only while the human is not looking at its pane, and only for a prompt other than the one told; one
 * the human is looking at is left untold, so it is pushed if they look away while it waits. Any other status, and
 * another prompt seen while looked at, forgets the prompt told, so the agent's next block is a new one.
 */
export function observeForeign(told: HandedOver | undefined, status: AgentState, watched: boolean): ForeignAction {
	if (status.state !== "blocked") return told === undefined ? "none" : "forget";
	if (told !== undefined && samePrompt(told, status)) return "none";
	// Another prompt than the one told, looked at: the agent is past the one told, so it is forgotten, and a pending push
	// for it (`escalation`) is dropped as for any answered prompt.
	if (watched) return told === undefined ? "none" : "forget";
	return "push";
}

/** Whether a blocked status shows the prompt that was told: the same fingerprint and the same screen text. */
export function samePrompt(
	told: HandedOver,
	status: { readonly fingerprint?: string; readonly msg?: string },
): boolean {
	return told.fingerprint === status.fingerprint && told.msg === status.msg;
}

/** What `Told` keeps of a blocked status, without undefined members: it is stored as JSON. */
export function toldOf(status: Extract<AgentState, { state: "blocked" }>): HandedOver {
	const { fingerprint, msg } = status;
	return { ...(fingerprint === undefined ? {} : { fingerprint }), ...(msg === undefined ? {} : { msg }) };
}
