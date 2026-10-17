import type { Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, type Extension, Harness } from "@earendil-works/pi-durable";
// Published 1.3.0 still ships the node:sqlite driver here; pi c268154 moves it to
// @earendil-works/chord/sqlite/node, which no released chord exports yet.
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export async function openHarness(path: string, extensions: readonly Extension[], context: Context): Promise<Harness> {
	const registry = createRegistry();
	for (const extension of extensions) registry.install(extension);
	return Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry }, context);
}
