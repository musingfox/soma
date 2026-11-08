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

function isConversation(record: unknown): boolean {
	if (typeof record !== "object" || record === null) return false;
	const fields = record as Record<string, unknown>;
	if (SUPPRESSING_FLAGS.some((flag) => fields[flag] === true)) return false;
	return fields.type === "user" || fields.type === "assistant";
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

const uuidOf = (record: unknown) => (record as { uuid?: unknown }).uuid;

// What a window's reader returns when the window may have cut short what it looks for.
const GROW = Symbol("grow");

/** Reads `path` from its end in growing windows until `read` has what it looks for; `whole` says the window is the file. */
async function windowed<T>(
	path: string,
	firstWindowBytes: number,
	read: (records: unknown[], whole: boolean) => T | typeof GROW,
): Promise<T> {
	const file = await open(path, "r");
	try {
		const { size } = await file.stat();
		for (let window = firstWindowBytes; ; window *= 2) {
			const start = Math.max(0, size - window);
			const bytes = Buffer.alloc(size - start);
			await file.read(bytes, 0, bytes.length, start);
			const result = read(parseWindow(bytes, start === 0), start === 0);
			if (result !== GROW) return result;
		}
	} finally {
		await file.close();
	}
}

/**
 * Whether the reply to the last turn is still unwritten: the conversation's last record is the user's, or the
 * assistant's holding only thinking, or there is none yet. claude writes a turn's records in batches, the prompt's own
 * included, one record per content block, and can report the turn over before the last batch is out, so a reply's
 * thinking can be on disk before its text. The file is read from its end in growing windows, as an attachment can
 * outgrow the first.
 */
export async function awaitingReply(path: string, firstWindowBytes = 64 * 1024): Promise<boolean> {
	return windowed(path, firstWindowBytes, (records, whole) => {
		const last = records.findLast(isConversation) as { type?: unknown; message?: { content?: unknown } } | undefined;
		if (last !== undefined) return last.type === "user" || thinkingOnly(last.message?.content);
		return whole ? true : GROW;
	});
}

function thinkingOnly(content: unknown): boolean {
	return (
		Array.isArray(content) &&
		content.length > 0 &&
		content.every((block) => block?.type === "thinking" || block?.type === "redacted_thinking")
	);
}

/**
 * The directory the session ran in: the `cwd` claude stamps on its records, read off the first that carries an absolute
 * one. Read from the file's start in growing windows; undefined when no record names one.
 */
export async function readSessionCwd(path: string, firstWindowBytes = 64 * 1024): Promise<string | undefined> {
	const file = await open(path, "r");
	try {
		const { size } = await file.stat();
		for (let window = firstWindowBytes; ; window *= 2) {
			const bytes = Buffer.alloc(Math.min(size, window));
			await file.read(bytes, 0, bytes.length, 0);
			// A record the window cut short does not parse, and is read whole in the next.
			const cwd = parseWindow(bytes, true)
				.map((record) => (record as { cwd?: unknown }).cwd)
				.find((each): each is string => typeof each === "string" && each.startsWith("/"));
			if (cwd !== undefined || bytes.length === size) return cwd;
		}
	} finally {
		await file.close();
	}
}

/**
 * The model of the session's last reply, off the `message.model` claude stamps on its assistant records; undefined when
 * no reply names one. A sub-agent's records are left out, and so is the `<synthetic>` claude stamps on a message no
 * model wrote, as an API error's.
 */
export async function readSessionModel(path: string, firstWindowBytes = 64 * 1024): Promise<string | undefined> {
	return windowed<string | undefined>(path, firstWindowBytes, (records, whole) => {
		const model = records
			.flatMap((record) => asAssistant(record) ?? [])
			.map((record) => (record.message as { model?: unknown }).model)
			.findLast((each): each is string => typeof each === "string" && each !== "" && !each.startsWith("<"));
		return model ?? (whole ? undefined : GROW);
	});
}

/**
 * The conversation's records in the last `bytes` of the transcript, oldest first: claude's user and assistant records,
 * less the sub-agent, injected and compaction ones. A record the window cut short is left out; `whole` says the window
 * is the file. Most of a transcript's bytes are claude's other records (API requests, attachments, snapshots), so a
 * window holds far fewer conversation records than its size suggests.
 */
export async function readConversationTail(
	path: string,
	bytes = 64 * 1024,
): Promise<{ records: unknown[]; whole: boolean }> {
	const file = await open(path, "r");
	try {
		const { size } = await file.stat();
		const start = Math.max(0, size - bytes);
		const window = Buffer.alloc(size - start);
		await file.read(window, 0, window.length, start);
		return { records: parseWindow(window, start === 0).filter(isConversation), whole: start === 0 };
	} finally {
		await file.close();
	}
}

/** The text of the last assistant message; undefined when it has none. */
export async function readFinalAnswer(path: string, firstWindowBytes = 64 * 1024): Promise<string | undefined> {
	return (await windowed(path, firstWindowBytes, lastMessage))?.text || undefined;
}

/**
 * What names a finished turn: `id` is the `uuid` of the conversation's last record that carries one, whoever wrote
 * it, the user's prompt, a tool result or the assistant; `text` is the last assistant message's text, present only
 * when that record is the assistant's and the message has text. claude also stamps a `uuid` on the `system` and
 * `attachment` records it writes around a turn (turn_duration, stop_hook_summary), which are not the conversation:
 * one written after the turn was read must not read as a new turn. Undefined when no record carries a `uuid`.
 */
export async function readLastRecord(
	path: string,
	firstWindowBytes = 64 * 1024,
): Promise<{ id: string; text?: string } | undefined> {
	return windowed(path, firstWindowBytes, (records, whole) => {
		const last = records.filter(isConversation).findLast((record) => typeof uuidOf(record) === "string");
		if (last === undefined) return whole ? undefined : GROW;
		const id = uuidOf(last) as string;
		if ((last as { type?: unknown }).type === "user") return { id };
		const message = lastMessage(records, whole);
		if (message === GROW) return GROW;
		return message?.text ? { id, text: message.text } : { id };
	});
}

/**
 * claude writes one record per content block, all carrying the message's id, so the last
 * message is every trailing record with that id. Unless an earlier message, or the file's
 * start, bounds it, the window may have cut it short.
 */
function lastMessage(records: unknown[], whole: boolean): { id: unknown; text: string } | undefined | typeof GROW {
	const assistants = records.flatMap((record) => asAssistant(record) ?? []);
	const last = assistants.at(-1);
	if (last === undefined) return whole ? undefined : GROW;
	const id = last.message.id;
	let first = assistants.length - 1;
	while (typeof id === "string" && first > 0 && assistants[first - 1]?.message.id === id) first--;
	if (first === 0 && !whole) return GROW;
	const blocks = assistants.slice(first).flatMap((record) => {
		const content = record.message.content;
		return Array.isArray(content) ? content : [];
	});
	const text = blocks
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
	return { id, text };
}
