import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

type NoteMatch = { file: string; matches: { line: number; text: string }[] };

const VAULT_TIMEOUT_MS = 15_000;

/**
 * The notes of `vault` through the obsidian CLI, which needs the Obsidian app running. The CLI exits 0 on a failure
 * and prints it where the answer would be, so each answer is checked for the shape it should have.
 */
export function obsidianVault(vault: string, bin = "obsidian") {
	// execFile's default 1 MiB stdout limit would fail on a large note instead of letting the tool cut it.
	const obsidian = async (...args: string[]) =>
		(
			await run(bin, [`vault=${vault}`, ...args], {
				maxBuffer: 16 * 1024 * 1024,
				timeout: VAULT_TIMEOUT_MS,
			})
		).stdout;
	const failed = (stdout: string, what: string) => new Error(stdout.trim() || `obsidian ${what}: no answer`);
	return {
		async search(query: string, limit: number, folder?: string): Promise<NoteMatch[]> {
			const where = folder === undefined ? [] : [`path=${folder}`];
			const stdout = await obsidian("search:context", `query=${query}`, ...where, `limit=${limit}`, "format=json");
			// format=json still answers a search with no match in plain text.
			if (stdout.trim() === "No matches found.") return [];
			if (!stdout.trimStart().startsWith("[")) throw failed(stdout, "search");
			return JSON.parse(stdout) as NoteMatch[];
		},
		async read(path: string): Promise<string> {
			// `read` prints the bare note, so a note that begins with "Error:" looks like a failure; `file` tells them apart.
			const info = await obsidian("file", `path=${path}`);
			if (!info.startsWith(`path\t${path}\n`)) throw failed(info, "file");
			return obsidian("read", `path=${path}`);
		},
	};
}
