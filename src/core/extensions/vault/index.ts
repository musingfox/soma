import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { FENCE_CLOSE, FENCE_OPEN } from "../../domain/memory.ts";

export const NOTE_MAX_CHARS = 20_000;
export const SEARCH_DEFAULT_FILES = 10;
export const SEARCH_MAX_FILES = 20;
const MATCHES_PER_FILE = 5;
const MATCH_MAX_CHARS = 300;
// Denied folders are dropped after the CLI's own file limit, so it is asked for more than the model wants.
const CLI_SEARCH_FILES = 100;

export type NoteMatch = { file: string; matches: { line: number; text: string }[] };

/** The human's notes, by vault-relative path. A rejection's message is shown to the model as it is. */
export interface VaultAccess {
	/** `folder` is vault-relative; absent, the whole vault. */
	search(query: string, limit: number, folder?: string): Promise<readonly NoteMatch[]>;
	read(path: string): Promise<string>;
}

type Result = { text: string; isError: boolean };

const failure = (error: unknown): Result => ({
	text: error instanceof Error ? error.message : String(error),
	isError: true,
});

/**
 * A note may hold the fence's own markers; dropped, its text cannot end the fence and pass as soma's own words. Until
 * none is left, since dropping one can join the halves around it into another.
 */
function fenced(body: string): string {
	let text = body;
	for (let last = ""; last !== text; ) {
		last = text;
		text = text.replaceAll(FENCE_OPEN, "").replaceAll(FENCE_CLOSE, "");
	}
	return `${FENCE_OPEN}\n${text}\n${FENCE_CLOSE}`;
}

const cut = (text: string, max: number) => {
	const chars = [...text];
	return chars.length > max ? { text: chars.slice(0, max).join(""), cut: true } : { text, cut: false };
};

/** `path` relative to the vault root without `.`, `..` or empty segments; undefined when it climbs out of the vault. */
function normalize(path: string): string | undefined {
	const segments: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.pop() === undefined) return undefined;
		} else segments.push(segment);
	}
	return segments.join("/");
}

/**
 * The normal form of `path`, or why it is refused. Folders compare case-insensitively: the CLI matches paths exactly
 * today, but the check does not lean on that.
 */
function checkPath(path: string, deny: readonly string[]): { path: string } | { refused: string } {
	const normal = normalize(path);
	if (normal === undefined) return { refused: `${path} is outside the vault` };
	const lower = normal.toLowerCase();
	const folder = deny.find((each) => {
		const denied = (normalize(each) ?? each).toLowerCase();
		return lower === denied || lower.startsWith(`${denied}/`);
	});
	return folder === undefined ? { path: normal } : { refused: `${folder}/ is not open to soma` };
}

/** A note's path as `checkPath` gives it, except that an empty one is refused: the CLI reads the open note for it. */
function notePath(path: string, deny: readonly string[]): { path: string } | { refused: string } {
	const checked = checkPath(path, deny);
	return "path" in checked && checked.path === "" ? { refused: "a note path is needed" } : checked;
}

export async function readNote(access: VaultAccess, deny: readonly string[], path: string): Promise<Result> {
	const checked = notePath(path, deny);
	if ("refused" in checked) return { text: checked.refused, isError: true };
	try {
		const note = cut(await access.read(checked.path), NOTE_MAX_CHARS);
		// The path came from the vault too, so it goes inside the fence.
		const head = note.cut
			? `One note, its path first, cut at ${NOTE_MAX_CHARS} characters:`
			: "One note, its path first:";
		return { text: `${head}\n${fenced(`${checked.path}\n${note.text}`)}`, isError: false };
	} catch (error) {
		return failure(error);
	}
}

export async function searchNotes(
	access: VaultAccess,
	deny: readonly string[],
	query: string,
	folder: string | undefined,
	limit: number | undefined,
): Promise<Result> {
	const within = folder === undefined ? undefined : checkPath(folder, deny);
	if (within !== undefined && "refused" in within) return { text: within.refused, isError: true };
	let found: readonly NoteMatch[];
	try {
		found = await access.search(query, CLI_SEARCH_FILES, within?.path || undefined);
	} catch (error) {
		return failure(error);
	}
	const open = found.filter((note) => "path" in notePath(note.file, deny));
	const capped = found.length >= CLI_SEARCH_FILES;
	if (open.length === 0 && !capped) return { text: `No note matches "${query}".`, isError: false };
	const wanted = limit ?? SEARCH_DEFAULT_FILES;
	const shown = open
		.slice(0, wanted)
		.map((note) =>
			[
				note.file,
				...note.matches
					.slice(0, MATCHES_PER_FILE)
					.map((match) => `  ${match.line}: ${cut(match.text, MATCH_MAX_CHARS).text}`),
			].join("\n"),
		);
	const more = open.length > wanted || capped ? " More notes match; narrow the query to see them." : "";
	return {
		text: `Notes matching "${query}", with line numbers. Read one in full with note_read.${more}\n${fenced(shown.join("\n"))}`,
		isError: false,
	};
}

export function vaultExtension(access: VaultAccess, deny: readonly string[]) {
	const noteSearch = defineTool({
		name: "note_search",
		description:
			"Search the human's Obsidian notes for text. Returns each matching note's vault path with its matching " +
			"lines. Cite the paths you used in your answer.",
		parameters: obj({
			query: str({ description: "Text to look for; plain words, not a sentence" }),
			folder: opt(str({ description: "Search only this folder of the vault, such as journals" })),
			limit: opt(
				int({
					minimum: 1,
					maximum: SEARCH_MAX_FILES,
					description: `How many notes, ${SEARCH_DEFAULT_FILES} unless set`,
				}),
			),
		}),
		replay: "safe",
		execute: async ({ query, folder, limit }) => {
			const { text, isError } = await searchNotes(access, deny, query, folder, limit);
			return { output: [{ type: "text" as const, text }], isError };
		},
	});
	const noteRead = defineTool({
		name: "note_read",
		description: `Read one of the human's Obsidian notes in full by its vault path, as note_search lists it. Long notes are cut at ${NOTE_MAX_CHARS} characters.`,
		parameters: obj({ path: str({ description: "The note's path in the vault, such as notes/fox.md" }) }),
		replay: "safe",
		execute: async ({ path }) => {
			const { text, isError } = await readNote(access, deny, path);
			return { output: [{ type: "text" as const, text }], isError };
		},
	});
	return defineExtension({ name: "soma.vault", tools: [noteSearch, noteRead] });
}
