import type { AgentState } from "../../ports/agent.ts";
import type { Choices, Delivery, MessageClass, NoticeKind } from "../../ports/human.ts";
import { samePrompt, type Told } from "./foreign.ts";

/**
 * What an interface does with one class of push: `ring` sends it now with a sound, `quiet` sends it now without one,
 * `log` keeps it in the history only. `hold` comes with the `summary` preset, in milestone 2 of push-levels.
 */
export const POLICIES = ["ring", "quiet", "log"] as const;
export type Policy = (typeof POLICIES)[number];
export type PolicyTable = Readonly<Record<MessageClass, Policy>>;

/** ARCHITECTURE.md "Whom to push to": `instant` is how every interface pushed before classes existed. */
export const PRESETS = {
	instant: { action: "ring", outcome: "ring", ambient: "ring" },
	ask: { action: "ring", outcome: "log", ambient: "log" },
} as const satisfies Record<string, PolicyTable>;
export type Preset = keyof typeof PRESETS;

/** Each interface's policy table, by the entry kind it tags its inputs with; one not named is `instant`. */
export type Policies = Readonly<Record<string, PolicyTable>>;

export const policyOf = (policies: Policies, entryKind: string): PolicyTable => policies[entryKind] ?? PRESETS.instant;

/**
 * What each interface does with a push of `messageClass`, by entry kind (ARCHITECTURE.md "Whom to push to"). Each
 * interface's policy is a ceiling: at `log` it does not show the push. Only `target` rings, and only when its own
 * policy is `ring`; every other interface shows it quietly. When the target may not ring, nobody does: the ring never
 * falls to another interface. Without a target, as when there is no default interface, each one follows its policy.
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
		delivery[kind] = policy === "log" || target === undefined || kind === target ? policy : "quiet";
	}
	return delivery;
}

/** An unheeded push is pushed again to the default interface only when its policy shows that class at all. */
export const escalates = (policies: Policies, defaultTarget: string, messageClass: MessageClass): boolean =>
	policyOf(policies, defaultTarget)[messageClass] !== "log";

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

/**
 * What becomes of a pending push: dropped once the human typed anywhere after it, or once its prompt is no longer on
 * the job's screen, or, for a foreign agent, no longer the prompt told for it (`told`, by agent id, forgotten once the
 * agent is past the prompt); due once `escalateMs` passed without either.
 */
export function escalation(
	push: PendingPush,
	presence: Presence,
	jobs: readonly { readonly card: string; readonly status: AgentState }[],
	told: Told,
	now: number,
	escalateMs: number,
): "drop" | "due" | "wait" {
	if (Object.values(presence).some((at) => at > push.at)) return "drop";
	const { choices } = push;
	if (choices !== undefined) {
		const status = jobs.find((job) => job.card === choices.card)?.status;
		if (status?.state !== "blocked" || status.fingerprint !== choices.fingerprint) return "drop";
	}
	const { foreign } = push;
	if (foreign !== undefined) {
		const current = told[foreign.id];
		if (current === undefined || !samePrompt(foreign.told, current)) return "drop";
	}
	return now - push.at >= escalateMs ? "due" : "wait";
}
