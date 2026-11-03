import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

type NoteMatch = { file: string; matches: { line: number; text: string }[] };

const VAULT_TIMEOUT_MS = 15_000;

/**
 * The CLI turns these two-character sequences in a value into a line break and a tab, and has no escape for them
 * (`\\n` gives a backslash and a line break), so text holding them cannot be written as it is.
 */
const CLI_ESCAPES = /\\[nt]/;

function writable(text: string): string {
	if (CLI_ESCAPES.test(text)) {
		throw new Error(
			"The obsidian CLI would turn a backslash followed by n or t into a line break or a tab. Write the text without those sequences, using real line breaks, or spell them out.",
		);
	}
	return text;
}

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
		async create(path: string, content: string): Promise<void> {
			const body = writable(content);
			// `create` on an existing path makes "<name> 1.md" instead of failing, so the path is checked first, and the
			// answer names the file it made.
			const info = await obsidian("file", `path=${path}`);
			if (info.startsWith(`path\t${path}\n`)) throw new Error(`${path} exists; a note is never overwritten`);
			const made = await obsidian("create", `path=${path}`, `content=${body}`);
			if (made.trim() !== `Created: ${path}`) throw failed(made, "create");
		},
		async append(path: string, content: string, heading?: string): Promise<void> {
			const under = heading === undefined ? [] : [`heading=${writable(heading)}`];
			const done = await obsidian("append", `path=${path}`, `content=${writable(content)}`, ...under);
			if (done.trim() !== `Appended to: ${path}`) throw failed(done, "append");
		},
		async journalAppend(content: string): Promise<void> {
			const done = await obsidian("daily:append", `content=${writable(content)}`);
			// Unlike `append`, which answers "Appended to: <path>".
			if (!done.startsWith("Added to: ")) throw failed(done, "daily:append");
		},
		async journalPath(): Promise<string> {
			const path = (await obsidian("daily:path")).trim();
			if (!path.endsWith(".md")) throw failed(path, "daily:path");
			return path;
		},
	};
}
