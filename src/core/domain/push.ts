import type { AgentState } from "../../ports/agent.ts";
import { type Choices, type Delivery, MESSAGE_CLASSES, type MessageClass, type NoticeKind } from "../../ports/human.ts";
import { samePrompt, type Told } from "./foreign.ts";

/**
 * What an interface does with one class of push: `ring` sends it now with a sound, `quiet` sends it now without one,
 * `hold` keeps it for that interface's next summary, `log` keeps it in the history only.
 */
export const POLICIES = ["ring", "quiet", "hold", "log"] as const;
export type Policy = (typeof POLICIES)[number];
export type PolicyTable = Readonly<Record<MessageClass, Policy>>;

/**
 * ARCHITECTURE.md "Whom to push to": `instant` is how every interface pushed before classes existed; `summary` holds
 * every class, `action` included, as a real do-not-disturb.
 */
export const PRESETS = {
	instant: { action: "ring", outcome: "ring", ambient: "ring" },
	ask: { action: "ring", outcome: "log", ambient: "log" },
	summary: { action: "hold", outcome: "hold", ambient: "hold" },
} as const satisfies Record<string, PolicyTable>;
export type Preset = keyof typeof PRESETS;

/** Each interface's policy table, by the entry kind it tags its inputs with; one not named is `instant`. */
export type Policies = Readonly<Record<string, PolicyTable>>;

export const policyOf = (policies: Policies, entryKind: string): PolicyTable => policies[entryKind] ?? PRESETS.instant;

/**
 * What each interface does with a push of `messageClass`, by entry kind (ARCHITECTURE.md "Whom to push to"). Each
 * interface's policy is a ceiling: at `log` it does not show the push, nor at `hold`, which keeps it for a summary
 * instead (`holders`). Only `target` rings, and only when its own policy is `ring`; every other interface shows it
 * quietly. When the target may not ring, nobody does: the ring never falls to another interface. Without a target, as
 * when there is no default interface, each one follows its policy.
 */
export function deliveries(
	policies: Policies,
	messageClass: MessageClass,
	target: string | undefined,
): Record<string, Delivery> {
	const kinds = new Set([...Object.keys(policies), ...(target === undefined ? [] : [target])]);
	const delivery: Record<string, Delivery> = {};
	for (const kind of kinds) {
		const policy = policyOf(policies, kind)[messageClass];
		const shown = policy === "hold" ? "log" : policy;
		delivery[kind] = shown === "log" || target === undefined || kind === target ? shown : "quiet";
	}
	return delivery;
}

/** The interfaces, by entry kind, that keep a push of `messageClass` for their next summary instead of showing it. */
export const holders = (policies: Policies, messageClass: MessageClass): string[] =>
	Object.keys(policies).filter((kind) => policyOf(policies, kind)[messageClass] === "hold");

/** Whether any interface holds any class, which is when held pushes and summaries exist at all. */
export const holdsAny = (policies: Policies): boolean =>
	MESSAGE_CLASSES.some((messageClass) => holders(policies, messageClass).length > 0);

/**
 * An unheeded push is pushed again to the default interface only when its policy shows that class at all, now: one it
 * holds shows up in its next summary instead.
 */
export const escalates = (policies: Policies, defaultTarget: string, messageClass: MessageClass): boolean => {
	const policy = policyOf(policies, defaultTarget)[messageClass];
	return policy !== "log" && policy !== "hold";
};

/** When the human last typed on each interface, in ms, by the entry kind the interface tags its inputs with. */
export type Presence = Record<string, number>;

/** A question or a failure pushed to an interface other than the default one, to be pushed there too if unheeded. */
export type PendingPush = {
	/** The notice entry or the failed submission it came from, so the same one is never kept twice. */
	readonly key: string;
	readonly at: number;
	readonly kind: NoticeKind;
	/** Absent only on one kept before pushes had classes. */
	readonly class?: MessageClass;
	readonly content: string;
	readonly choices?: Choices;
	/** The foreign agent and the prompt this question told the human of, as `ForeignPrompts` keeps it. */
	readonly foreign?: { readonly id: string; readonly told: Told[string] };
};

/** The interface the human typed on last within `windowMs`, else `fallback` (ARCHITECTURE.md "Whom to push to"). */
export function pushTarget(presence: Presence, now: number, windowMs: number, fallback: string): string {
	let latest: { kind: string; at: number } | undefined;
	for (const [kind, at] of Object.entries(presence)) {
		if (now - at <= windowMs && (latest === undefined || at > latest.at)) latest = { kind, at };
	}
	return latest?.kind ?? fallback;
}

type Jobs = readonly { readonly card: string; readonly status: AgentState }[];

/**
 * Whether the prompt a question tells of is gone: no longer on the job's screen, or, for a foreign agent, no longer the
 * prompt told for it (`told`, by agent id, forgotten once the agent is past the prompt).
 */
export function promptGone(push: Pick<PendingPush, "choices" | "foreign">, jobs: Jobs, told: Told): boolean {
	const { choices } = push;
	if (choices !== undefined) {
		const status = jobs.find((job) => job.card === choices.card)?.status;
		if (status?.state !== "blocked" || status.fingerprint !== choices.fingerprint) return true;
	}
	const { foreign } = push;
	if (foreign !== undefined) {
		const current = told[foreign.id];
		if (current === undefined || !samePrompt(foreign.told, current)) return true;
	}
	return false;
}

/**
 * What becomes of a pending push: dropped once the human typed anywhere after it, or once its prompt is gone
 * (`promptGone`); due once `escalateMs` passed without either.
 */
export function escalation(
	push: PendingPush,
	presence: Presence,
	jobs: Jobs,
	told: Told,
	now: number,
	escalateMs: number,
): "drop" | "due" | "wait" {
	if (Object.values(presence).some((at) => at > push.at)) return "drop";
	if (promptGone(push, jobs, told)) return "drop";
	return now - push.at >= escalateMs ? "due" : "wait";
}

/** A push some interfaces hold, kept with everything its summary and its re-sent question need. */
export type HeldPush = Omit<PendingPush, "class"> & {
	readonly class: MessageClass;
	/** The entry kinds of the interfaces holding it. */
	readonly to: string[];
};

/**
 * A summary is due once something is held and `idleMs` passed since the latest of the oldest held push, the human's
 * last input on any interface and the last summary attempt, sent or failed (`tried`): at most one summary every
 * `idleMs`. The oldest push counts so that pushes close together, after a long time away, go into one summary instead
 * of each being summarized alone (card summary-waits-for-oldest-held).
 */
export const summaryDue = (
	held: readonly HeldPush[],
	presence: Presence,
	tried: number | undefined,
	now: number,
	idleMs: number,
): boolean =>
	held.length > 0 &&
	[Math.min(...held.map((push) => push.at)), ...Object.values(presence), ...(tried === undefined ? [] : [tried])].every(
		(at) => now - at >= idleMs,
	);

/** A summary rings unless one already rang since the human last typed: at most once per idle stretch. */
export const summaryRings = (presence: Presence, rang: number | undefined): boolean =>
	rang === undefined || Object.values(presence).some((at) => at > rang);
