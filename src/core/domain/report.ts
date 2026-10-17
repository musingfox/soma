import type { Decision } from "./dispatch.ts";

// The first line of a worker's final reply: 結果：完成／需要你／失敗.
export type Outcome = "完成" | "需要你" | "失敗";

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
