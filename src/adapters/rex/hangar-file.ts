import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** The session soma made in place of the configured hangar, kept across its restarts. */
export interface HangarMemory {
	/** The session last made in place of `configured`; undefined when none was. Throws when it cannot tell. */
	recall(configured: string): string | undefined;
	/** `made` is the hangar in place of `configured` from now on. Throws when it could not be kept. */
	remember(configured: string, made: string): void;
}

/**
 * The memory as one JSON file, `{ configured, hangar }`: what it holds for another configured id, as after the config
 * named a new hangar, is no answer for this one. Written to a temporary file and renamed over it, so a crash leaves the
 * old one or the new one whole.
 */
export function hangarFile(path: string): HangarMemory {
	return {
		recall(configured) {
			let text: string;
			try {
				text = readFileSync(path, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
			const kept = JSON.parse(text) as { configured?: unknown; hangar?: unknown };
			if (kept.configured !== configured) return undefined;
			if (typeof kept.hangar !== "string") throw new Error(`${path} names no hangar for ${configured}`);
			return kept.hangar;
		},
		remember(configured, made) {
			writeFileSync(`${path}.tmp`, `${JSON.stringify({ configured, hangar: made }, null, "\t")}\n`, { mode: 0o600 });
			renameSync(`${path}.tmp`, path);
		},
	};
}
