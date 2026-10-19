import type { DispatchList } from "./dispatch.ts";
import { EVIDENCE_ID, type Fact, FENCE_CLOSE, FENCE_OPEN } from "./memory.ts";
import { failureCause, SIGNAL } from "./signal.ts";

/** A card the reflection opened for a code change, with the evidence it was opened on. */
export type OpenedCard = {
	readonly card: string;
	readonly title: string;
	readonly at: number;
	readonly evidence: string[];
	readonly callId: string;
};

export const isSignal = (fact: Fact) => fact.kind.startsWith("signal.");

/**
 * The evidence ids (ARCHITECTURE.md「證據 id」) a signal points at. A reblock has no entry of its own, so it points at
 * the answer that did not take; a row written before refs carried that index points at nothing.
 */
export function evidenceOf(fact: Fact): string[] {
	const refs = fact.refs ?? {};
	if (fact.kind === SIGNAL.reblocked)
		return refs.card !== undefined && refs.decision !== undefined ? [`decision:${refs.card}#${refs.decision}`] : [];
	if (fact.kind === SIGNAL.turnFailed) return refs.submission !== undefined ? [`submission:${refs.submission}`] : [];
	return refs.entry !== undefined ? [`entry:${refs.entry}`] : [];
}

/**
 * What problem a signal is about: the dispatched card, or the cause of a round that failed. Two signals with one
 * subject are the same problem.
 */
export function subjectOf(fact: Fact): string {
	const { card } = fact.refs ?? {};
	if (card !== undefined) return `card:${card}`;
	if (fact.kind === SIGNAL.turnFailed) return `turn:${failureCause(fact)}`;
	return `${fact.kind}:${fact.key ?? fact.at}`;
}

/** The subjects some revision or opened card cites evidence of. */
export function actedOn(facts: readonly Fact[], cited: readonly string[]): Set<string> {
	const subjects = new Set<string>();
	for (const id of cited) {
		const card = /^decision:([^#\s]+)#\d+$/.exec(id)?.[1];
		if (card !== undefined) subjects.add(`card:${card}`);
		for (const fact of facts) if (isSignal(fact) && evidenceOf(fact).includes(id)) subjects.add(subjectOf(fact));
	}
	return subjects;
}

/** Signals among `fresh` whose problem no revision or opened card has acted on yet. */
export function unhandled(facts: readonly Fact[], fresh: readonly Fact[], cited: readonly string[]): Fact[] {
	const acted = actedOn(facts, cited);
	return fresh.filter((fact) => isSignal(fact) && !acted.has(subjectOf(fact)));
}

export function refuseCard(evidence: readonly string[]): string | undefined {
	if (evidence.length === 0) return "沒有開卡：evidence 是空的，卡片要附至少一個證據 id。";
	const bad = evidence.filter((id) => !EVIDENCE_ID.test(id));
	return bad.length === 0 ? undefined : `沒有開卡：這些證據 id 格式不對：${bad.join("、")}。`;
}

export interface Reflection {
	readonly since: string;
	readonly until: string;
	readonly signals: readonly Fact[];
	readonly jobs: DispatchList;
	readonly cards: readonly OpenedCard[];
	/** soma's own repository, where a code change's card goes. */
	readonly repo: string;
}

/**
 * The input that wakes the model to reflect. Signal texts are the program's, but a decision's reason is the model's
 * and an agent name comes from outside, so the whole record is fenced as observed material.
 */
export function reflectionPrompt(reflection: Reflection): string {
	const signals = reflection.signals.map((fact) => {
		const evidence = evidenceOf(fact);
		return `- ${fact.kind}（證據 ${evidence.length === 0 ? "無" : evidence.join(" ")}）：${fact.text}`;
	});
	const cards = [...new Set(reflection.signals.flatMap((fact) => fact.refs?.card ?? []))];
	const decisions = cards.flatMap((card) =>
		(reflection.jobs.find((job) => job.card === card)?.decisions ?? []).map(
			(decision, n) =>
				`- decision:${card}#${n}（${decision.kind}，${decision.action}` +
				`${decision.option === undefined ? "" : `，選項 ${decision.option}`}）：${decision.reason}`,
		),
	);
	const opened = reflection.cards.map((card) => `- ${card.card}：${card.title}`);
	const observed = [
		"新的結果訊號：",
		...signals,
		...(decisions.length === 0 ? [] : ["相關卡片的代答與轉人紀錄：", ...decisions]),
		"先前反省開過的卡：",
		...(opened.length === 0 ? ["- 沒有"] : opened),
	];
	return (
		`[reflection ${reflection.since} ~ ${reflection.until}] 每日反省：讀自己的結果訊號，改進自己的行為。\n` +
		`${FENCE_OPEN}\n${observed.join("\n")}\n${FENCE_CLOSE}\n\n` +
		"回覆分三段，標題依序是「觀察」「證據 id」「改動」：觀察寫哪個行為該改；證據 id 列出上面引用的 id；改動寫你做了什麼。\n" +
		"行為層（長期記憶、指引）的改動直接用 revise_memory、forget_memory 或 restore_memory 套用，證據帶上面的 id。\n" +
		`要改程式碼時，用 open_card 在 soma 的 repo 開一張 obw 卡（正文寫明證據），再用 dispatch（repo=${reflection.repo}）派進 fleet。` +
		"你不能合併任何東西，合併由人審查。上面開過的卡不要再開。沒有該改的就在改動寫「不改」。"
	);
}
