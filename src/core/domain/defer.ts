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
};

const iso = (ms: number) => new Date(ms).toISOString();

/** The words the agent gets at `at`: one paragraph, so an adapter that types it sends it as one message. */
export function deferredPrompt(id: string, { instruction, setAt }: Deferred): string {
	return `[soma deferred instruction ${id}] You asked soma with \`soma defer\` at ${iso(setAt)} to send you this instruction now: ${instruction}`;
}

const named = (id: string, { agent, card }: Deferred) => `Deferred instruction ${id} for agent ${agent} (card ${card})`;

/** The one notice for an agent soma could not stop once it deferred: it stays open, and its deferrals still go to it. */
export const reclaimFailedNotice = (agent: string, card: string, error: string) =>
	`soma could not stop agent ${agent} (card ${card}) after it deferred an instruction: ${error}. It may still hold its hangar slot; soma tries again only if the agent defers again, and its pending deferred instructions still go to it if it is there when they fall due.`;

/** The one notice for a deferral that ended unsent, or perhaps unsent. */
export const deferNotice = {
	gone: (id: string, item: Deferred) =>
		`${named(id, item)} was not sent: the agent was no longer listed when it fell due at ${iso(item.at)}. The instruction was: ${item.instruction}`,
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
