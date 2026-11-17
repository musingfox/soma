import {
	type ConversationId,
	defineDoc,
	defineExtension,
	type EntryId,
	hook,
	LiveDoc,
	type SubmissionId,
	ToolTask,
	type Tx,
} from "@earendil-works/pi-durable";

/**
 * A round the human stopped (`HumanPort.stop`), named by its run's first input, with the run's inputs when the stop was
 * taken. `settled` once the HumanPort handled the end of the round, or found it ended while none listened.
 */
export type Stop = { round: SubmissionId; inputs: SubmissionId[]; at: number; settled?: true };

/**
 * Settled stops kept, oldest first, so a round the human stopped is still told apart from a failure after it ended;
 * older ones are dropped, so the document does not grow with every stop. Pending ones are always kept.
 */
export const KEPT_STOPS = 200;

/**
 * The stops of a conversation, written in the commit that takes each one. `after` is the last entry of the newest
 * stopped round: a continue's run takes its `first` from the stopped run, so a round after it starts past `after`.
 */
export const Stops = defineDoc<{ stops: Stop[]; after?: EntryId }>({
	kind: "soma.stops",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ stops: [] }),
	checkpointWhen: () => false,
});

/**
 * Marks the stops of `rounds` settled, records the conversation's latest entry as their rounds' last (`after`), and drops
 * the oldest settled stops past `KEPT_STOPS`. Returns `after`.
 */
export async function settleStops(tx: Tx, conversationId: ConversationId, rounds: ReadonlySet<SubmissionId>) {
	const last = await tx.latestEntryId(conversationId);
	const doc = await tx.doc(Stops, conversationId);
	if (last !== undefined) doc.after = last;
	for (const stop of doc.stops) if (rounds.has(stop.round)) stop.settled = true;
	const settled = doc.stops.filter((stop) => stop.settled === true).map((stop) => stop.round);
	if (settled.length > KEPT_STOPS) {
		const dropped = new Set(settled.slice(0, settled.length - KEPT_STOPS));
		doc.stops = doc.stops.filter((stop) => !dropped.has(stop.round));
	}
	return doc.after;
}

// What the model reads as the result of a call the guard blocked; the round has ended by the time any request reads it.
const STOPPED = "人已經停止這一輪，這個呼叫沒有執行";

/**
 * Blocks every call the model makes in a round the human stopped, before it records intent or does any work: one made
 * after the stop was taken, which an abort landing a moment later would otherwise cut off mid-work, and one of the
 * stopped round not started yet, such as the next call of a sequential round. A nested call, one a running tool makes,
 * is that tool's work and goes on: the stop lets a running tool finish. Install it wherever `HumanPort.stop` is offered.
 */
export const stopGuard = defineExtension({
	name: "soma.stop",
	hooks: [
		hook(ToolTask, {
			beforeTool: async (call, api, context) => {
				if (call.parent !== undefined) return undefined;
				const [live, stops] = await Promise.all([
					api.snapshot(LiveDoc, api.conversationId, context),
					api.snapshot(Stops, api.conversationId, context),
				]);
				const round = live?.run?.inputs[0];
				// A settled stop's round has ended, so the running round is never one.
				const stopped = stops?.stops.some((stop) => stop.round === round);
				return round !== undefined && stopped === true ? { block: STOPPED } : undefined;
			},
		}),
	],
});
