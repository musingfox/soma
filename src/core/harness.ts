import type { Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, type Extension, Harness, type HarnessOptions, type Storage } from "@earendil-works/pi-durable";
// Published 1.3.0 still ships the node:sqlite driver here; pi c268154 moves it to
// @earendil-works/chord/sqlite/node, which no released chord exports yet.
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export const openStorage = (path: string): Promise<Storage> => openNodeSqliteStorage(path);

/** `storage` is a path, or storage opened with `openStorage` that an extension also reads. */
export async function openHarness(
	storage: string | Storage,
	extensions: readonly Extension[],
	context: Context,
	overrides: Partial<Pick<HarnessOptions, "models" | "now">> = {},
): Promise<Harness> {
	const registry = createRegistry();
	for (const extension of extensions) registry.install(extension);
	return Harness.open(
		typeof storage === "string" ? await openStorage(storage) : storage,
		{ models: createModels(), registry, ...overrides },
		context,
	);
}
