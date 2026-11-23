import {
	AssistantEntry,
	type ConversationId,
	type Cursor,
	defineDoc,
	defineExtension,
	defineTool,
	type EntryRecord,
	section,
	type Tx,
	UserEntry,
} from "@earendil-works/pi-durable";
import { arr, int, num, obj, opt, str } from "@earendil-works/pi-schema";
import {
	appendModelLine,
	type Change,
	type Changed,
	type CuratedLine,
	type Fact,
	type Recalled,
	type Revision,
	recallMatches,
	renderCurated,
	renderHistory,
	renderRecall,
	renderRevision,
	restoreLine,
	reviseLine,
	type StoredLine,
} from "../../domain/memory.ts";
import { deniedSignal } from "../../domain/signal.ts";
import { homeOf } from "../../home.ts";
import { noticeEntry } from "../../notice.ts";

const RECALL_LIMIT = 20;

/**
 * The curated layer: shared by every conversation. Lines are appended, revised or forgotten; every revision keeps
 * what it replaced in `history`, in the same document so a line and its history always commit together.
 */
export const Curated = defineDoc<{ next: number; lines: StoredLine[]; history: Revision[] }>({
	kind: "soma.memory.curated",
	version: 2,
	scope: "session",
	initial: () => ({ next: 1, lines: [], history: [] }),
	checkpointWhen: () => false,
	migrate: (value) => {
		const lines = (value as { lines: CuratedLine[] }).lines.map((line, index) => ({ id: index + 1, ...line }));
		return { next: lines.length + 1, lines, history: [] };
	},
});

/** The fact layer: host code appends rows with `recordFact`; no model writes here. */
export const Facts = defineDoc<{ rows: Fact[] }>({
	kind: "soma.memory.facts",
	version: 1,
	scope: "session",
	initial: () => ({ rows: [] }),
	checkpointWhen: () => false,
});

/** A fact whose key is already recorded is not recorded again. */
export async function recordFact(tx: Tx, fact: Fact): Promise<void> {
	const facts = await tx.doc(Facts);
	if (fact.key !== undefined && facts.rows.some((row) => row.key === fact.key)) return;
	facts.rows.push(fact);
}

const text = (message: { content: string | readonly { type: string; text?: string }[] }) =>
	typeof message.content === "string"
		? message.content
		: message.content.flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("\n");

// Only what was said: tool calls and results would echo the recall query back as matches.
function said(entry: EntryRecord): Recalled[] {
	const who = UserEntry.is(entry) ? "使用者" : AssistantEntry.is(entry) ? "soma" : undefined;
	if (who === undefined) return [];
	return (entry.model ?? []).flatMap((message) =>
		message.role === "user" || message.role === "assistant"
			? [{ at: message.timestamp, who, text: text(message) }]
			: [],
	);
}

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

const remember = defineTool({
	name: "remember",
	description:
		"把一件值得長期記住的事追加到長期記憶。要改或刪既有的條目用 revise_memory、forget_memory；超過容量上限時會被拒絕，原因會回報給你。",
	parameters: obj({ text: str({ description: "要記住的一句話" }) }),
	execute: async (args, api, context) => {
		const reason = await api.commit(async (tx) => {
			const curated = await tx.doc(Curated);
			const appended = appendModelLine(curated.lines, args.text, Date.now());
			if (!appended.ok) return appended.reason;
			curated.lines.push({ id: curated.next, ...appended.line });
			curated.next += 1;
			return undefined;
		}, context);
		return { output: [{ type: "text", text: reason ?? "記住了。" }] };
	},
});

const line = num({ description: "條目編號，系統提示裡每一條前面的 [#編號]" });
const reason = str({ description: "為什麼要改：會寫進修訂紀錄並通知使用者" });
const evidence = arr(str(), {
	description:
		"至少一個證據 id，格式 entry:<id>、submission:<id>、task:<id>、document:<id>@<seq> 或 decision:<卡片>#<序號>",
});

// The revision, its history row and the human's notice share one commit: after a crash there is all of it or none.
async function applyChange(
	tx: Tx,
	conversationId: ConversationId,
	change: (lines: readonly StoredLine[], history: readonly Revision[]) => Changed,
): Promise<string> {
	const home = await homeOf(tx, conversationId);
	const curated = await tx.doc(Curated);
	const changed = change(curated.lines, curated.history);
	if (!changed.ok) return changed.reason;
	curated.lines = changed.lines;
	curated.history.push(changed.revision);
	const notice = renderRevision(changed.revision);
	await tx.appendEntry(home, noticeEntry("report", "ambient", notice));
	return `${notice}已通知使用者。`;
}

const answer = (output: string) => ({ output: [{ type: "text" as const, text: output }] });

const revise = defineTool({
	name: "revise_memory",
	description:
		"改寫長期記憶的一條。必須附理由和至少一個證據 id；沒有就會被拒絕，原因會回報給你。改過的條目算你寫的，修改前的原文會留在修訂紀錄，使用者會收到通知。",
	parameters: obj({ line, text: str({ description: "這一條的新內容" }), reason, evidence }),
	execute: async (args, api, context) => {
		const change: Change = { line: args.line, reason: args.reason, evidence: args.evidence, at: Date.now() };
		return answer(
			await api.commit(
				(tx) => applyChange(tx, api.conversationId, (lines) => reviseLine(lines, args.text, change)),
				context,
			),
		);
	},
});

const forget = defineTool({
	name: "forget_memory",
	description:
		"刪除長期記憶的一條。必須附理由和至少一個證據 id；沒有就會被拒絕。刪掉的原文會留在修訂紀錄，可以用 restore_memory 還原，使用者會收到通知。",
	parameters: obj({ line, reason, evidence }),
	execute: async (args, api, context) => {
		const change: Change = { line: args.line, reason: args.reason, evidence: args.evidence, at: Date.now() };
		return answer(
			await api.commit(
				(tx) => applyChange(tx, api.conversationId, (lines) => reviseLine(lines, null, change)),
				context,
			),
		);
	},
});

const history = defineTool({
	name: "memory_history",
	description: "列出長期記憶某一條的每一版，含修訂時間與理由，用來挑 restore_memory 要還原的版本。",
	parameters: obj({ line }),
	replay: "safe",
	execute: async (args, api, context) =>
		// Rendered inside the commit: a doc is a live proxy only valid there.
		answer(await api.commit(async (tx) => renderHistory((await tx.doc(Curated)).history, args.line), context)),
});

const restore = defineTool({
	name: "restore_memory",
	description:
		"把長期記憶的一條還原成 memory_history 列出的某一版，也能找回刪掉的條目。必須附理由和至少一個證據 id；這次還原本身也會記進修訂紀錄，使用者會收到通知。",
	parameters: obj({
		line,
		version: num({ description: "memory_history 列出的版本號" }),
		reason,
		evidence,
	}),
	execute: async (args, api, context) => {
		const change: Change = { line: args.line, reason: args.reason, evidence: args.evidence, at: Date.now() };
		return answer(
			await api.commit(
				(tx) =>
					applyChange(tx, api.conversationId, (lines, revisions) =>
						restoreLine(lines, revisions, args.version, change),
					),
				context,
			),
		);
	},
});

const recall = defineTool({
	name: "recall",
	description: "搜尋所有舊對話紀錄和事實紀錄，回傳含有查詢中每個詞的句子與時間，最新的在前。",
	parameters: obj({ query: str({ description: "以空白分隔的關鍵詞" }) }),
	replay: "safe",
	execute: async (args, api, context) => {
		const rows = await api.commit(async (tx) => {
			const conversations = await scanAll((cursor) => tx.scanConversations({}, 100, cursor));
			const found: Recalled[] = [];
			for (const conversation of conversations) {
				const entries = await scanAll((cursor) => tx.scanEntries({ conversationId: conversation.id }, 200, cursor));
				found.push(...entries.flatMap(said));
			}
			found.push(...(await tx.doc(Facts)).rows.map((fact) => ({ at: fact.at, who: fact.kind, text: fact.text })));
			return found;
		}, context);
		const matches = rows
			.filter((row) => recallMatches(row.text, args.query))
			.sort((a, b) => b.at - a.at)
			.slice(0, RECALL_LIMIT);
		return { output: [{ type: "text", text: renderRecall(args.query, matches) }] };
	},
});

const says = (entry: EntryRecord, role: "user" | "assistant") =>
	(entry.model ?? []).some((message) => message.role === role && text(message).trim() !== "");

/**
 * Walks the transcript back from the newest input, the one that denies: the answer of the round `turnsAgo` rounds
 * before it is the last assistant text before the next `turnsAgo - 1` inputs. Inputs are found by their user message,
 * not their kind, since each client submits under its own kind.
 */
async function deniedAnswer(tx: Tx, conversationId: ConversationId, turnsAgo: number) {
	let by: EntryRecord | undefined;
	let passed = 0;
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanEntries({ conversationId, order: "descending" }, 200, cursor);
		for (const entry of page.items) {
			if (says(entry, "user")) {
				if (by === undefined) by = entry;
				else passed += 1;
			} else if (by !== undefined && passed === turnsAgo - 1 && says(entry, "assistant")) {
				return { entry: entry.id, by: by.id };
			}
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return undefined;
}

const denied = defineTool({
	name: "mark_denied",
	description:
		"使用者這一輪否定了你先前的回答（說你錯了、不是這樣、沒做到）時呼叫，記一筆結果訊號供日後反省。" +
		"只記錄，不會改動任何回答。",
	parameters: obj({
		turns_ago: opt(int({ minimum: 1, description: "被否定的是往回數第幾輪的回答；上一輪是 1，預設 1" })),
	}),
	// The row is keyed by the denied answer, so a rerun after a crash finds it instead of adding another.
	replay: "safe",
	execute: async (args, api, context) => {
		const found = await api.commit(async (tx) => {
			const answer = await deniedAnswer(tx, api.conversationId, args.turns_ago ?? 1);
			if (answer !== undefined) await recordFact(tx, deniedSignal(answer.entry, answer.by, Date.now()));
			return answer;
		}, context);
		return {
			output: [{ type: "text", text: found === undefined ? "找不到那一輪的回答，沒有記錄。" : "記下了。" }],
		};
	},
});

export const memory = defineExtension({
	name: "soma.memory",
	tools: [remember, revise, forget, history, restore, recall, denied],
	sections: [
		section("memory", async (input, context) => {
			const curated = await input.read.snapshot(Curated, context);
			return curated === undefined ? undefined : renderCurated(curated.lines);
		}),
	],
});
