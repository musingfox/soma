// State vocabulary is OSC 7501's: https://www.superlogical.com/rex/docs/build/program-status
export type BlockedKind = "permission" | "question" | "auth";

export type AgentState =
	| { readonly state: "idle" | "working" | "done" | "error"; readonly msg?: string }
	| {
			readonly state: "blocked";
			readonly kind: BlockedKind;
			readonly msg?: string;
			// Identifies the prompt on screen; an answer carries it back, so a changed screen refuses the answer.
			readonly fingerprint?: string;
	  };

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

export interface Answer {
	readonly option: string;
	// The fingerprint of the blocked status the answer was decided on.
	readonly fingerprint: string;
}

/**
 * not_blocked: the agent no longer waits on anything. stale: the prompt on screen is not the one answered.
 * unknown_option: the prompt offers no such option. auth: credentials are the human's to give.
 * unreadable: nothing on screen could be parsed into options.
 */
export type AnswerRefusal = "not_blocked" | "stale" | "unknown_option" | "auth" | "unreadable";

export type AnswerOutcome = { readonly sent: true } | { readonly sent: false; readonly refusal: AnswerRefusal };

export interface AgentPort {
	start(request: StartRequest): Promise<void>;
	list(): Promise<readonly AgentListing[]>;
	prompt(agent: string, text: string): Promise<void>;
	onStatus(listener: (event: AgentStatusEvent) => void): () => void;
	readResult(agent: string): Promise<string | undefined>;
	// Re-reads the screen before sending: a stored status is never trusted to still be on it.
	respond(agent: string, answer: Answer): Promise<AnswerOutcome>;
	stop(agent: string): Promise<void>;
}
