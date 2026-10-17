// Ported from earendil-works/pi packages/tui/src/program-status.ts (commit c268154); adds `id` and `title`.
/**
 * Program Status Protocol (OSC 7501): a program tells the terminal whether it is idle, working,
 * blocked on the user, done, or failed.
 *
 * Spec: https://www.superlogical.com/rex/docs/build/program-status
 */

export interface ProgramStatus {
	/** `clear` removes the status instead of reporting one. */
	state: "idle" | "working" | "blocked" | "done" | "error" | "clear";
	/** Record path, `segment("/" segment)*`; absent addresses the root record. Must satisfy {@link isRecordId}. */
	id?: string;
	/** Stable program name, `[A-Za-z0-9_.+-]{1,32}`. Other values are omitted. */
	app?: string;
	/** What a blocked program waits for. Omitted for other states. */
	kind?: "permission" | "question" | "auth";
	/** Short label of the record. Control characters become spaces; longer text is cut to the spec limit. */
	title?: string;
	/** One human-readable line. Control characters become spaces; longer text is cut to the spec limit. */
	message?: string;
}

/** Feature detection query. A supporting terminal replies with the same body. */
export const PROGRAM_STATUS_QUERY = "\x1b]7501;?\x1b\\";

/** The reply to {@link PROGRAM_STATUS_QUERY}. Later spec revisions may add pairs after the `?`. */
export function isProgramStatusReply(sequence: string): boolean {
	const prefix = "\x1b]7501;?";
	const terminator = sequence.endsWith("\x07") ? "\x07" : sequence.endsWith("\x1b\\") ? "\x1b\\" : undefined;
	if (terminator === undefined || !sequence.startsWith(prefix)) return false;
	const pairs = sequence.slice(prefix.length, -terminator.length);
	return !pairs.includes("\x07") && !pairs.includes("\x1b");
}

const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
/** Decoded `msg` limit. Its base64 encoding stays under the 2732-byte encoded limit. */
const MAX_MESSAGE_BYTES = 2048;
/** Decoded `title` limit. Its base64 encoding stays under the 256-byte encoded limit. */
const MAX_TITLE_BYTES = 192;

/** `id` grammar and limits: at most 128 bytes, 8 segments, 32 bytes each. */
export function isRecordId(id: string): boolean {
	const segments = id.split("/");
	return id.length <= 128 && segments.length <= 8 && segments.every((segment) => SEGMENT_PATTERN.test(segment));
}

/** U+0000–U+001F and U+007F–U+009F, the characters the spec forbids in decoded text. */
export function isControlCharacter(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += char.length;
	}
	return text.slice(0, end);
}

function encodeText(text: string | undefined, maxBytes: number): string | undefined {
	let spaced = "";
	for (const char of text ?? "") {
		if (!isControlCharacter(char)) spaced += char;
		else if (!spaced.endsWith("\u0000")) spaced += "\u0000";
	}
	const line = truncateUtf8(spaced.replaceAll("\u0000", " ").trim(), maxBytes);
	return line ? Buffer.from(line, "utf8").toString("base64") : undefined;
}

/**
 * Encode a status report. Terminals discard reports whose text contains control characters, so they are replaced.
 * An invalid `id` throws: terminals ignore such reports, and dropping the id would overwrite the root record instead.
 */
export function formatProgramStatus(status: ProgramStatus): string {
	if (status.id !== undefined && !isRecordId(status.id)) throw new Error(`invalid OSC 7501 record id: ${status.id}`);
	const pairs = [`state=${status.state}`];
	if (status.id !== undefined) pairs.push(`id=${status.id}`);
	if (status.app !== undefined && APP_PATTERN.test(status.app)) pairs.push(`app=${status.app}`);
	if (status.state === "blocked" && status.kind) pairs.push(`kind=${status.kind}`);
	const title = encodeText(status.title, MAX_TITLE_BYTES);
	if (title) pairs.push(`title=${title}`);
	const message = encodeText(status.message, MAX_MESSAGE_BYTES);
	if (message) pairs.push(`msg=${message}`);
	return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}
