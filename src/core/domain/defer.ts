import { composeHandoffPrompt } from "./launch-prompt.ts";
import { resolveAt } from "./schedule.ts";

// A date-time without an offset would be read in whichever zone soma runs in, not the one the agent meant.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * When a deferral falls, in epoch ms: an ISO 8601 date-time with an offset, or an ISO 8601 duration from `now` such as
 * `PT2M`. Throws a RangeError an agent can read for anything else.
 */
export function deferAt(at: string, now: number): number {
	if (!at.startsWith("P") && !DATE_TIME.test(at)) {
		throw new RangeError(
			`--at must be an ISO 8601 date-time with an offset, such as 2026-11-04T18:00:00+08:00, or an ISO 8601 duration, such as PT2M; got "${at}"`,
		);
	}
	return resolveAt(at, now);
}

export type Deferred = {
	readonly agent: string;
	readonly card: string;
	readonly instruction: string;
	readonly at: number;
	// When the agent asked, so the prompt can tell it which of its own requests this is.
	readonly setAt: number;
	// A hand-off's: the Claude Code session that asked, soma did not dispatch it, and the directory it ran in. `agent`
	// and `card` are then both the name of the job it becomes (`handoffName`).
	readonly session?: string;
	readonly cwd?: string;
	// A hand-off through the drop directory: the request file's name, by which the same request read again is known.
	readonly request?: string;
};

const iso = (ms: number) => new Date(ms).toISOString();

/** The words the agent gets at `at`: one paragraph, so an adapter that types it sends it as one message. */
export function deferredPrompt(id: string, { instruction, setAt }: Deferred): string {
	return `[soma deferred instruction ${id}] You asked soma with \`soma defer\` at ${iso(setAt)} to send you this instruction now: ${instruction}`;
}

/**
 * What a deferral gives its agent: a hand-off's session runs unattended as soma's job from this prompt on, so it is
 * given the launch rules first, which also make its reply open with the result line the bridge reads.
 */
export function promptOf(id: string, item: Deferred): string {
	const sentence = deferredPrompt(id, item);
	return item.session === undefined ? sentence : composeHandoffPrompt(sentence);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why a hand-off's session or directory cannot be taken, in words for the session; undefined when both can. */
export function handoffRefusal(session: string, cwd: string): string | undefined {
	if (!UUID.test(session)) return `the session "${session}" (CLAUDE_CODE_SESSION_ID) is not a UUID`;
	if (!cwd.startsWith("/")) return `the directory "${cwd}" is not an absolute path`;
	return undefined;
}

/** Why a hand-off of `session` is refused while soma's job `card` holds that session: never two writers on one transcript. */
export const heldSession = (session: string, card: string) =>
	`session ${session} is already the session of soma's job ${card}, which soma resumes and prompts itself: it takes no hand-off of it, since two claudes would then write one transcript`;

/**
 * The job name of a hand-off, decided 2026-11-23: `soma-<repo>-<hex>`, `<repo>` the base name of `root`, the session's
 * repo root or its directory outside any repo, in lower case with every run of other characters one `-` and none at
 * either end, `session` when nothing is left; `<hex>` the session id's first 4 hex digits, one more at a time while
 * `taken` says the name is another session's.
 */
export function handoffName(root: string, session: string, taken: (name: string) => boolean): string {
	const base = root.split("/").filter(Boolean).at(-1) ?? "";
	const repo =
		base
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "session";
	const hex = session.replace(/-/g, "").toLowerCase();
	for (let digits = 4; digits < hex.length; digits++) {
		const name = `soma-${repo}-${hex.slice(0, digits)}`;
		if (!taken(name)) return name;
	}
	return `soma-${repo}-${hex}`;
}

const named = (id: string, { agent, card, session, cwd }: Deferred) =>
	session === undefined
		? `Deferred instruction ${id} for agent ${agent} (card ${card})`
		: `Deferred instruction ${id} for agent ${agent} (Claude Code session ${session} in ${cwd})`;

/** What the notice of a move says of a deferral its job armed as it moved: only the human can still send it. */
export const deferCancelled = ({ at, instruction }: Deferred) =>
	` A deferred instruction it set as it moved was cancelled, since the stop it arms would have closed this window: it was due at ${iso(at)}: ${instruction}. Send it in the window yourself if it still matters.`;

/** The one notice for an agent soma could not stop once it deferred: it stays open, and its deferrals still go to it. */
export const reclaimFailedNotice = (agent: string, card: string, error: string) =>
	`soma could not stop agent ${agent} (card ${card}) after it deferred an instruction: ${error}. It may still hold its hangar slot; soma tries again only if the agent defers again, and its pending deferred instructions still go to it if it is there when they fall due.`;

/** The one notice for a deferral that ended unsent, or perhaps unsent. */
export const deferNotice = {
	// `error` is the agent side's, for a hand-off whose session it cannot resume, as one with no transcript there.
	gone: (id: string, item: Deferred, error?: string) =>
		item.session !== undefined && error !== undefined
			? `${named(id, item)} was not sent: when it fell due at ${iso(item.at)}, soma could not resume the session: ${error}. The instruction was: ${item.instruction}`
			: `${named(id, item)} was not sent: the agent was no longer listed when it fell due at ${iso(item.at)}. The instruction was: ${item.instruction}`,
	// A hand-off whose session another job of soma's holds, which it is not resumed beside: never two writers on one
	// transcript.
	taken: (id: string, item: Deferred, card: string) =>
		`${named(id, item)} was not sent: when it fell due at ${iso(item.at)}, its session was already that of soma's job ${card}, so soma did not resume it a second time: two claudes would then write one transcript. The instruction was: ${item.instruction}`,
	// A hand-off whose session a claude soma did not start still had open: soma never writes beside another process.
	open: (id: string, item: Deferred, pid: number, cwd?: string) =>
		`${named(id, item)} was not sent: when it fell due at ${iso(item.at)}, its session ${item.session} was still open in a claude soma did not start (pid ${pid}${cwd === undefined ? "" : `, in ${cwd}`}), and soma does not write into a session another process has open. The instruction was: ${item.instruction}`,
	// The agent was gone at `at`, and starting it again in its session failed.
	unresumed: (id: string, item: Deferred, error: string) =>
		`${named(id, item)} was not sent: the agent was gone when it fell due at ${iso(item.at)}, and soma could not start it again: ${error}. The instruction was: ${item.instruction}`,
	// The agent was gone at `at`, started again only if `started`, and no window of it was listed before it took the
	// instruction.
	closed: (id: string, item: Deferred, started: boolean) =>
		started
			? `${named(id, item)} was not sent: soma started the agent again when it fell due at ${iso(item.at)}, but its window closed before the instruction went out. The instruction was: ${item.instruction}`
			: `${named(id, item)} was not sent: the agent was not listed when it fell due at ${iso(item.at)}, soma did not get it started again, and no window of it was listed when soma looked again. The instruction was: ${item.instruction}`,
	unready: (id: string, item: Deferred, seconds: number, state: string, started: boolean) =>
		`${named(id, item)} was not sent: ${started ? "soma started the agent again" : "the agent was not listed"} when it fell due at ${iso(item.at)}${started ? "" : ", and soma did not get it started again; a window of it was listed later"}, but it was not ready for the instruction within ${seconds} s (it was ${state}); it is left open. The instruction was: ${item.instruction}`,
	// No listing answered from the wait for the agent to be ready until well past it: soma cannot tell where it is.
	unlisted: (id: string, item: Deferred, seconds: number, error: string) =>
		`${named(id, item)} was not sent: when it fell due at ${iso(item.at)}, soma waited ${seconds} s for the agent to be ready for it, and in the end could not list the hangar to tell: ${error}. The agent may be running; it is left as it is, and the instruction was not sent. The instruction was: ${item.instruction}`,
	// soma had committed to stopping the agent, and a crash may have kept the stop from going out.
	stopping: (id: string, item: Deferred) =>
		`${named(id, item)} was not sent: soma was stopping the agent when it fell due at ${iso(item.at)}, and cannot tell whether that stop went out, so the agent may still be open. The instruction was: ${item.instruction}`,
	// Without `error`, soma stopped while sending it.
	unsure: (id: string, item: Deferred, error?: string) =>
		`${named(id, item)} may not have reached the agent: ${error === undefined ? "soma stopped while sending it" : `sending it failed after it may have begun (${error})`}, and soma does not send it twice. The instruction was: ${item.instruction}`,
	failed: (id: string, item: Deferred, tries: number, error: string) =>
		`${named(id, item)} was not sent after ${tries} tries: ${error}. The instruction was: ${item.instruction}`,
};
