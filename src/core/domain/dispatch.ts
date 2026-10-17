import type { AgentState, BlockedKind } from "../../ports/agent.ts";

// Type aliases, not interfaces: a job is stored as JSON, and only aliases and mutable arrays fit its JsonValue type.
export type Decision = {
	readonly at: string;
	readonly kind: BlockedKind;
	readonly action: "answered" | "escalated";
	readonly reason: string;
};

export type Job = {
	readonly card: string;
	readonly agent: string;
	readonly sessionId: string;
	readonly status: AgentState;
	readonly decisions: Decision[];
};

export type DispatchList = readonly Job[];
