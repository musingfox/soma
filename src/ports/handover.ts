import type { AnswerOutcome } from "./agent.ts";

/**
 * unknown: there is no such job. no_hangar: this soma has no rex hangar to hand over to. not_acp: the job does not run
 * over ACP, as one already handed over. not_at_rest: nothing can be cut to move it, as one blocked on a login, waking, or
 * with no session open yet, or one soma stopped; or its turn did not stop when cancelled, or ended by itself as the
 * cancel went out. cannot_resume: the session cannot go on on the other side, as one that never ran a prompt or has
 * written none of it yet, or one whose move could not be recorded.
 */
export type HandoverRefusal = "unknown" | "no_hangar" | "not_acp" | "not_at_rest" | "cannot_resume";

export type Refused = { readonly refusal: HandoverRefusal; readonly reason: string };

/** What a handover cut to move a job that was not at rest: its running turn, with the permission prompt it waited on. */
export type Cut = { readonly prompt?: string };

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
			// Absent for a job that was at rest.
			readonly cut?: Cut;
	  }
	| ({
			readonly handedOver: false;
			// What was cut before the handover failed: the turn is over all the same.
			readonly cut?: Cut;
			// The job was given back to ACP, and this names the return, as `at` of a Settled and `givenBack` do.
			readonly back?: number;
	  } & Refused);

/** A `respond` refused because the agent's side is not known yet: a refusal as any other, with why beside it. */
export type AnswerHeld = Extract<AnswerOutcome, { sent: false }> & { readonly reason: string };

/** Beside AgentPort: moves an agent to an agent side the human can see, for good, cutting the turn it runs if it runs one. */
export interface AgentHandover {
	// A refusal has done nothing, unless it says something was cut or its reason says the agent's process ended: the job
	// then stays where it was, or waits, taking no prompt, for the other side to answer which side it is on. `record` keeps
	// an outcome that landed the job, cut a turn or gave it back, before anything else of the job reaches the caller: while
	// the job moves, no status of it does.
	handOver(agent: string, record?: (outcome: HandoverOutcome) => Promise<void>): Promise<HandoverOutcome>;
}

/**
 * A job on a side no `handOver` answered for. rex: its window is `window` in the session labelled `session`, and it runs
 * the claude session `sessionId`. acp: a look gave it back, and its next prompt goes on in its session; `at` names this
 * return, and `startup` says it was found as this soma started, when the restart's notice names an unfinished job. gone:
 * it went to rex for good, and no window of it is there now. refused: a `handOver` refused it after it cut its turn or
 * gave it back, and the `record` of that failed: `outcome` is what the record was to keep, and `id` names this refusal,
 * the one value it is told by.
 */
export type Settled =
	| {
			readonly agent: string;
			readonly onto: "rex";
			readonly window: string;
			readonly session: string;
			readonly sessionId: string;
			// The record the transcript ends on as the window is told: no turn of what ran before it.
			readonly lastRecord?: string;
			// A `handOver` answered for it, whole, and only its record failed: its handover was not cut short.
			readonly answered?: true;
	  }
	| { readonly agent: string; readonly onto: "acp"; readonly at: number; readonly startup: boolean }
	| { readonly agent: string; readonly onto: "gone"; readonly sessionId: string }
	| {
			readonly agent: string;
			readonly onto: "refused";
			readonly id: string;
			readonly outcome: Extract<HandoverOutcome, { handedOver: false }>;
	  };

/** Beside AgentHandover: tells whoever keeps the jobs what no `handOver` answered. */
export interface HandoverSettling {
	// Each job as a look settles it, and what settled before the listener came. Every job on rex at startup and every job
	// given back and not handed over since is said again, since a soma can die before the listener's commit: the listener
	// tells a job on rex it has told by the session the job holds, and a return it has told by its `at`. So is a job a
	// `record` that failed could not keep, and a refusal it could not keep is said until a listener answers it, which tells
	// one it has told by its `id`. A listener that rejects has not recorded a job on rex: its window reports nothing from
	// then on, for what it says would read as the end of a turn on a job recorded as it was before the move.
	onSettled(listener: (settled: Settled) => void | Promise<void>): () => void;
	// Once what settled before the listener came has been said and the listener has answered.
	heard(): Promise<void>;
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
	// What the session reported as its model when it was created: all there is before a reply names one.
	readonly model?: string;
}

/**
 * What the mark of a handover in progress records: the rex session id of the hangar its window goes to, and when, in
 * milliseconds since the epoch, the mark was written or the take failed.
 */
export type HandoverMark = { readonly hangar: string; readonly at: number };

/**
 * A session whose handover is in progress. Neither of the mark's on a mark from before marks recorded them. `asked`: when
 * its take last asked for the window, absent on a mark from before takes recorded it or of a take that never asked.
 */
export type HandingOver = HeldSession & Partial<HandoverMark> & { readonly asked?: number };

/** The side a session moves away from. */
export interface SessionGiver {
	// What `cut` and `release` would give up now, with nothing done: a turn running is no refusal, since `cut` ends it.
	releasable(agent: string): Promise<HeldSession | Refused>;
	// Ends the turn the agent runs, if it runs one, cancelling any permission prompt it waits on, and answers once the turn
	// has stopped; undefined when no turn ran. A refusal closed nothing: the turn would not stop within a bounded wait, with
	// the cancel still out, or it ended by itself as the cancel went out, with nothing cut.
	cut(agent: string): Promise<Cut | Refused | undefined>;
	// Records that a handover of the agent is in progress, then ends its process: from then on this side, and the next
	// soma's, takes the agent up only when `reinstate` says so. Refuses an agent in a turn.
	release(agent: string, mark: HandoverMark): Promise<HeldSession | Refused>;
	// The mark now counts from `at`. A write that fails is logged, and leaves the time it had for the next soma.
	markedAt(agent: string, at: number): Promise<void>;
	// The window of the agent's handover in progress is about to be asked for, at `at`: recorded with the mark, for a
	// restart to count its grace period from. Throws when that does not reach the file, so that no window is asked for.
	windowAsked(agent: string, at: number): Promise<void>;
	// The other side holds the session: the handover is over, for good. A write that fails is logged, and leaves it in
	// progress for the next soma to look at.
	confirm(agent: string): Promise<void>;
	// The other side does not hold the session: the agent is this side's again, with no process. A write that fails is
	// logged, and leaves it in progress for the next soma to look at.
	reinstate(agent: string): Promise<void>;
	// Every session this side gave up for good, a soma before this one's too.
	released(): Promise<readonly HeldSession[]>;
	// Every session `reinstate` gave back and no handover took since, a soma before this one's too, with the time of the
	// mark it came off: what the human may still be owed a notice of.
	givenBack(): Promise<readonly { readonly name: string; readonly at: number }[]>;
	// Every session whose handover neither `confirm` nor `reinstate` ended, a soma before this one's too.
	handingOver(): Promise<readonly HandingOver[]>;
	// The names of the agents this side listed with no process as it was made, from the soma before it.
	dormant(): Promise<readonly string[]>;
}

/**
 * window: a window the listing reads as the agent's. loose: a block labelled with the session that the listing cannot
 * read as the agent's, placed in no window, as between a window's block being made and placed, or in a window of another
 * name. none: no block labelled with the session.
 */
export type Holding = "window" | "loose" | "none";

/** What `take` throws when nothing was asked for, or the side plainly refused it: no window can still come of it. */
export class TakeRefused extends Error {}

/** The side a session moves to. */
export interface SessionTaker {
	// The id of the session `take` opens windows in and `list` reads them from.
	readonly hangar: string;
	// That session's label, as the human sees it. Reads only; throws when this side cannot answer.
	label(): Promise<string>;
	// Why `take` would refuse now, with nothing done; undefined when it would not.
	takeable(session: HeldSession): Promise<string | undefined>;
	// Opens the session where the human can see it, and waits a bounded time for its claude to come up. Throws TakeRefused
	// when no window of this take can still open; any other error says nothing either way, as a reply that was lost. With
	// `hangar`, the window opens in that hangar or not at all: TakeRefused when rex says it does not exist. `asking` is
	// awaited right before the window is asked for, each time it is; one that throws is TakeRefused, with nothing asked.
	take(session: HeldSession, hangar?: string, asking?: () => Promise<void>): Promise<Taken>;
	// Where `hangar`, which need not be this side's own, holds the session, whether or not its claude still runs. A hangar
	// that does not exist holds nothing. Reads only; throws when this side cannot answer, which says nothing either way.
	holds(session: HeldSession, hangar: string): Promise<Holding>;
	// What `take` waits for and says, of a window `holds` found: one a `take` opened whose answer never came.
	adopt(session: HeldSession): Promise<Taken>;
}

/** The window a session went on in. */
export type Taken = { readonly window: string; readonly session: string; readonly ready: boolean };
