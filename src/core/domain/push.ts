import type { AgentState } from "../../ports/agent.ts";
import type { Choices, MessageClass, NoticeKind } from "../../ports/human.ts";
import { samePrompt, type Told } from "./foreign.ts";

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
