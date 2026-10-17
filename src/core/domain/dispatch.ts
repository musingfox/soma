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
	// The agent side's transition counter at `status`; an event carrying the same one was already handled.
	readonly seq?: number;
	// The first prompt, held until the agent can take it: claude refuses prompts until its trust dialog is answered.
	readonly launch?: string;
	readonly decisions: Decision[];
};

export type DispatchList = readonly Job[];
