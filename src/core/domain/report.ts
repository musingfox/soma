import type { MessageClass, NoticeKind } from "../../ports/human.ts";
import { type Decision, HUMAN_CHOSEN } from "./dispatch.ts";
import { TICKET_CARD_LINE } from "./launch-prompt.ts";

// The first line of a worker's final reply: 結果：完成／需要你／失敗.
export type Outcome = "完成" | "需要你" | "失敗";

const RESULT_LINE = /^結果：(完成|需要你|失敗)$/;

/** A reply whose first line is not a result line says nothing about how the work went, which is not failure. */
export function outcomeOf(reply: string | undefined): Outcome | "未知" {
	const first = reply?.trimStart().split("\n", 1)[0]?.trim() ?? "";
	return (RESULT_LINE.exec(first)?.[1] as Outcome | undefined) ?? "未知";
}

// A human who answered or replied to a job this recently is likely still waiting on it.
export const TOUCHED_MS = 10 * 60_000;

/**
 * Whether a finished turn goes to the human at once instead of waiting for the next report: someone has to act on
 * 需要你 and 失敗, and a 完成 is awaited by a human who touched the job within TOUCHED_MS, or who asked for the ticket
 * the job writes: its reply names the card.
 */
export function urgent(
	outcome: Outcome | "未知",
	{ decisions, ticket }: { readonly decisions: readonly Decision[]; readonly ticket?: string },
	now: number,
): boolean {
	if (outcome === "需要你" || outcome === "失敗") return true;
	return (
		outcome === "完成" &&
		(ticket !== undefined ||
			decisions.some(
				(decision) =>
					(decision.action === "replied" || (decision.action === "answered" && decision.reason === HUMAN_CHOSEN)) &&
					now - Date.parse(decision.at) <= TOUCHED_MS,
			))
	);
}

export interface JobReport {
	readonly card: string;
	readonly agent: string;
	readonly outcome?: Outcome | "未知";
	readonly result?: string;
	readonly decisions: readonly Decision[];
}

export interface Report {
	readonly since: string;
	readonly until: string;
	readonly jobs: readonly JobReport[];
}

// Long enough for a result line and a few sentences of a worker's reply; the model writes a short report anyway.
const RESULT_LIMIT = 600;

export const clip = (result: string) => (result.length > RESULT_LIMIT ? `${result.slice(0, RESULT_LIMIT)}…` : result);

/**
 * The notice of a turn told to the human at once. It carries the worker's own reply, result line first, so they can
 * answer it directly; an urgent turn always has one, since its outcome was read off it.
 */
export function resultNotice(job: { card: string; agent: string }, reply: string): string {
	return `agent ${job.agent}（卡片 ${job.card}）這一輪結束了：\n${clip(reply.trim())}`;
}

/**
 * The input that wakes the model for a report. The model never sees an entry's kind, so the source is stated in the
 * text itself.
 */
export function digestPrompt(report: Report): string {
	const lines = report.jobs.map((job) => {
		const result = job.result?.trim();
		const decisions = job.decisions.map(
			(decision) => `\n  判斷（${decision.kind}，${decision.action}）：${decision.reason}`,
		);
		return (
			`- 卡片 ${job.card}（agent ${job.agent}）結果：${job.outcome ?? "未知"}` +
			(result ? `\n  回覆：${clip(result)}` : "") +
			decisions.join("")
		);
	});
	return (
		`[digest ${report.since} ~ ${report.until}] 這段時間做完的工作：\n${lines.join("\n")}\n\n` +
		"寫一份給人看的短報告，分成兩段，沒有內容的段落就不寫：\n" +
		"要你注意：\n" +
		"- 結果不是「完成」的工作，和人該回頭檢查的判斷，每件寫一行，寫出卡片和要人注意什麼。\n" +
		"僅供參考：\n" +
		"- 其他工作每件寫一行，寫出卡片和結果。\n" +
		"結果是「未知」的也要列出。每句只講一件事，句子要短。不要貼表格、整段文件或其他長篇內容。"
	);
}

// A character that would go on naming a card, so a line the summary holds only as the start of a longer name is missing.
const NAMING = /[\p{L}\p{N}_.-]/u;

/**
 * The summary with every `卡片：` line of the pushes it covers that it does not carry, appended word for word: such a line
 * names the card a ticket job's agent wrote, so the human gets the name whatever the summary's model kept.
 */
export function withCardLines(summary: string, contents: readonly string[]): string {
	const carried = (line: string) => {
		for (let at = summary.indexOf(line); at !== -1; at = summary.indexOf(line, at + 1)) {
			if (!NAMING.test(summary.charAt(at + line.length))) return true;
		}
		return false;
	};
	const lines = contents
		.flatMap((content) => content.split("\n"))
		.map((line) => line.trim())
		.filter((line) => line.startsWith(TICKET_CARD_LINE) && line.length > TICKET_CARD_LINE.length);
	const missing = [...new Set(lines)].filter((line) => !carried(line));
	if (missing.length === 0) return summary;
	return summary.trim() === "" ? missing.join("\n") : `${summary.trimEnd()}\n${missing.join("\n")}`;
}

const CLASS_LABELS: Record<MessageClass, string> = {
	action: "等人處理",
	outcome: "工作結果",
	ambient: "soma 自己做的事",
};

/**
 * The input that wakes the model for a summary of the pushes interfaces held (ARCHITECTURE.md "Whom to push to"),
 * questions first, each with its class. The model never sees an entry's kind, so the source is stated in the text.
 */
export function summaryPrompt(held: readonly { kind: NoticeKind; class: MessageClass; content: string }[]): string {
	const list = (pushes: typeof held) =>
		pushes.map((push) => `- （${CLASS_LABELS[push.class]}）${clip(push.content.trim())}`).join("\n");
	const questions = held.filter((push) => push.kind === "question");
	const rest = held.filter((push) => push.kind !== "question");
	return (
		"[summary] 人沒有在看的這段時間，先收著沒送出的訊息：\n" +
		(questions.length > 0 ? `等人回答的問題：\n${list(questions)}\n` : "") +
		(rest.length > 0 ? `其他：\n${list(rest)}\n` : "") +
		"\n寫一份給人看的摘要，分成兩段，沒有內容的段落就不寫：\n" +
		"要你決定：\n" +
		"- 每個問題寫一行，寫出是誰在問、要人決定什麼。不要寫選項、編號或畫面內容，因為每個問題在摘要之後會帶著它的選項和按鈕再送一次。\n" +
		"僅供參考：\n" +
		"- 每件事寫一行，寫出結果和要人注意的事。\n" +
		"每句只講一件事，句子要短。不要貼表格、整段文件或其他長篇內容。只寫上面列出的訊息，不要加入對話歷史裡的其他事。"
	);
}
