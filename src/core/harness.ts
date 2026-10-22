import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isChordError } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { processLock } from "@earendil-works/chord/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, type Extension, Harness, type HarnessOptions, type Storage } from "@earendil-works/pi-durable";
// Published 1.3.0 still ships the node:sqlite driver here; pi c268154 moves it to
// @earendil-works/chord/sqlite/node, which no released chord exports yet.
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export class DbLockedError extends Error {}

/** One soma per db: pi-durable does not stop a second process from writing the same SQLite file. */
export async function acquireDbLock(db: string): Promise<() => Promise<void>> {
	// The parent's real path, so /tmp and /private/tmp name one lock; the db itself may not exist yet. The parent is
	// made here because storage, which would otherwise make it, opens only after the lock.
	const absolute = resolve(db);
	mkdirSync(dirname(absolute), { recursive: true });
	const path = join(realpathSync(dirname(absolute)), basename(absolute));
	try {
		return await processLock(path);
	} catch (error) {
		if (isChordError(error) && error.reason === "locked")
			throw new DbLockedError(`another soma is already using ${path}`);
		throw error;
	}
}

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
