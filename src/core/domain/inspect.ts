import type { DispatchList } from "./dispatch.ts";

export const INSPECT_DEFAULT_LIMIT = 20;
export const INSPECT_MAX_LIMIT = 50;
const DETAIL_MAX_CHARS = 300;

/** Inclusive bounds in epoch milliseconds. */
export type Range = { readonly since?: number; readonly until?: number };

// A row whose time is unknown cannot be placed inside a range, so only an unbounded query keeps it.
export const inRange = (at: number | undefined, { since, until }: Range) =>
	at === undefined
		? since === undefined && until === undefined
		: (since === undefined || at >= since) && (until === undefined || at <= until);

export const clip = (text: string) =>
	[...text].length > DETAIL_MAX_CHARS ? `${[...text].slice(0, DETAIL_MAX_CHARS).join("")}…` : text;

export type Tokens = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly cost: number;
};

export const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };

export const addTokens = (a: Tokens, b: Tokens): Tokens => ({
	input: a.input + b.input,
	output: a.output + b.output,
	cacheRead: a.cacheRead + b.cacheRead,
	cacheWrite: a.cacheWrite + b.cacheWrite,
	totalTokens: a.totalTokens + b.totalTokens,
	cost: a.cost + b.cost,
});

/** One transcript entry in order: an input that starts a round, or an answer that spent tokens. */
export type Step =
	| { readonly type: "input"; readonly entry: number; readonly submission?: number }
	| { readonly type: "answer"; readonly entry: number; readonly at: number; readonly tokens: Tokens };

export type Round = {
	/** The input entry; absent for answers no input precedes in the conversation. */
	readonly entry?: number;
	readonly submission?: number;
	readonly at: number;
	readonly answers: number[];
	tokens: Tokens;
};

/** Groups the answers in `range` under the input before them; a round with none in range is left out. */
export function rounds(steps: readonly Step[], range: Range): Round[] {
	const found: Round[] = [];
	let input: Extract<Step, { type: "input" }> | undefined;
	let open: Round | undefined;
	for (const step of steps) {
		if (step.type === "input") {
			input = step;
			open = undefined;
		} else if (inRange(step.at, range)) {
			if (open === undefined) {
				open = {
					...(input !== undefined && { entry: input.entry }),
					...(input?.submission !== undefined && { submission: input.submission }),
					at: step.at,
					answers: [],
					tokens: NO_TOKENS,
				};
				found.push(open);
			}
			open.answers.push(step.entry);
			open.tokens = addTokens(open.tokens, step.tokens);
		}
	}
	return found;
}

export type Window<T> = { readonly total: number; readonly items: readonly T[]; readonly truncated?: string };

/** `rows` newest first; past `limit` only the newest are kept and the rest is named, not returned. */
export function window<T>(rows: readonly T[], limit: number): Window<T> {
	if (rows.length <= limit) return { total: rows.length, items: rows };
	return {
		total: rows.length,
		items: rows.slice(0, limit),
		truncated: `共 ${rows.length} 筆，只回傳最新的 ${limit} 筆；要看更早的，把 until 設成最舊一筆的時間再查。`,
	};
}

export type DecisionRow = {
	/** `<card>#<n>`: the n-th decision on the card's job, counted from 0; a job's decisions are only appended. */
	readonly id: string;
	readonly card: string;
	readonly at: string;
	readonly kind: string;
	readonly action: "answered" | "escalated";
	readonly option?: string;
	readonly reason: string;
};

export const decisionRows = (jobs: DispatchList, range: Range): DecisionRow[] =>
	jobs
		.flatMap((job) => job.decisions.map((decision, n) => ({ id: `${job.card}#${n}`, card: job.card, ...decision })))
		.filter((row) => inRange(Date.parse(row.at), range))
		.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

// Newest dispatch first; the status's screen text is left out, it can be a whole terminal.
export const jobRows = (jobs: DispatchList) =>
	[...jobs].reverse().map((job) => ({
		id: job.card,
		agent: job.agent,
		status: job.status.state,
		outcome: job.outcome ?? "未知",
		decisions: job.decisions.length,
	}));
