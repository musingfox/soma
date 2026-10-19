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

const describe = (subject: string) =>
	subject.startsWith("card:")
		? `卡片 ${subject.slice("card:".length)} 的問題`
		: subject.startsWith("turn:")
			? `輪次失敗「${subject.slice("turn:".length)}」`
			: subject;

/** A memory revision or an opened card, under an id that names it once and for all. */
export type Action = { readonly id: string; readonly label: string; readonly evidence: readonly string[] };

/** A problem acted on before that shows up again: the handling may not have worked. */
export type Recurrence = { readonly subject: string; readonly actions: Action[]; readonly evidence: string[] };

function subjectsOf(facts: readonly Fact[], id: string): string[] {
	const card = /^decision:([^#\s]+)#\d+$/.exec(id)?.[1];
	const found = facts.filter((fact) => isSignal(fact) && evidenceOf(fact).includes(id)).map(subjectOf);
	return card === undefined ? found : [`card:${card}`, ...found];
}

/**
 * Splits the signals among `fresh` into problems no action cites yet, for the model, and problems acted on that
 * recur, for the human. A recurrence names only the actions not yet in `alerted`, so the human hears of each action
 * failing once; a recurrence whose actions were all alerted is left out.
 */
export function triage(
	facts: readonly Fact[],
	fresh: readonly Fact[],
	actions: readonly Action[],
	alerted: readonly string[],
): { unhandled: Fact[]; recurrences: Recurrence[] } {
	const bySubject = new Map<string, Action[]>();
	for (const action of actions)
		for (const subject of new Set(action.evidence.flatMap((id) => subjectsOf(facts, id)))) {
			bySubject.set(subject, [...(bySubject.get(subject) ?? []), action]);
		}
	const unhandled: Fact[] = [];
	const recurring = new Map<string, Recurrence>();
	for (const fact of fresh.filter(isSignal)) {
		const subject = subjectOf(fact);
		const acted = bySubject.get(subject);
		if (acted === undefined) {
			unhandled.push(fact);
			continue;
		}
		const actions = acted.filter((action) => !alerted.includes(action.id));
		if (actions.length === 0) continue;
		const seen = recurring.get(subject) ?? { subject, actions, evidence: [] };
		seen.evidence.push(...evidenceOf(fact));
		recurring.set(subject, seen);
	}
	return { unhandled, recurrences: [...recurring.values()] };
}

/** The human's notice that a problem recurs after it was acted on; no model is woken for it. */
export function renderRecurrence(recurrence: Recurrence): string {
	const evidence = recurrence.evidence.length === 0 ? "（無）" : recurrence.evidence.join("、");
	return (
		`${describe(recurrence.subject)}處理過之後又出現新的訊號，處理可能沒有奏效。` +
		`先前的處理：${recurrence.actions.map((action) => action.label).join("、")}。新訊號的證據：${evidence}。` +
		"soma 不會自動再修訂或開卡，請你看看。"
	);
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
