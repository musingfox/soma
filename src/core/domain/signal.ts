import type { AgentState } from "../../ports/agent.ts";
import type { Job } from "./dispatch.ts";
import type { Fact } from "./memory.ts";
import type { Outcome } from "./report.ts";

/** Fact kinds of the outcome signals: how a piece of work went, for self-inspection and reflection to read. */
export const SIGNAL = {
	reblocked: "signal.reblocked",
	dispatchFailed: "signal.dispatch_failed",
	dispatchUnknown: "signal.dispatch_unknown",
	turnFailed: "signal.turn_failed",
	denied: "signal.denied",
} as const;

// Long enough for the agent to act on an answer and stop at the same prompt again; a much later block on the
// same prompt is more likely new work than an answer that did not take.
export const REBLOCK_WINDOW_MS = 10 * 60_000;

/** An answered prompt shown again soon after: the answer did not get the agent past it. */
export function reblockSignal(job: Job, status: AgentState, seq: number, now: number): Fact | undefined {
	if (status.state !== "blocked" || status.fingerprint === undefined) return undefined;
	const index = job.decisions.findLastIndex((decision) => decision.action === "answered");
	const answered = job.decisions[index];
	if (answered?.fingerprint !== status.fingerprint || now - Date.parse(answered.at) > REBLOCK_WINDOW_MS) {
		return undefined;
	}
	return {
		at: now,
		kind: SIGNAL.reblocked,
		text: `agent ${job.agent}（卡片 ${job.card}）在 ${answered.at} 代答選項 ${answered.option} 之後，又卡在同一個提示（fingerprint=${status.fingerprint}）。`,
		key: `reblock:${job.agent}:${seq}`,
		refs: { card: job.card, agent: job.agent, seq, decision: index },
	};
}

/** A finished turn whose result line says it failed, or says nothing. */
export function dispatchSignal(
	job: Job,
	outcome: Outcome | "未知",
	seq: number,
	entry: number,
	now: number,
): Fact | undefined {
	if (outcome !== "失敗" && outcome !== "未知") return undefined;
	return {
		at: now,
		kind: outcome === "失敗" ? SIGNAL.dispatchFailed : SIGNAL.dispatchUnknown,
		text:
			outcome === "失敗"
				? `agent ${job.agent}（卡片 ${job.card}）結束時回報「結果：失敗」。`
				: `agent ${job.agent}（卡片 ${job.card}）結束時讀不到結果行。`,
		key: `dispatch:${job.agent}:${seq}`,
		refs: { entry, card: job.card, agent: job.agent, seq },
	};
}

const TURN_FAILED = " 那一輪沒有回答：";

/**
 * Why a round failed, as `turnSignal` wrote it, with what differs between two failures of one cause blanked out:
 * ids (uuids and long runs that mix letters and digits) and long numbers such as timestamps. Short numbers stay, so a
 * 401 and a 429 remain two causes.
 */
export function failureCause(fact: Fact): string {
	const at = fact.text.indexOf(TURN_FAILED);
	const reason = at === -1 ? fact.text : fact.text.slice(at + TURN_FAILED.length);
	return reason
		.toLowerCase()
		.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, "<id>")
		.replace(/\b(?=\w*\d)(?=\w*[a-z])\w{8,}\b/g, "<id>")
		.replace(/\d{5,}/g, "<n>")
		.replace(/\s+/g, " ")
		.trim();
}

/** A round that ended unanswered; `entry` is its input's, absent when it was never placed. */
export function turnSignal(
	round: { readonly submission: number; readonly requestId?: string; readonly entry?: number; readonly reason: string },
	now: number,
): Fact {
	const { submission, requestId, entry, reason } = round;
	return {
		at: now,
		kind: SIGNAL.turnFailed,
		text: `${requestId ?? `submission ${submission}`}${TURN_FAILED}${reason}`,
		key: `turn:${submission}`,
		refs: {
			submission,
			...(requestId !== undefined && { requestId }),
			...(entry !== undefined && { entry }),
		},
	};
}

/**
 * The model's judgement that the human's input `by` denied the answer `entry`. The text is the program's own, so no
 * model-written words enter the fact layer; the reason is the human's input, which `by` points at.
 */
export function deniedSignal(entry: number, by: number, now: number): Fact {
	return {
		at: now,
		kind: SIGNAL.denied,
		text: `模型判斷使用者在紀錄 ${by} 的輸入否定了紀錄 ${entry} 的回答。`,
		key: `denied:${entry}`,
		refs: { entry },
	};
}
