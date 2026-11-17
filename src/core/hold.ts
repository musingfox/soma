import type { Context } from "@earendil-works/chord/context";
import {
	type Conversation,
	defineDoc,
	type EntryId,
	type EntryRecord,
	type Harness,
	type Storage,
	type SubmissionId,
	type SubmissionRecord,
	type Tx,
} from "@earendil-works/pi-durable";
import { type Delivery, MESSAGE_CLASSES, PUSHED_ANSWERS, PUSHED_FAILURES } from "../ports/human.ts";
import type { Told } from "./domain/foreign.ts";
import {
	type HeldPush,
	holders,
	type Policies,
	type Presence,
	promptGone,
	summaryDue,
	summaryRings,
} from "./domain/push.ts";
import { summaryPrompt, withCardLines } from "./domain/report.ts";
import { saidQuestions } from "./extensions/ask/index.ts";
import { ForeignPrompts } from "./extensions/dispatch/foreign.ts";
import { Dispatches } from "./extensions/dispatch/index.ts";
import { noticeEntry } from "./notice.ts";

/** A push as an interface would hold it, before it is keyed, timed and given its holders. */
export type Push = Omit<HeldPush, "key" | "at" | "to">;

type Settled = Extract<SubmissionRecord, { type: "input"; status: "done" | "unanswered" }>;

type HoldState = {
	held: HeldPush[];
	/** The last notice entry handled: one past it that a crash left unhandled is held at the next start. */
	entry?: number;
	/**
	 * The pushed rounds handled at or past `floor`, below which every one is. Rounds settle in no order of their ids, so
	 * one id cannot say which were handled.
	 */
	rounds?: { floor: number; handled: number[] };
	/** When the last summary that rang went out. */
	rang?: number;
	/** When the last summary attempt ended, sent or failed; the next waits the idle time from it. */
	tried?: number;
	/** The summary under way: its input, admitted in the commit that pinned the pushes it covers. */
	round?: { requestId: string; submission: number; keys: string[] };
	/** Summaries begun so far, which numbers each one's requestId. */
	begun?: number;
};

/** The pushes interfaces hold for their next summary (ARCHITECTURE.md "Whom to push to"). */
export const Holds = defineDoc<HoldState>({
	kind: "soma.hold",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ held: [] }),
	checkpointWhen: () => false,
});

/** A round whose failure or answer may be pushed, so its settling must be handled. */
const pushable = (record: SubmissionRecord) =>
	record.type === "input" &&
	record.requestId !== undefined &&
	[...PUSHED_FAILURES, ...PUSHED_ANSWERS].some((source) => record.requestId?.startsWith(source));

const settled = (record: SubmissionRecord): record is Settled =>
	record.type === "input" && (record.status === "done" || record.status === "unanswered");

export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const textOf = (entry: EntryRecord) =>
	(entry.model ?? [])
		.flatMap((message) => (message.role === "assistant" ? message.content : []))
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("");

export interface HoldOptions {
	readonly root: Conversation;
	readonly context: Context;
	readonly policies: Policies;
	readonly now: () => number;
	/** The Harness's own storage, read for rounds a crash left unhandled; without it only notices are caught up. */
	readonly storage?: Pick<Storage, "scanSubmissions">;
	/** The push a notice entry makes, if it is one the policies decide on. */
	readonly ofEntry: (entry: EntryRecord) => Push | undefined;
	/** The push a settled round makes, if any. */
	readonly ofRound: (record: Settled, tx: Tx) => Promise<Push | undefined>;
}

/**
 * Keeps each push in the doc for the interfaces that hold its class, once (ARCHITECTURE.md "Whom to push to"). Every
 * notice entry handled moves `entry` past it in the commit that holds it, and every pushed round is marked handled in
 * the commit that holds it; `catchUp`, run before any commit is handled, holds what a crash left between a push's own
 * commit and that one. So no held push is lost or held twice, as if it were written with the push itself.
 */
export function holding({ root, context, policies, now, storage, ofEntry, ofRound }: HoldOptions) {
	const hold = (doc: HoldState, key: string, push: Push) => {
		const to = holders(policies, push.class);
		if (to.length > 0 && !doc.held.some((each) => each.key === key)) doc.held.push({ key, at: now(), ...push, to });
	};

	/** The lowest pushed round not settled yet, else the next id: every pushed round below it is settled. */
	async function floorOf(storage: Pick<Storage, "scanSubmissions">, latest: number) {
		let floor = latest + 1;
		for (const status of ["queued", "placed"] as const) {
			let cursor: Awaited<ReturnType<Storage["scanSubmissions"]>>["next"];
			do {
				const page = await storage.scanSubmissions({ conversationId: root.id, status }, 200, cursor, context);
				for (const record of page.items) if (pushable(record)) floor = Math.min(floor, record.id);
				cursor = page.next;
			} while (cursor !== undefined);
		}
		return floor;
	}

	async function catchUpRounds(tx: Tx, doc: HoldState, storage: Pick<Storage, "scanSubmissions">) {
		const handled = new Set(doc.rounds?.handled);
		let latest = 0;
		let cursor: Awaited<ReturnType<Storage["scanSubmissions"]>>["next"];
		scan: do {
			const page = await storage.scanSubmissions(
				{ conversationId: root.id, order: "descending" },
				200,
				cursor,
				context,
			);
			for (const record of page.items) {
				latest = Math.max(latest, record.id);
				if (doc.rounds === undefined || record.id < doc.rounds.floor) break scan;
				if (!pushable(record) || !settled(record) || handled.has(record.id)) continue;
				const push = await ofRound(record, tx);
				if (push !== undefined) hold(doc, roundKey(record), push);
				handled.add(record.id);
			}
			cursor = page.next;
		} while (cursor !== undefined);
		const floor = await floorOf(storage, latest);
		doc.rounds = { floor, handled: [...handled].filter((id) => id >= floor).sort((a, b) => a - b) };
	}

	return {
		/** Holds the pushes a crash left unheld; a doc that never held starts at the latest entry and round. */
		async catchUp() {
			await root.commit(async (tx) => {
				const doc = await tx.doc(Holds, root.id);
				if (doc.entry === undefined) {
					doc.entry = (await tx.scanEntries({ conversationId: root.id }, 1)).items[0]?.id ?? 0;
				} else {
					let cursor: Awaited<ReturnType<Tx["scanEntries"]>>["next"];
					do {
						const page = await tx.scanEntries(
							{ conversationId: root.id, order: "ascending", minEntryId: (doc.entry + 1) as EntryId },
							200,
							cursor,
						);
						for (const entry of page.items) {
							const push = ofEntry(entry);
							if (push !== undefined) hold(doc, noticeKey(entry.id), push);
							doc.entry = entry.id;
						}
						cursor = page.next;
					} while (cursor !== undefined);
				}
				if (storage !== undefined) await catchUpRounds(tx, doc, storage);
			}, context);
		},
		/** Handles a notice entry: held for the interfaces holding its class, unless handled before. */
		async notice(id: EntryId, push: Push | undefined) {
			await root.commit(async (tx) => {
				const doc = await tx.doc(Holds, root.id);
				if (doc.entry !== undefined && id <= doc.entry) return;
				doc.entry = id;
				if (push !== undefined) hold(doc, noticeKey(id), push);
			}, context);
		},
		/** Handles a settled pushed round: held for the interfaces holding its class, unless handled before. */
		async round(record: Settled, push: Push) {
			await root.commit(async (tx) => {
				const doc = await tx.doc(Holds, root.id);
				const { rounds } = doc;
				if (rounds !== undefined && (record.id < rounds.floor || rounds.handled.includes(record.id))) return;
				rounds?.handled.push(record.id);
				hold(doc, roundKey(record), push);
			}, context);
		},
	};
}

export const noticeKey = (id: EntryId) => `notice:${id}`;
const roundKey = (record: { id: SubmissionId; status: string }) =>
	`${record.status === "done" ? "answer" : "failure"}:${record.id}`;

/** Forgets where holding was, so a later start with an interface at `hold` holds nothing from before it. */
export async function forgetHolding(root: Conversation, context: Context) {
	await root.commit(async (tx) => {
		const doc = await tx.doc(Holds, root.id);
		delete doc.entry;
		delete doc.rounds;
	}, context);
}

/** Entry kind of the input that wakes the model for a summary. */
export const SUMMARY = "soma.summary";

export interface SummaryOptions {
	readonly harness: Harness;
	readonly root: Conversation;
	readonly context: Context;
	readonly policies: Policies;
	readonly now: () => number;
	/** When the human last typed on each interface. */
	readonly presence: () => Presence;
	/** How long the human types nowhere before what is held is summarized. */
	readonly idleMs: number;
}

const delivered = (entry: ReturnType<typeof noticeEntry>, delivery: Record<string, Delivery>) => ({
	kind: entry.kind,
	data: { ...entry.data, delivery },
});

/**
 * The summary of what interfaces hold (ARCHITECTURE.md "Whom to push to"). Once everything held is past the wait, the
 * held questions whose prompt is gone leave the doc, and they do not count towards what is due: the summary waits for
 * the rest. Once that is due, one commit pins it and admits the input that asks the model for the summary, so a restart
 * waits on the same round. When the round answers, one commit writes the summary, with each `卡片：` line of what it
 * covers that the model left out (`withCardLines`), ringing on the interfaces holding
 * what it covers unless one rang since the human last typed, sends each question still waiting there again with its
 * buttons and no sound, and stops holding what it covered. A round that fails keeps everything held. Either way the
 * end of the attempt is kept, and the next summary waits the idle time from it.
 */
export function summaries({ harness, root, context, policies, now, presence, idleMs }: SummaryOptions) {
	const prompts = async (tx: Tx) => ({
		jobs: copy((await tx.doc(Dispatches, root.id)).jobs),
		told: copy((await tx.doc(ForeignPrompts, root.id)).told) as Told,
		said: await saidQuestions(tx, root.id),
	});

	const pin = () =>
		root.commit(async (tx) => {
			const doc = await tx.doc(Holds, root.id);
			if (doc.round !== undefined) return copy(doc.round);
			const held = copy(doc.held);
			if (!summaryDue(held, presence(), doc.tried, now(), idleMs)) return undefined;
			const { jobs, told, said } = await prompts(tx);
			const live = held.filter((push) => !promptGone(push, jobs, told, said));
			if (live.length !== held.length) doc.held = live;
			if (!summaryDue(live, presence(), doc.tried, now(), idleMs)) return undefined;
			const begun = (doc.begun ?? 0) + 1;
			const requestId = `summary:${begun}`;
			const keys = live.map((push) => push.key);
			const submission = await root.submit(tx, {
				type: "input",
				content: summaryPrompt(live),
				entry: { kind: SUMMARY, data: { keys } },
				requestId,
				whenBusy: "followUp",
			});
			doc.begun = begun;
			doc.round = { requestId, submission, keys };
			return copy(doc.round);
		}, context);

	const send = (round: NonNullable<HoldState["round"]>, summary: string) =>
		root.commit(async (tx) => {
			const doc = await tx.doc(Holds, root.id);
			if (doc.round?.requestId !== round.requestId) return;
			const covered = copy(doc.held).filter((push) => round.keys.includes(push.key));
			const to = [...new Set(covered.flatMap((push) => push.to))];
			const kinds = [...new Set([...Object.keys(policies), ...to])];
			const only = (shown: readonly string[], how: Delivery) =>
				Object.fromEntries(kinds.map((kind) => [kind, shown.includes(kind) ? how : "log"]));
			const rings = summaryRings(presence(), doc.rang);
			const messageClass = MESSAGE_CLASSES.find((each) => covered.some((push) => push.class === each)) ?? "ambient";
			// A ticket's card name reaches the human by code, not by the model copying it.
			const content = withCardLines(
				summary,
				covered.map((push) => push.content),
			);
			await tx.appendEntry(
				root.id,
				delivered(noticeEntry("report", messageClass, content), only(to, rings ? "ring" : "quiet")),
			);
			const { jobs, told, said } = await prompts(tx);
			for (const push of covered) {
				if (push.kind !== "question" || promptGone(push, jobs, told, said)) continue;
				const question = noticeEntry("question", push.class, push.content, push.choices, push.foreign);
				await tx.appendEntry(root.id, delivered(question, only(push.to, "quiet")));
			}
			doc.held = copy(doc.held).filter((push) => !round.keys.includes(push.key));
			delete doc.round;
			doc.tried = now();
			if (rings) doc.rang = now();
		}, context);

	let running = false;
	return {
		/** Summarizes what is held once that is due, or finishes a summary a restart cut short. */
		async check() {
			if (running) return;
			running = true;
			try {
				const round = await pin();
				if (round === undefined) return;
				const settled = await (await harness.submission(round.submission as SubmissionId, context))?.wait(context);
				if (settled?.type === "input" && settled.status === "done") {
					const range = { minEntryId: settled.answer, maxEntryId: settled.answer };
					const [answer] = (await root.entries(range, 1, undefined, context)).items;
					await send(round, answer === undefined ? "" : textOf(answer));
					return;
				}
				const reason = settled?.type === "input" && settled.status === "unanswered" ? settled.reason : "no round";
				console.error(`[soma] summary ${round.requestId} failed (${reason}); what it covers stays held`);
				await root.commit(async (tx) => {
					const doc = await tx.doc(Holds, root.id);
					if (doc.round?.requestId !== round.requestId) return;
					delete doc.round;
					doc.tried = now();
				}, context);
			} catch (error) {
				console.error("[soma] summary:", error);
			} finally {
				running = false;
			}
		},
	};
}
