import { Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Cursor,
	defineDoc,
	defineExtension,
	defineTool,
	type EntryRecord,
	section,
	type Tx,
	UserEntry,
} from "@earendil-works/pi-durable";
import {
	appendModelLine,
	type CuratedLine,
	type Fact,
	type Recalled,
	recallMatches,
	renderCurated,
	renderRecall,
} from "../../domain/memory.ts";

const RECALL_LIMIT = 20;

/** The curated layer: shared by every conversation, appended to, never rewritten. */
export const Curated = defineDoc<{ lines: CuratedLine[] }>({
	kind: "soma.memory.curated",
	version: 1,
	scope: "session",
	initial: () => ({ lines: [] }),
});

/** The fact layer: host code appends rows with `recordFact`; no model writes here. */
export const Facts = defineDoc<{ rows: Fact[] }>({
	kind: "soma.memory.facts",
	version: 1,
	scope: "session",
	initial: () => ({ rows: [] }),
});

export async function recordFact(tx: Tx, fact: Fact): Promise<void> {
	(await tx.doc(Facts)).rows.push(fact);
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
		"把一件值得長期記住的事追加到長期記憶。只能追加，不能修改或刪除既有內容；超過容量上限時會被拒絕，原因會回報給你。",
	parameters: Type.Object({ text: Type.String({ description: "要記住的一句話" }) }),
	execute: async (args, api, context) => {
		const reason = await api.commit(async (tx) => {
			const curated = await tx.doc(Curated);
			const appended = appendModelLine(curated.lines, args.text, Date.now());
			if (!appended.ok) return appended.reason;
			curated.lines.push(appended.line);
			return undefined;
		}, context);
		return { output: [{ type: "text", text: reason ?? "記住了。" }] };
	},
});

const recall = defineTool({
	name: "recall",
	description: "搜尋所有舊對話紀錄和事實紀錄，回傳含有查詢中每個詞的句子與時間，最新的在前。",
	parameters: Type.Object({ query: Type.String({ description: "以空白分隔的關鍵詞" }) }),
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

export const memory = defineExtension({
	name: "soma.memory",
	tools: [remember, recall],
	sections: [
		section("memory", async (input, context) => {
			const curated = await input.read.snapshot(Curated, context);
			return curated === undefined ? undefined : renderCurated(curated.lines);
		}),
	],
});
