import type { Context } from "@earendil-works/chord/context";
import {
	type ConversationId,
	type DocumentReader,
	defineExtension,
	LiveDoc,
	type Storage,
	type SubmissionId,
	section,
} from "@earendil-works/pi-durable";

export interface InterfaceOptions {
	/** What each interface can show and cannot, in its adapter's own words, by the entry kind of its inputs. */
	readonly texts: Readonly<Record<string, string>>;
	/** The entry kinds of the interfaces on now, asked at each request. */
	readonly on: () => Iterable<string>;
}

const FROM_ONE = "這一輪的訊息來自這個介面，回答也會顯示在這裡：";
const FROM_NONE = "這一輪不是人從介面發起的；要給人看的內容會送到開著的介面，各自能顯示的如下：";
const NONE_ON = "這一輪不是人從介面發起的，現在也沒有開著的介面。";

/**
 * The entry kinds of the inputs of the round running in `conversationId`, none when no round runs; one whose record or
 * entry is not found is `undefined`. `storage` is the Harness's own: a section reads documents only, so the kinds are
 * looked up from the inputs' submissions there. A run's inputs are placed, so their records and entries are stored.
 */
export async function inputKinds(
	storage: Pick<Storage, "submission" | "entry">,
	read: Pick<DocumentReader, "snapshot">,
	conversationId: ConversationId,
	context: Context,
): Promise<(string | undefined)[]> {
	const kindOf = async (id: SubmissionId) => {
		const record = await storage.submission(id, context);
		if (record?.type !== "input" || record.entry === undefined) return undefined;
		return (await storage.entry(record.entry, context))?.entry.kind;
	};
	const run = (await read.snapshot(LiveDoc, conversationId, context))?.run;
	return Promise.all((run?.inputs ?? []).map(kindOf));
}

/**
 * Shows the model what the interface a round's input came from can show; for a round no interface started, what each
 * interface on can (`inputKinds`). The section is never omitted: one that comes back after it was gone is out of order,
 * and the prompt planner then removes and re-adds every section, where a changed text costs one small patch.
 */
export function interfaces(storage: Pick<Storage, "submission" | "entry">, { texts, on }: InterfaceOptions) {
	const textOf = (kind: string | undefined) =>
		kind !== undefined && Object.hasOwn(texts, kind) ? texts[kind] : undefined;
	const render = (head: string, shown: Iterable<string | undefined>) => {
		const lines = [...new Set(shown)].filter((text) => text !== undefined);
		return lines.length === 0 ? undefined : [head, ...lines].join("\n\n");
	};

	return defineExtension({
		name: "soma.interfaces",
		sections: [
			section("interface", async (input, context) => {
				const kinds = await inputKinds(storage, input.read, input.conversationId, context);
				return render(FROM_ONE, kinds.map(textOf)) ?? render(FROM_NONE, [...on()].map(textOf)) ?? NONE_ON;
			}),
		],
	});
}
