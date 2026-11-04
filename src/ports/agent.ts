// State vocabulary is OSC 7501's: https://www.superlogical.com/rex/docs/build/program-status
export type BlockedKind = "permission" | "question" | "auth";

/** One option of a prompt on screen: `id` is what an answer names, `label` the terminal's own wording. */
export type Choice = { readonly id: string; readonly label: string };

export type AgentState =
	| { readonly state: "idle" | "working" | "done" | "error"; readonly msg?: string }
	| {
			readonly state: "blocked";
			readonly kind: BlockedKind;
			readonly msg?: string;
			// Identifies the prompt on screen; an answer carries it back, so a changed screen refuses the answer.
			readonly fingerprint?: string;
			// A mutable array: a status is stored in the dispatch list as JSON, which takes no readonly array.
			readonly options?: Choice[];
	  };

export interface StartRequest {
	readonly name: string;
	readonly card: string;
	readonly cwd: string;
	// Chosen and stored by the caller before start, so a rerun after a crash passes the same one.
	readonly sessionId: string;
}

/** An agent to start again in the session it was started with, in the directory that session ran in. */
export interface ResumeRequest {
	readonly name: string;
	readonly card: string;
	// The one its StartRequest carried, as the dispatch list holds it.
	readonly sessionId: string;
}

export interface AgentListing {
	readonly name: string;
	// Absent when the agent side cannot tell, which is no claim either way.
	readonly status?: AgentState;
	readonly sessionId?: string;
	// Names the observation, as on AgentStatusEvent; absent when the agent side has none to name it by.
	readonly seq?: number;
}

export interface AgentStatusEvent {
	readonly agent: string;
	readonly status: AgentState;
	// Names the observation: the same value is the same observation, so a resent one is recognised, but a new
	// value does not promise the agent went through a transition. Event-bridge requestIds are agent:<agent>:<seq>.
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

/**
 * What the agent's transcript ends on. `id` names its last record that carries one, whoever wrote it: the user's
 * prompt, a tool result or the assistant's reply. A finished turn re-reported reads the same id, so it is told from a
 * new turn whether that turn ended on a reply or on the user, as an interrupted turn or a denied permission does.
 * `text` is the final reply, present only when the transcript does not end awaiting one.
 */
export type AgentResult = { readonly id: string; readonly text?: string };

/**
 * What `prompt` throws when it refused before typing anything, as for an agent busy with a turn: trying again later
 * cannot send the text twice. Any other error may come after some of the text reached the agent.
 */
export class PromptRefused extends Error {}

export interface AgentPort {
	start(request: StartRequest): Promise<void>;
	// Keeps the session's conversation; makes no worktree, and is not held to the hangar cap that start is, since only a
	// due deferred instruction resumes an agent. Refuses a name already listed.
	resume(request: ResumeRequest): Promise<void>;
	list(): Promise<readonly AgentListing[]>;
	// Throws PromptRefused when it typed nothing.
	prompt(agent: string, text: string): Promise<void>;
	onStatus(listener: (event: AgentStatusEvent) => void): () => void;
	// Undefined only when no transcript, or no record in it with an id, can be read.
	readResult(agent: string): Promise<AgentResult | undefined>;
	// Re-reads the screen before sending: a stored status is never trusted to still be on it.
	respond(agent: string, answer: Answer): Promise<AnswerOutcome>;
	stop(agent: string): Promise<void>;
}
