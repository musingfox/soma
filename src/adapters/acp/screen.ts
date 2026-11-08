// An ACP job has no pane, so what `screen` reads of one is its claude transcript, drawn the way claude's own screen
// draws a conversation: the user's prompts after `>`, the replies and tool calls after `●`, each tool's result after
// `⎿`, cut to its first lines as claude cuts it. Thinking is left out, as claude folds it.

type Block = {
	type?: unknown;
	text?: unknown;
	id?: unknown;
	name?: unknown;
	input?: unknown;
	tool_use_id?: unknown;
	content?: unknown;
};

// The lines of one tool result shown before the rest is counted, as claude shows a few.
const RESULT_LINES = 6;
// Where a tool call's input is cut when it has no one field that names what it does.
const INPUT_CHARS = 160;
// The fields of a tool's input that say what the call does, the first one present taken.
const NAMING_FIELDS = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"];

const blocksOf = (content: unknown): Block[] =>
	typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];

/** `text`'s lines, the first after `head` and the rest under it. */
function indented(head: string, text: string): string[] {
	const pad = " ".repeat(head.length);
	return text.split("\n").map((line, index) => `${index === 0 ? head : pad}${line}`.trimEnd());
}

function inputOf(input: unknown): string {
	if (typeof input !== "object" || input === null) return "";
	const fields = input as Record<string, unknown>;
	const naming = NAMING_FIELDS.map((field) => fields[field]).find((value) => typeof value === "string");
	const text = typeof naming === "string" ? naming : JSON.stringify(input);
	return text.length > INPUT_CHARS ? `${text.slice(0, INPUT_CHARS)}…` : text;
}

function resultOf(content: unknown): string[] {
	const text = blocksOf(content)
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n")
		.trimEnd();
	const lines = text === "" ? ["(no output)"] : text.split("\n");
	const shown = lines.slice(0, RESULT_LINES);
	if (lines.length > RESULT_LINES) shown.push(`… +${lines.length - RESULT_LINES} lines`);
	return indented("  ⎿  ", shown.join("\n"));
}

/** The conversation `records` hold, as plain text, one entry after another with a blank line between. */
export function drawTranscript(records: readonly unknown[]): string {
	const entries: string[][] = [];
	// Each tool call's entry by its id, so a result is drawn under the call it answers, as claude draws it.
	const calls = new Map<string, string[]>();
	for (const record of records) {
		const { type, message } = record as { type?: unknown; message?: { content?: unknown } };
		for (const block of blocksOf(message?.content)) {
			if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
				entries.push(indented(type === "user" ? "> " : "● ", block.text.trim()));
			} else if (block?.type === "tool_use" && typeof block.name === "string") {
				const entry = [`● ${block.name}(${inputOf(block.input)})`];
				entries.push(entry);
				if (typeof block.id === "string") calls.set(block.id, entry);
			} else if (block?.type === "tool_result") {
				const call = typeof block.tool_use_id === "string" ? calls.get(block.tool_use_id) : undefined;
				if (call === undefined) entries.push(resultOf(block.content));
				else call.push(...resultOf(block.content));
			}
		}
	}
	return entries.map((lines) => lines.join("\n")).join("\n\n");
}
