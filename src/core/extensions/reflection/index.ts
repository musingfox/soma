import type { Context } from "@earendil-works/chord/context";
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
import { arr, obj, str } from "@earendil-works/pi-schema";
import type { AgentPort } from "../../../ports/agent.ts";
import type { Fact } from "../../domain/memory.ts";
import {
	type Action,
	type OpenedCard,
	type Recurrence,
	reflectionPrompt,
	refuseCard,
	renderRecurrence,
	triage,
} from "../../domain/reflection.ts";
import { noticeEntry } from "../../notice.ts";
import { Dispatches, startJob } from "../dispatch/index.ts";
import { Curated, Facts } from "../memory/index.ts";

export const REFLECTION_PERIOD_MS = 24 * 60 * 60_000;
/** Entry kind of the input that wakes the model to reflect. */
export const REFLECTION = "soma.reflection";

export const reflectionRequestId = (until: number) => `reflection:${until}`;

/**
 * The conversation's one reflection task, the cards reflections opened, and the actions (`Action.id`) whose problem
 * recurred and was already reported to the human.
 */
export const Reflections = defineDoc<{ taskId?: number; cards: OpenedCard[]; alerted: string[] }>({
	kind: "soma.reflection",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ cards: [], alerted: [] }),
	checkpointWhen: () => false,
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

const ACTION = { revise: "修改", forget: "刪除", restore: "還原" } as const;

/**
 * Signals in rows [cursor, upto) split by whether a memory revision or an opened card already acted on their problem.
 * Docs are live proxies only valid inside their commit, so what leaves it is copied out as JSON.
 */
async function pending(tx: Tx, conversationId: ConversationId, cursor: number, upto?: number) {
	const rows = (await tx.doc(Facts)).rows;
	const reflections = await tx.doc(Reflections, conversationId);
	const actions: Action[] = [
		...(await tx.doc(Curated)).history.map((revision, n) => ({
			id: `revision:${n}`,
			label: `長期記憶 #${revision.line} 在 ${new Date(revision.at).toISOString()} 的${ACTION[revision.action]}`,
			evidence: revision.evidence,
		})),
		...reflections.cards.map((card) => ({
			id: `opened:${card.card}`,
			label: `卡片 ${card.card}`,
			evidence: card.evidence,
		})),
	];
	const { unhandled, recurrences } = triage(rows, rows.slice(cursor, upto), actions, reflections.alerted);
	return {
		end: upto ?? rows.length,
		signals: JSON.parse(JSON.stringify(unhandled)) as Fact[],
		recurrences: JSON.parse(JSON.stringify(recurrences)) as Recurrence[],
		cards: JSON.parse(JSON.stringify(reflections.cards)) as OpenedCard[],
	};
}

const textOf = (entry: EntryRecord | undefined) =>
	(entry?.model ?? [])
		.flatMap((message) => (message.role === "assistant" ? message.content : []))
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("");

const answer = (output: string) => ({ output: [{ type: "text" as const, text: output }] });

/** The human's notice and the model's tool result for a card once its dispatch was tried. */
function outcome({ card, title, evidence, dispatch }: OpenedCard) {
	const head = `soma 開了一張改程式碼的卡 ${card}：${title}。證據：${evidence.join("、")}。`;
	if (dispatch === "started") {
		return {
			notice: `${head}已派進 fleet（agent ${card}），合併要等你或派工 session 審查。`,
			result: `已開卡 ${card} 並派進 fleet（agent ${card}），也通知了使用者。`,
		};
	}
	return {
		notice: `${head}派進 fleet 失敗：${dispatch}。卡片停在 todo，要你或派工 session 處理。`,
		result: `已開卡 ${card}，但派進 fleet 失敗：${dispatch}。卡片停在 todo，已通知使用者；不要再開同一張卡。`,
	};
}

export interface ReflectionOptions {
	/** soma's own repository: the code-change cards go to the vault project its `.obsidian.yaml` names. */
	repo: string;
	/** Creates an obw task card; false when one of that name exists. */
	createCard: (repo: string, card: string, content: { title: string; body: string }) => Promise<boolean>;
	readCard: (repo: string, card: string) => Promise<string>;
	/** Where a code-change card is dispatched. */
	agents: AgentPort;
}

/**
 * A daily background reflection (ARCHITECTURE.md "Reflection"), run like the digest: each tick reads the outcome signals
 * recorded since the last one. A problem a memory revision or an opened card already acted on that shows up again is
 * not the model's to handle twice: the program tells the human, once per action. With nothing else left the tick only
 * moves its checkpoint on, without the model. Otherwise it submits one input asking the model to reflect, and commits
 * the answer as a notice together with the next checkpoint.
 */
export function reflection({ repo, createCard, readCard, agents }: ReflectionOptions) {
	const Reflection = defineTask<{ periodMs: number; since: number }, Checkpoint, null>({
		name: "soma.reflection",
		version: 1,
		initial: ({ periodMs, since }) => ({ phase: "tick", since, next: since + periodMs, cursor: 0 }),
		phases: {
			tick: async (task, runtime, context) => {
				const checkpoint = task.state.checkpoint;
				const { since, next, cursor } = checkpoint;
				if (runtime.now() < next) return runtime.sleepUntil(next, checkpoint, context);
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
						const { end, signals, recurrences } = await pending(tx, current.conversationId, cursor);
						// A recurring problem goes to the human from the program, in the commit that moves past its signals.
						const { alerted } = await tx.doc(Reflections, current.conversationId);
						for (const recurrence of recurrences) {
							await tx.appendEntry(
								current.conversationId,
								noticeEntry("report", "ambient", renderRecurrence(recurrence)),
							);
							alerted.push(...recurrence.actions.map((action) => action.id));
						}
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
					content = reflectionPrompt({ ...window, signals, jobs, cards });
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
					await tx.appendEntry(current.conversationId, noticeEntry("report", "ambient", report));
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
			"Reflection's tool only: when a reflection finds that soma's own code must change, open a todo task card in " +
			"soma's obw project, dispatch it into fleet and tell the human. The body states the problem and its evidence. " +
			"A card of the same name is not opened again. soma merges nothing. Never for a ticket the human asks for: " +
			"that goes to dispatch with ticket set to their request, and the human is never asked for evidence ids.",
		parameters: obj({
			card: str({ pattern: "^[a-z0-9][a-z0-9-]*$", description: "卡片檔名，kebab-case，不含 .md" }),
			title: str({ description: "卡片標題" }),
			body: str({ description: "卡片的 Description：要改什麼、為什麼，含證據 id" }),
			evidence: arr(str(), {
				description: "至少一個證據 id，格式同 revise_memory",
			}),
		}),
		// A rerun after a crash finds its own card by the call id written into it, instead of refusing it as taken, and
		// dispatching checks the dispatch list and the agents listed before it starts anything.
		replay: "safe",
		execute: async (args, api, context) => {
			const refused = refuseCard(args.evidence);
			if (refused !== undefined) return answer(refused);
			const find = async (tx: Tx) => {
				const found = (await tx.doc(Reflections, api.conversationId)).cards.find((card) => card.callId === api.callId);
				return found && (JSON.parse(JSON.stringify(found)) as OpenedCard);
			};
			let opened = await api.commit(find, context);
			if (opened?.dispatch !== undefined) return answer(outcome(opened).result);
			if (opened === undefined) {
				const mark = `由 soma 反省開立（${api.callId}）。`;
				const body = `${args.body.trim()}\n\n證據：${args.evidence.join("、")}\n\n${mark}`;
				const created =
					(await createCard(repo, args.card, { title: args.title, body })) ||
					(await readCard(repo, args.card)).includes(mark);
				if (!created) return answer(`沒有開卡：已經有一張叫 ${args.card} 的卡。`);
				opened = {
					card: args.card,
					title: args.title,
					at: Date.now(),
					evidence: [...args.evidence],
					callId: api.callId,
				};
				const card = opened;
				await api.commit(async (tx) => {
					(await tx.doc(Reflections, api.conversationId)).cards.push(card);
				}, context);
			}
			let dispatch = "started";
			try {
				await startJob(agents, readCard, api, { card: opened.card, repo }, context);
			} catch (error) {
				dispatch = error instanceof Error ? error.message : String(error);
			}
			const done: OpenedCard = { ...opened, dispatch };
			const { notice, result } = outcome(done);
			await api.commit(async (tx) => {
				const { cards } = await tx.doc(Reflections, api.conversationId);
				const index = cards.findIndex((card) => card.callId === api.callId);
				cards[index] = done;
				await tx.appendEntry(api.conversationId, noticeEntry("report", "ambient", notice));
			}, context);
			return answer(result);
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
