// State vocabulary is OSC 7501's: https://www.superlogical.com/rex/docs/build/program-status
export type BlockedKind = "permission" | "question" | "auth";

export type AgentState =
	| { readonly state: "idle" | "working" | "done" | "error"; readonly msg?: string }
	| { readonly state: "blocked"; readonly kind: BlockedKind; readonly msg?: string };

export interface StartRequest {
	readonly name: string;
	readonly card: string;
	readonly cwd: string;
}

export interface AgentStatusEvent {
	readonly agent: string;
	readonly status: AgentState;
	// herdr's state_change_seq; event-bridge requestIds are herdr:<agent>:<seq>.
	readonly seq: number;
}

export interface AgentPort {
	start(request: StartRequest): Promise<{ readonly sessionId: string }>;
	prompt(agent: string, text: string): Promise<void>;
	onStatus(listener: (event: AgentStatusEvent) => void): () => void;
	readResult(agent: string): Promise<string | undefined>;
	respond(agent: string, answer: string): Promise<void>;
	stop(agent: string): Promise<void>;
}
