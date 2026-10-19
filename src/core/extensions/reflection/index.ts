import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Conversation,
	type ConversationId,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryRecord,
	type Tx,
} from "@earendil-works/pi-durable";
import type { Fact } from "../../domain/memory.ts";
import { type OpenedCard, reflectionPrompt, refuseCard, unhandled } from "../../domain/reflection.ts";
import { noticeEntry } from "../../notice.ts";
import { Dispatches } from "../dispatch/index.ts";
import { Curated, Facts } from "../memory/index.ts";

export const REFLECTION_PERIOD_MS = 24 * 60 * 60_000;
/** Entry kind of the input that wakes the model to reflect. */
export const REFLECTION = "soma.reflection";

export const reflectionRequestId = (until: number) => `reflection:${until}`;

/** The conversation's one reflection task, and the cards reflections opened. */
export const Reflections = defineDoc<{ taskId?: number; cards: OpenedCard[] }>({
	kind: "soma.reflection",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ cards: [] }),
});

type Checkpoint = {
	phase: "tick";
	since: number;
	next: number;
	// Facts rows are only appended, so an index into them marks what was already reflected on.
	cursor: number;
	// The end of the rows the reflection under way covers, pinned before its input is submitted: a signal recorded
	// between a crash and the rerun waits for the next reflection instead of being counted as covered by this one.
	upto?: number;
};

/** Signals in rows [cursor, upto) whose problem no revision and no opened card has acted on. */
async function pending(tx: Tx, conversationId: ConversationId, cursor: number, upto?: number) {
	const rows = (await tx.doc(Facts)).rows;
	const { cards } = await tx.doc(Reflections, conversationId);
	const cited = [
		...(await tx.doc(Curated)).history.flatMap((revision) => revision.evidence),
		...cards.flatMap((card) => card.evidence),
	];
	// Docs are live proxies only valid inside their commit, so what leaves it is copied out as JSON.
	const signals: Fact[] = JSON.parse(JSON.stringify(unhandled(rows, rows.slice(cursor, upto), cited)));
	return { end: upto ?? rows.length, signals, cards: JSON.parse(JSON.stringify(cards)) as OpenedCard[] };
}

const textOf = (entry: EntryRecord | undefined) =>
	(entry?.model ?? [])
		.flatMap((message) => (message.role === "assistant" ? message.content : []))
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("");

const answer = (output: string) => ({ output: [{ type: "text" as const, text: output }] });

export interface ReflectionOptions {
	/** soma's own repository: the code-change cards go to the vault project its `.obsidian.yaml` names. */
	repo: string;
	/** Creates an obw task card; false when one of that name exists. */
	createCard: (repo: string, card: string, content: { title: string; body: string }) => Promise<boolean>;
	readCard: (repo: string, card: string) => Promise<string>;
}

/**
 * A daily background reflection (ARCHITECTURE.md「反省」), run like the digest: each tick reads the outcome signals
 * recorded since the last one and drops those whose problem a memory revision or an opened card already cites; with
 * none left it only moves its checkpoint on, without the model. Otherwise it submits one input asking the model to
 * reflect, and commits the answer as a notice together with the next checkpoint.
 */
export function reflection({ repo, createCard, readCard }: ReflectionOptions) {
	const Reflection = defineTask<{ periodMs: number; since: number }, Checkpoint, null>({
		name: "soma.reflection",
		version: 1,
		initial: ({ periodMs, since }) => ({ phase: "tick", since, next: since + periodMs, cursor: 0 }),
		phases: {
			tick: async (task, runtime, context) => {
				const checkpoint = task.state.checkpoint;
				const { since, next, cursor } = checkpoint;
				await runtime.sleep(next, context);
				const advance = (reflected: number) => ({
					status: "running" as const,
					// After a long downtime, one tick covers the gap instead of one per missed period.
					checkpoint: {
						phase: "tick" as const,
						since: next,
						next: Math.max(next + task.input.periodMs, runtime.now()),
						cursor: reflected,
					},
				});

				let upto = checkpoint.upto;
				if (upto === undefined) {
					let pinned: number | undefined;
					await runtime.commit(async (tx, current) => {
						const { end, signals } = await pending(tx, current.conversationId, cursor);
						if (signals.length === 0) return advance(end);
						pinned = end;
						return { status: "running", checkpoint: { ...checkpoint, upto: end } };
					}, context);
					if (pinned === undefined) return;
					upto = pinned;
				}

				const pinnedUpto = upto;
				const window = { since: new Date(since).toISOString(), until: new Date(next).toISOString() };
				let content = "";
				await runtime.commit(async (tx, current) => {
					const { signals, cards } = await pending(tx, current.conversationId, cursor, pinnedUpto);
					const jobs = JSON.parse(JSON.stringify((await tx.doc(Dispatches, current.conversationId)).jobs));
					content = reflectionPrompt({ ...window, signals, jobs, cards, repo });
				}, context);
				const root = await runtime.conversation(runtime.conversationId, context);
				const submission = await root?.submit(
					{
						type: "input",
						content,
						whenBusy: "followUp",
						entry: { kind: REFLECTION, data: window },
						requestId: reflectionRequestId(next),
					},
					context,
				);
				const settled = await submission?.wait(context);
				const report =
					settled?.type === "input" && settled.status === "done"
						? textOf(await runtime.entry(AssistantEntry, settled.answer, context))
						: `模型沒有完成反省（${settled?.status === "unanswered" ? settled.reason : "no root conversation"}）。\n${content}`;
				await runtime.commit(async (tx, current) => {
					await tx.appendEntry(current.conversationId, noticeEntry("report", report));
					return advance(pinnedUpto);
				}, context);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});

	const openCard = defineTool({
		name: "open_card",
		description:
			"要改 soma 的程式碼時，在 soma 的 obw 專案開一張任務卡（status todo），並通知使用者。" +
			"正文要寫明問題和證據；開好之後用 dispatch 派進 fleet。同名的卡已存在就不會再開。soma 不能合併任何東西。",
		parameters: Type.Object({
			card: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", description: "卡片檔名，kebab-case，不含 .md" }),
			title: Type.String({ description: "卡片標題" }),
			body: Type.String({ description: "卡片的 Description：要改什麼、為什麼，含證據 id" }),
			evidence: Type.Array(Type.String(), {
				description: "至少一個證據 id，格式同 revise_memory",
			}),
		}),
		// A rerun after a crash finds its own card by the call id written into it, instead of refusing it as taken.
		replay: "safe",
		execute: async (args, api, context) => {
			const refused = refuseCard(args.evidence);
			if (refused !== undefined) return answer(refused);
			const recorded = await api.commit(
				async (tx) => (await tx.doc(Reflections, api.conversationId)).cards.some((card) => card.callId === api.callId),
				context,
			);
			if (recorded)
				return answer(`已開卡 ${args.card}，接著用 dispatch（card=${args.card}、repo=${repo}）派進 fleet。`);
			const mark = `由 soma 反省開立（${api.callId}）。`;
			const body = `${args.body.trim()}\n\n證據：${args.evidence.join("、")}\n\n${mark}`;
			const created =
				(await createCard(repo, args.card, { title: args.title, body })) ||
				(await readCard(repo, args.card)).includes(mark);
			if (!created) return answer(`沒有開卡：已經有一張叫 ${args.card} 的卡。`);
			const card: OpenedCard = {
				card: args.card,
				title: args.title,
				at: Date.now(),
				evidence: [...args.evidence],
				callId: api.callId,
			};
			await api.commit(async (tx) => {
				(await tx.doc(Reflections, api.conversationId)).cards.push(card);
				await tx.appendEntry(
					api.conversationId,
					noticeEntry(
						"report",
						`soma 開了一張改程式碼的卡 ${args.card}：${args.title}。證據：${args.evidence.join("、")}。` +
							"它會被派進 fleet，合併要等你或派工 session 審查。",
					),
				);
			}, context);
			return answer(`已開卡 ${args.card} 並通知使用者，接著用 dispatch（card=${args.card}、repo=${repo}）派進 fleet。`);
		},
	});

	/** Starts the conversation's reflection unless it has one. Its first tick covers every signal recorded so far. */
	async function startReflection(conversation: Conversation, periodMs: number, context: Context): Promise<void> {
		await conversation.commit(async (tx) => {
			const doc = await tx.doc(Reflections, conversation.id);
			if (doc.taskId !== undefined) return;
			doc.taskId = await tx.createTask(
				Reflection,
				{ periodMs, since: Date.now() },
				{ ownership: { kind: "conversation" }, background: true },
			);
		}, context);
	}

	return {
		extension: defineExtension({ name: "soma.reflection", tasks: [Reflection], tools: [openCard] }),
		startReflection,
	};
}
