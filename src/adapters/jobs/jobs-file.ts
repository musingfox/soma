import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** A JSON file other programs on this machine read: what soma last wrote there. */
export interface JobsFile {
	/** The value last written; undefined when there is no file. Throws when the file cannot be read or is not JSON. */
	read(): unknown;
	/** Replaces the file with `value`. Throws when it could not be written. */
	write(value: unknown): void;
}

/**
 * The file at `path`, written to a temporary file and renamed over it, so a reader polling it sees the old value or the
 * new one whole, as with the hangar file, and with mode 0600 as the other sidecars are.
 */
export function jobsFile(path: string): JobsFile {
	return {
		read() {
			try {
				return JSON.parse(readFileSync(path, "utf8"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		},
		write(value) {
			// Node applies `mode` only to a file it creates, so a stale temporary file would keep its own mode into the
			// published one: remove it, and create the new one exclusively so the mode is always ours.
			rmSync(`${path}.tmp`, { force: true });
			writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600, flag: "wx" });
			renameSync(`${path}.tmp`, path);
		},
	};
}
