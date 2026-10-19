import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Cursor,
	defineExtension,
	defineTool,
	type EntryRecord,
	type Storage,
	type SubmissionQuery,
	type SubmissionRecord,
	type Tx,
	UserEntry,
} from "@earendil-works/pi-durable";
import {
	clip,
	decisionRows,
	INSPECT_DEFAULT_LIMIT,
	INSPECT_MAX_LIMIT,
	inRange,
	jobRows,
	type Range,
	rounds,
	type Step,
	window,
} from "../../domain/inspect.ts";
import { Dispatches } from "../dispatch/index.ts";

async function scanAll<T>(scan: (cursor?: Cursor) => Promise<{ items: readonly T[]; next?: Cursor }>): Promise<T[]> {
	const all: T[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await scan(cursor);
		all.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return all;
}

const iso = (at: number) => new Date(at).toISOString();
const json = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });

/**
 * `storage` is the Harness's own. Neither `Tx` nor `Session` in pi-durable 1.3.0 scans submissions, so they are read
 * from it inside `api.commit`: the callback holds the Session line, so no commit is half applied, as for `Tx` reads.
 */
export function inspectExtension(storage: Pick<Storage, "scanSubmissions">) {
	const scanSubmissions = (query: SubmissionQuery, context: Context) =>
		scanAll<SubmissionRecord>((cursor) => storage.scanSubmissions(query, 100, cursor, context));

	async function failures(tx: Tx, range: Range, context: Context) {
		const rows = [];
		for (const record of await scanSubmissions({ status: "unanswered", order: "descending" }, context)) {
			if (record.type !== "input" || record.status !== "unanswered") continue;
			const at = record.entry && (await tx.entry(record.entry))?.model?.[0]?.timestamp;
			if (!inRange(at, range)) continue;
			const { detail } = record;
			rows.push({
				id: record.id,
				conversationId: record.conversationId,
				...(record.entry !== undefined && { entry: record.entry }),
				...(at !== undefined && { at: iso(at) }),
				reason: record.reason,
				...(detail !== undefined && { detail: clip(typeof detail === "string" ? detail : JSON.stringify(detail)) }),
			});
		}
		return rows;
	}

	async function usage(tx: Tx, range: Range, context: Context) {
		const found = [];
		for (const conversation of await scanAll((cursor) => tx.scanConversations({}, 100, cursor))) {
			const inputs = new Map<number, number>();
			for (const record of await scanSubmissions({ conversationId: conversation.id }, context))
				if (record.type === "input" && record.entry !== undefined) inputs.set(record.entry, record.id);
			const entries = await scanAll((cursor) =>
				tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 200, cursor),
			);
			// A fork shows its parent's entries too; they are counted once, in the conversation that wrote them.
			const steps = entries.filter((entry) => entry.conversationId === conversation.id).flatMap(step(inputs));
			found.push(...rounds(steps, range).map((round) => ({ ...round, conversationId: conversation.id })));
		}
		return found
			.sort((a, b) => b.at - a.at)
			.map(({ submission, entry, at, ...round }) => ({
				id: submission ?? entry ?? round.answers[0],
				...round,
				at: iso(at),
			}));
	}

	const inspect = defineTool({
		name: "inspect",
		description:
			"唯讀查詢 soma 自己的執行紀錄，最新的在前。what=failures：沒有得到回答的輪次與原因；usage：每輪的 token 與成本；" +
			"decisions：代答（answered）與轉人（escalated）的紀錄與理由；jobs：每張派工卡最後的狀態與結果，不受時間範圍篩選。" +
			"每筆的 id 是穩定的 submission id、entry id 或「卡片#序號」，可以當證據引用。超過 limit 時只回傳最新的幾筆並註明總數。",
		parameters: Type.Object({
			what: Type.Union([
				Type.Literal("failures"),
				Type.Literal("usage"),
				Type.Literal("decisions"),
				Type.Literal("jobs"),
			]),
			since: Type.Optional(Type.String({ description: "ISO 8601 時間，含這一刻；不填就不設下限" })),
			until: Type.Optional(Type.String({ description: "ISO 8601 時間，含這一刻；不填就不設上限" })),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: INSPECT_MAX_LIMIT,
					description: `最多回傳幾筆，預設 ${INSPECT_DEFAULT_LIMIT}`,
				}),
			),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const range: { since?: number; until?: number } = {};
			for (const bound of ["since", "until"] as const) {
				const value = args[bound];
				if (value === undefined) continue;
				const at = Date.parse(value);
				if (Number.isNaN(at)) return json({ error: `${bound} is not an ISO 8601 time: ${value}` });
				range[bound] = at;
			}
			const limit = args.limit ?? INSPECT_DEFAULT_LIMIT;
			if (args.what === "decisions" || args.what === "jobs") {
				const jobs = (await api.snapshot(Dispatches, api.conversationId, context))?.jobs ?? [];
				return json(args.what === "jobs" ? window(jobRows(jobs), limit) : window(decisionRows(jobs, range), limit));
			}
			if (args.what === "failures")
				return json(window(await api.commit((tx) => failures(tx, range, context), context), limit));
			return json(window(await api.commit((tx) => usage(tx, range, context), context), limit));
		},
	});

	return defineExtension({ name: "soma.inspect", tools: [inspect] });
}

/** An input entry starts a round; an answer spends tokens in it. */
const step =
	(inputs: ReadonlyMap<number, number>) =>
	(entry: EntryRecord): Step[] => {
		const submission = inputs.get(entry.id);
		if (submission !== undefined || UserEntry.is(entry))
			return [{ type: "input", entry: entry.id, ...(submission !== undefined && { submission }) }];
		if (!AssistantEntry.is(entry)) return [];
		return (entry.model ?? []).flatMap((message) =>
			message.role === "assistant"
				? [
						{
							type: "answer" as const,
							entry: entry.id,
							at: message.timestamp,
							tokens: {
								input: message.usage.input,
								output: message.usage.output,
								cacheRead: message.usage.cacheRead,
								cacheWrite: message.usage.cacheWrite,
								totalTokens: message.usage.totalTokens,
								cost: message.usage.cost.total,
							},
						},
					]
				: [],
		);
	};
