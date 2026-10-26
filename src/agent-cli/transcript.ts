// Ported from musingfox/cc-mobile server/transcript/path.ts, reader.ts and records.ts @ d9f0690:
// the path resolution as is, the window read with node:fs in place of Bun's file API, and the record
// filter cut down to claude's own records. The final-answer read is new.
import { access, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultProjectsDir(): string {
	return join(homedir(), ".claude", "projects");
}

/** claude's forward encoding of a cwd into its project directory name; it cannot be inverted. */
export function projectDirNameFor(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * The session's JSONL file, or undefined when it is nowhere. The encoded cwd is only the fast
 * path: the rule was never checked for spaces or non-ASCII, and a cwd can drift after launch,
 * so a miss scans every project directory for `<session>.jsonl`.
 */
export async function resolveTranscriptPath(
	sessionId: string,
	cwd: string | undefined,
	projectsDir = defaultProjectsDir(),
): Promise<string | undefined> {
	const fileName = `${sessionId}.jsonl`;
	if (cwd !== undefined) {
		const encoded = join(projectsDir, projectDirNameFor(cwd), fileName);
		if (await exists(encoded)) return encoded;
	}
	let entries: string[];
	try {
		entries = await readdir(projectsDir);
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		const candidate = join(projectsDir, entry, fileName);
		if (await exists(candidate)) return candidate;
	}
	return undefined;
}

type AssistantRecord = { message: { id?: unknown; content?: unknown } };

// A sub-agent's turns, text claude injects for the user, and the post-compaction summary ride on
// user/assistant records but are not the conversation.
const SUPPRESSING_FLAGS = ["isSidechain", "isMeta", "isCompactSummary"] as const;

function asAssistant(record: unknown): AssistantRecord | undefined {
	if (typeof record !== "object" || record === null) return undefined;
	const fields = record as Record<string, unknown>;
	if (SUPPRESSING_FLAGS.some((flag) => fields[flag] === true)) return undefined;
	if (fields.type !== "assistant" || typeof fields.message !== "object" || fields.message === null) return undefined;
	return record as AssistantRecord;
}

/** Complete records in the window; a partial first line (the window began mid-record) is dropped. */
function parseWindow(bytes: Buffer, startsAtRecord: boolean): unknown[] {
	// 0x0A never occurs inside a multi-byte UTF-8 sequence, so cutting at it keeps characters whole.
	const body = startsAtRecord ? bytes : bytes.subarray(bytes.indexOf(0x0a) + 1);
	const records: unknown[] = [];
	for (const line of body.toString("utf8").split("\n")) {
		if (line.trim() === "") continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			// A half-written last line, or one malformed record: skipped, not fatal.
		}
	}
	return records;
}

/**
 * The text of the last assistant message. claude writes one record per content block, all
 * carrying the message's id, so the message is every trailing record with that id. The file is
 * read from its end in growing windows until one holds the message's first record.
 */
export async function readFinalAnswer(path: string, firstWindowBytes = 64 * 1024): Promise<string | undefined> {
	const file = await open(path, "r");
	try {
		const { size } = await file.stat();
		for (let window = firstWindowBytes; ; window *= 2) {
			const start = Math.max(0, size - window);
			const bytes = Buffer.alloc(size - start);
			await file.read(bytes, 0, bytes.length, start);
			const assistants = parseWindow(bytes, start === 0).flatMap((record) => asAssistant(record) ?? []);
			const last = assistants.at(-1);
			if (last === undefined) {
				if (start === 0) return undefined;
				continue;
			}
			const id = last.message.id;
			let first = assistants.length - 1;
			while (typeof id === "string" && first > 0 && assistants[first - 1]?.message.id === id) first--;
			// The window may have cut the message short unless an earlier message, or the file's start, bounds it.
			if (first === 0 && start > 0) continue;
			const blocks = assistants.slice(first).flatMap((record) => {
				const content = record.message.content;
				return Array.isArray(content) ? content : [];
			});
			const text = blocks
				.filter((block) => block?.type === "text" && typeof block.text === "string")
				.map((block) => block.text as string)
				.join("\n");
			return text === "" ? undefined : text;
		}
	} finally {
		await file.close();
	}
}
