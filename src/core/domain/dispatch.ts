import type { AgentState, BlockedKind } from "../../ports/agent.ts";
import type { Outcome } from "./report.ts";

// Type aliases, not interfaces: a job is stored as JSON, and only aliases and mutable arrays fit its JsonValue type.
export type Decision = {
	readonly at: string;
	readonly kind: BlockedKind;
	readonly action: "answered" | "escalated";
	// The option pressed, and the prompt it was pressed on, when answered.
	readonly option?: string;
	readonly fingerprint?: string;
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
	// Read off the result line of the agent's last finished turn.
	readonly outcome?: Outcome | "未知";
	readonly decisions: Decision[];
};

export type DispatchList = readonly Job[];
