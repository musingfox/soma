import type { Context } from "@earendil-works/chord/context";
import {
	AssistantEntry,
	type ConversationId,
	type Cursor,
	defineExtension,
	defineTool,
	type EntryRecord,
	type Storage,
	type SubmissionQuery,
	type SubmissionRecord,
	ToolResultEntry,
	type Tx,
	UserEntry,
} from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
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
import { JOB_DONE } from "../dispatch/bridge.ts";
import { Dispatches } from "../dispatch/index.ts";
import { Stops } from "../stop/index.ts";

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
				submission: record.id,
				evidence: `submission:${record.id}`,
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
				evidence: submission !== undefined ? `submission:${submission}` : `entry:${entry ?? round.answers[0]}`,
				...round,
				at: iso(at),
			}));
	}

	/** Per card, its JOB_DONE entry, else the result entry of the dispatch call that recorded its job. */
	async function jobEvidence(tx: Tx, conversationId: ConversationId) {
		const found = new Map<string, string>();
		const entries = await scanAll((cursor) => tx.scanEntries({ conversationId, order: "ascending" }, 200, cursor));
		for (const entry of entries) {
			if (entry.kind === JOB_DONE) {
				found.set((entry.data as { card: string }).card, `entry:${entry.id}`);
				continue;
			}
			const message = ToolResultEntry.is(entry) ? entry.model?.[0] : undefined;
			if (message?.role !== "toolResult" || message.toolName !== "dispatch") continue;
			const card = cardOf(message.content);
			if (card !== undefined && !found.has(card)) found.set(card, `entry:${entry.id}`);
		}
		return found;
	}

	const inspect = defineTool({
		name: "inspect",
		description:
			"唯讀查詢 soma 自己的執行紀錄，最新的在前。what=failures：沒有得到回答的輪次與原因；usage：每輪的 token 與成本；" +
			"decisions：代答（answered）、轉人（escalated）與轉達人的回答（replied）的紀錄與理由；jobs：每張派工卡最後的狀態與結果，不受時間範圍篩選。" +
			"每筆的 evidence 是穩定的證據 id（submission:<id>、entry:<id> 或 decision:<卡片>#<序號>），可以直接當記憶修訂的證據。超過 limit 時只回傳最新的幾筆並註明總數。",
		parameters: obj({
			what: oneOf(["failures", "usage", "decisions", "jobs"]),
			since: opt(str({ description: "ISO 8601 時間，含這一刻；不填就不設下限" })),
			until: opt(str({ description: "ISO 8601 時間，含這一刻；不填就不設上限" })),
			limit: opt(
				int({
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
				if (args.what === "decisions") return json(window(decisionRows(jobs, range), limit));
				const evidence = await api.commit((tx) => jobEvidence(tx, api.conversationId), context);
				return json(window(jobRows(jobs, evidence), limit));
			}
			if (args.what === "failures") {
				const found = await api.commit((tx) => failures(tx, range, context), context);
				// A round the human stopped is not a failure, and its aborted inputs are left out: reflection reads these rows as
				// problems. One that ended otherwise, a model error say, failed and is listed. Read after the commit, as a
				// Harness read inside it would wait for it; only stops kept (`KEPT_STOPS`) are known.
				const stopped = new Set<string>();
				for (const conversationId of new Set(
					found.flatMap((row) => (row.reason === "aborted" ? [row.conversationId] : [])),
				))
					for (const stop of (await api.snapshot(Stops, conversationId, context))?.stops ?? [])
						for (const input of stop.inputs) stopped.add(`${conversationId}:${input}`);
				const failed = found.filter(
					(row) => row.reason !== "aborted" || !stopped.has(`${row.conversationId}:${row.submission}`),
				);
				return json(
					window(
						failed.map(({ submission: _submission, ...row }) => row),
						limit,
					),
				);
			}
			return json(window(await api.commit((tx) => usage(tx, range, context), context), limit));
		},
	});

	return defineExtension({ name: "soma.inspect", tools: [inspect] });
}

// The dispatch tool's result is the job as JSON.
function cardOf(content: readonly { type: string; text?: string }[]): string | undefined {
	try {
		const job: unknown = JSON.parse(content.map((block) => block.text ?? "").join(""));
		return typeof job === "object" && job !== null && "card" in job && typeof job.card === "string"
			? job.card
			: undefined;
	} catch {
		return undefined;
	}
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
