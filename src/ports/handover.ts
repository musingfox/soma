/**
 * unknown: there is no such job. no_hangar: this soma has no rex hangar to hand over to. not_acp: the job does not run
 * over ACP, as one already handed over. not_at_rest: it is working, blocked or stopped. cannot_resume: the session
 * cannot go on on the other side, as one that never ran a prompt, or one whose move could not be recorded.
 */
export type HandoverRefusal = "unknown" | "no_hangar" | "not_acp" | "not_at_rest" | "cannot_resume";

export type Refused = { readonly refusal: HandoverRefusal; readonly reason: string };

export type HandoverOutcome =
	| {
			readonly handedOver: true;
			// The window's label, and the label of the session it is in, as the human sees them.
			readonly window: string;
			readonly session: string;
			// The claude session the window runs: the id the job goes by from now on.
			readonly sessionId: string;
			// Whether claude reported itself up in the window before the handover stopped waiting for it.
			readonly ready: boolean;
	  }
	| ({ readonly handedOver: false } & Refused);

/** Beside AgentPort: moves an agent at rest to an agent side the human can see, for good. */
export interface AgentHandover {
	// A refusal has done nothing, unless its reason says the agent's process ended and the job stays where it was.
	handOver(agent: string): Promise<HandoverOutcome>;
}

/** The claude session an agent runs, as the side that holds it recorded it. */
export interface HeldSession {
	readonly name: string;
	readonly card: string;
	// The one the agent's StartRequest carried.
	readonly sessionId: string;
	// claude's own id, which names its transcript and which --resume takes.
	readonly claudeSession: string;
	// The directory's realpath, which claude names the transcript's directory after.
	readonly cwd: string;
}

/** The side a session moves away from. */
export interface SessionGiver {
	// What `release` would give up now, with nothing done.
	releasable(agent: string): Promise<HeldSession | Refused>;
	// Ends the agent's process and records that this side never takes the agent up again, unless `reinstate` says so.
	release(agent: string): Promise<HeldSession | Refused>;
	// A release the other side could not follow up: the agent is this side's again, with no process.
	reinstate(agent: string): Promise<void>;
	// Every session this side gave up and did not take back, a soma before this one's too.
	released(): Promise<readonly HeldSession[]>;
}

/** The side a session moves to. */
export interface SessionTaker {
	// Why `take` would refuse now, with nothing done; undefined when it would not.
	takeable(session: HeldSession): Promise<string | undefined>;
	// Opens the session where the human can see it, and waits a bounded time for its claude to come up.
	take(session: HeldSession): Promise<{ readonly window: string; readonly session: string; readonly ready: boolean }>;
}
