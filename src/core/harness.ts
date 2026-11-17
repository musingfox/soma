import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isChordError } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { processLock } from "@earendil-works/chord/node";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type CompactionSettings,
	createRegistry,
	type Extension,
	Harness,
	type HarnessOptions,
	type Storage,
} from "@earendil-works/pi-durable";
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

/** How far past `compactAt` a request waits for a compaction rather than letting it run in the background. */
export const COMPACT_BACKGROUND_TOKENS = 32_768;
/** pi-durable's own room for the answer, below which soma does not move the blocking threshold. */
export const COMPACT_RESERVE_TOKENS = 16_384;
/** Roughly how much recent context a compaction keeps verbatim (decided on 2026-11-18). */
export const COMPACT_KEEP_RECENT_TOKENS = 20_000;

/**
 * pi-durable's compaction for the root model: a compaction starts in the background once the context passes
 * `compactAt`, and a request waits for one once it passes `compactAt + COMPACT_BACKGROUND_TOKENS`. pi-durable counts
 * both down from the window (blocking above `contextWindow - reserveTokens`, background `backgroundTokens` below
 * that), so `reserveTokens` is what the window has beyond the blocking threshold. It is set for this model only, a
 * `modelOverrides` entry, since a reserve fitted to one window would block every request on a smaller one. Undefined,
 * so pi-durable's defaults apply, for a model the catalog does not know or a window too small for `compactAt`.
 */
export function rootCompaction(
	compactAt: number,
	model: Pick<Model<Api>, "provider" | "id" | "contextWindow"> | undefined,
): CompactionSettings | undefined {
	if (model === undefined) return undefined;
	const blocking = compactAt + COMPACT_BACKGROUND_TOKENS;
	if (blocking >= model.contextWindow - COMPACT_RESERVE_TOKENS) return undefined;
	return {
		modelOverrides: {
			[`${model.provider}/${model.id}`]: {
				reserveTokens: model.contextWindow - blocking,
				backgroundTokens: COMPACT_BACKGROUND_TOKENS,
				keepRecentTokens: COMPACT_KEEP_RECENT_TOKENS,
			},
		},
	};
}

/** `storage` is a path, or storage opened with `openStorage` that an extension also reads. */
export async function openHarness(
	storage: string | Storage,
	extensions: readonly Extension[],
	context: Context,
	overrides: Partial<Pick<HarnessOptions, "models" | "now" | "settings">> = {},
): Promise<Harness> {
	const registry = createRegistry();
	for (const extension of extensions) registry.install(extension);
	return Harness.open(
		typeof storage === "string" ? await openStorage(storage) : storage,
		{ models: createModels(), registry, ...overrides },
		context,
	);
}
