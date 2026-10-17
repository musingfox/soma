import type { AgentState, BlockedKind } from "../../ports/agent.ts";

export interface Decision {
	readonly at: string;
	readonly kind: BlockedKind;
	readonly action: "answered" | "escalated";
	readonly reason: string;
}

export interface Job {
	readonly card: string;
	readonly agent: string;
	readonly sessionId: string;
	readonly status: AgentState;
	readonly decisions: readonly Decision[];
}

export type DispatchList = readonly Job[];
