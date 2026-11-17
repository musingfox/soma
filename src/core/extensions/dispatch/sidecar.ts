import type { Context } from "@earendil-works/chord/context";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { type Job, jobsSidecar } from "../../domain/dispatch.ts";
import { Dispatches } from "./index.ts";

/**
 * Keeps `file` at the dispatch list's projection (`jobsSidecar`): written once now, from the stored list, and again on
 * each change of what it shows. Host code like the bridges, no model call. The file is the read interface of local
 * programs (ARCHITECTURE.md "Decisions made"), so a failure to read or write it is reported to `onError` and the next
 * change writes it again; soma goes on. Returns what stops it.
 */
export async function keepJobsFile(
	harness: Pick<Harness, "watchDoc">,
	conversation: Pick<Conversation, "id" | "commit">,
	file: { read(): unknown; write(value: unknown): void },
	context: Context,
	{ onError, now = () => new Date().toISOString() }: { onError: (error: Error) => void; now?: () => string },
): Promise<() => Promise<void>> {
	// Read once, so the list exists to be watched on a first start, as the HumanPort does.
	await conversation.commit((tx) => tx.doc(Dispatches, conversation.id), context);
	const watch = await harness.watchDoc(Dispatches, conversation.id, context);
	if (watch === undefined) throw new Error("the dispatch list is missing");
	const fail = (what: string, error: unknown) =>
		onError(new Error(`jobs file ${what}: ${error instanceof Error ? error.message : String(error)}`));
	let previous: unknown;
	try {
		previous = file.read();
	} catch (error) {
		fail("not read", error);
	}
	// What was last written, as text: a change that shows nothing in the file is not written.
	let written: string | undefined;
	const keep = (value: { readonly jobs: readonly Job[] } | undefined) => {
		const next = jobsSidecar(value?.jobs ?? [], previous, now());
		const text = JSON.stringify(next);
		if (text === written) return;
		try {
			file.write(next);
			written = text;
			previous = next;
		} catch (error) {
			fail("not written", error);
		}
	};
	keep(watch.value);
	watch.start(async (call) => {
		if (call.kind === "value") keep(call.value);
	});
	return async () => {
		await watch.stop();
	};
}
