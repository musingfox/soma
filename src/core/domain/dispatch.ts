import type { AgentState, BlockedKind } from "../../ports/agent.ts";
import type { Outcome } from "./report.ts";

// Type aliases, not interfaces: a job is stored as JSON, and only aliases and mutable arrays fit its JsonValue type.
/** The reason an answered decision carries when the human pressed the option themselves, not the model. */
export const HUMAN_CHOSEN = "人親自選的選項";

export type Decision = {
	readonly at: string;
	readonly kind: BlockedKind;
	readonly action: "answered" | "escalated" | "replied";
	// The option pressed, and the prompt it was pressed on, when answered.
	readonly option?: string;
	readonly fingerprint?: string;
	// The words sent to the agent, when replied.
	readonly text?: string;
	readonly reason: string;
};

export type HandedOver = { readonly fingerprint?: string; readonly msg?: string };

/**
 * Where soma is in stopping an agent that deferred an instruction (ARCHITECTURE.md "Agent-deferred instructions").
 * due: a deferral is pending, so the agent is stopped the first time it is seen idle or done. stopping: committed
 * before `stop`, so a restart knows a stop may have gone out. stopped: the agent is gone because soma stopped it, so
 * its absence is no failure. failed: `stop` failed and the human was told; not tried again for the deferrals pending.
 * sending: a deferral's prompt may be going out, so the agent is not stopped; due again after it if one is pending.
 */
export type Reclaim = {
	readonly phase: "due" | "sending" | "stopping" | "stopped" | "failed";
	readonly error?: string;
};

export type Job = {
	readonly card: string;
	readonly agent: string;
	readonly sessionId: string;
	readonly status: AgentState;
	// Names the observation that set `status`; an event carrying the same one was already handled.
	readonly seq?: number;
	// The first prompt, held until the agent can take it: claude refuses prompts until its trust dialog is answered.
	readonly launch?: string;
	// Read off the result line of the agent's last finished turn.
	readonly outcome?: Outcome | "未知";
	// The id of the transcript's last record when a finished turn was last recorded; the same record observed again is
	// no new turn (src/ports/agent.ts, AgentResult).
	readonly resultId?: string;
	// The prompt of the last block handed to the model or the human, until a status other than blocked is seen: the
	// same prompt observed again is not handed over twice. `status` cannot tell, since reconcile writes it unobserved.
	readonly handedOver?: HandedOver;
	// Absent for a job with no deferral pending that soma has not stopped.
	readonly reclaim?: Reclaim;
	readonly decisions: Decision[];
};

export type DispatchList = readonly Job[];
