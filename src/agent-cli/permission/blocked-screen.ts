import type { BlockedKind } from "../../ports/agent.ts";
import { parseClaudeDialog } from "./claude-dialog.ts";
import { ompAnswerKeys } from "./omp-prompt.ts";
import { type ParsedPrompt, parseBlockedPrompt } from "./prompt-parse.ts";

export interface BlockedScreen {
	readonly kind: BlockedKind;
	/** Absent when no parser recognised the screen: nothing on it can be answered. */
	readonly prompt?: ParsedPrompt;
	/** What the screen asks, for whoever decides the answer. */
	readonly msg: string;
}

const RAW_TAIL_LINES = 20;

/**
 * Credential wording on a screen no parser read, such as claude's login method menu. Claiming auth
 * for a screen that is not only costs a question to the human; missing one lets the model answer it.
 */
const AUTH_WORDING = /API key|log ?in\b|sign ?in\b|OAuth|authenticat/i;

function render(prompt: ParsedPrompt): string {
	return [
		prompt.toolLabel,
		prompt.argumentText,
		prompt.description,
		...prompt.options.map((option) => `${option.id}. ${option.label}`),
	]
		.filter((part) => part !== undefined && part.length > 0)
		.join("\n");
}

/** Reads a blocked pane's `pane.read source:detection` text into the kind of block and what it asks. */
export function readBlockedScreen(text: string): BlockedScreen {
	const prompt = parseBlockedPrompt({ text }) ?? parseClaudeDialog({ text });
	if (prompt !== null) return { kind: prompt.promptKind, prompt, msg: render(prompt) };
	const tail = text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0)
		.slice(-RAW_TAIL_LINES)
		.join("\n");
	return { kind: AUTH_WORDING.test(tail) ? "auth" : "permission", msg: tail };
}

/**
 * The keys that choose `optionId` on the screen as `prompt` read it, or `undefined` when that prompt
 * offers no such option or the cursor it must travel from was not read.
 */
export function answerKeys(prompt: ParsedPrompt, optionId: string): string[] | undefined {
	const index = prompt.options.findIndex((option) => option.id === optionId);
	if (index === -1) return undefined;
	const keystroke = prompt.options[index]?.keystroke;
	return keystroke !== undefined ? [keystroke] : ompAnswerKeys(index, prompt.selectedIndex);
}
