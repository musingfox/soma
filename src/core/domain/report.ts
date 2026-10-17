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
	readonly outcome?: Outcome;
	readonly result?: string;
	readonly decisions: readonly Decision[];
}

export interface Report {
	readonly since: string;
	readonly until: string;
	readonly jobs: readonly JobReport[];
}
