// State vocabulary is OSC 7501's: https://www.superlogical.com/rex/docs/build/program-status
export type BlockedKind = "permission" | "question" | "auth";

export type AgentState =
	| { readonly state: "idle" | "working" | "done" | "error"; readonly msg?: string }
	| { readonly state: "blocked"; readonly kind: BlockedKind; readonly msg?: string };

export interface StartRequest {
	readonly name: string;
	readonly card: string;
	readonly cwd: string;
	// Chosen and stored by the caller before start, so a rerun after a crash passes the same one.
	readonly sessionId: string;
}

export interface AgentListing {
	readonly name: string;
	// Absent when the agent side cannot tell, which is no claim either way.
	readonly status?: AgentState;
	readonly sessionId?: string;
	// herdr's state_change_seq, when the agent side counts transitions.
	readonly seq?: number;
}

export interface AgentStatusEvent {
	readonly agent: string;
	readonly status: AgentState;
	// herdr's state_change_seq; event-bridge requestIds are herdr:<agent>:<seq>.
	readonly seq: number;
}

export interface AgentPort {
	start(request: StartRequest): Promise<void>;
	list(): Promise<readonly AgentListing[]>;
	prompt(agent: string, text: string): Promise<void>;
	onStatus(listener: (event: AgentStatusEvent) => void): () => void;
	readResult(agent: string): Promise<string | undefined>;
	respond(agent: string, answer: string): Promise<void>;
	stop(agent: string): Promise<void>;
}
