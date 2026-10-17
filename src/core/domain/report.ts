import type { Decision } from "./dispatch.ts";

// The first line of a worker's final reply: 結果：完成／需要你／失敗.
export type Outcome = "完成" | "需要你" | "失敗";

const RESULT_LINE = /^結果：(完成|需要你|失敗)$/;

/** A reply whose first line is not a result line says nothing about how the work went, which is not failure. */
export function outcomeOf(reply: string | undefined): Outcome | "未知" {
	const first = reply?.trimStart().split("\n", 1)[0]?.trim() ?? "";
	return (RESULT_LINE.exec(first)?.[1] as Outcome | undefined) ?? "未知";
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
			(result ? `\n  回覆：${result.length > RESULT_LIMIT ? `${result.slice(0, RESULT_LIMIT)}…` : result}` : "") +
			decisions.join("")
		);
	});
	return (
		`[digest ${report.since} ~ ${report.until}] 這段時間做完的工作：\n${lines.join("\n")}\n\n` +
		"寫一份給人看的短報告：每件工作一行，寫出卡片、結果和要人注意的事。結果是「未知」的也要列出。"
	);
}
