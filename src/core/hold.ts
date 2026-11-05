import type { Context } from "@earendil-works/chord/context";
import {
	type Conversation,
	defineDoc,
	type EntryId,
	type EntryRecord,
	type Storage,
	type SubmissionId,
	type SubmissionRecord,
	type Tx,
} from "@earendil-works/pi-durable";
import { PUSHED_ANSWERS, PUSHED_FAILURES } from "../ports/human.ts";
import { type HeldPush, holders, type Policies } from "./domain/push.ts";

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
	/** The summary under way: its input, admitted in the commit that pinned the pushes it covers. */
	round?: { requestId: string; submission: number; keys: string[] };
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
