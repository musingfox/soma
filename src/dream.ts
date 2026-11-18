import { readFile } from "node:fs/promises";
import type { Context } from "@earendil-works/chord/context";
import type { Conversation, Storage } from "@earendil-works/pi-durable";
import type { Config } from "./config.ts";
import { DAY_MS, dream } from "./core/extensions/dream/index.ts";

/**
 * The dream when the config turns it on: its extension and what starts its task. Off, nothing is installed and nothing
 * started, so it costs nothing; a dream task a db already holds stays pending meanwhile, as the reflection's does.
 */
export function dreamWiring(
	config: Pick<Config, "dream" | "language">,
	storage: Pick<Storage, "scanSubmissions">,
	readLog: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
) {
	const set = config.dream;
	if (set === undefined) return { extensions: [], start: async () => {} };
	const { log } = set;
	const dreams = dream({
		storage,
		model: { provider: "anthropic", modelId: set.model },
		periodMs: set.periodDays * DAY_MS,
		language: config.language,
		...(log !== undefined && { readLog: () => readLog(log) }),
	});
	return {
		extensions: [dreams.extension],
		start: (root: Conversation, context: Context) => dreams.startDream(root, context),
	};
}
