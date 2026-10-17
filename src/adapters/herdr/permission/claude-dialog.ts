/**
 * claude's own select dialogs: the folder trust dialog and the custom API key dialog, captured from
 * Claude Code 2.1.302 under herdr 0.9.5 (fixtures claude-trust-dialog-2.1.302.txt and
 * claude-custom-api-key-2.1.302.txt), which herdr reports as blocked.
 *
 *     ──────────────────────────────────────────      <- box top
 *      Accessing workspace:
 *      …
 *      ❯ No, exit                                      <- options, cursor on the first
 *        Yes, I trust this folder
 *
 *      Enter to confirm · Esc to cancel                <- the anchor
 *
 * The options are unnumbered, so an answer is a travel from the cursor plus Enter, and the cursor
 * starts on the refusal: on the trust dialog that is "No, exit", which ends claude. Only the two
 * dialogs named here parse; any other dialog with this footer is refused rather than offered,
 * because nobody has checked what its options do.
 */

import { createHash } from "node:crypto";
import type { ParsedPrompt, PromptKind, PromptOption } from "./prompt-parse.ts";

const ANCHOR = /Enter to confirm · Esc to cancel/;
const RULE = /^\s*─{20,}\s*$/;
const CURSOR = /^❯\s*/;
const NUMBERED = /^(\d+)\.\s+(\S.*)$/;
const MAX_LOOKBACK = 30;

const KINDS: readonly (readonly [RegExp, PromptKind])[] = [
	// Trust first: the folder path it shows may itself say "login".
	[/trust this folder|Quick safety check/i, "permission"],
	[/API key|log ?in|sign ?in|OAuth|authenticat/i, "auth"],
];

export function parseClaudeDialog(input: { text: string }): ParsedPrompt | null {
	const lines = input.text.split("\n");
	const anchor = lines.findLastIndex((line) => ANCHOR.test(line));
	if (anchor === -1) return null;
	const floor = Math.max(0, anchor - MAX_LOOKBACK);
	let top = anchor - 1;
	while (top >= floor && !RULE.test(lines[top] ?? "")) top -= 1;
	if (top < floor) return null;

	// The options are the last run of non-blank lines above the anchor; everything above them is the text.
	const region = lines.slice(top + 1, anchor).map((line) => line.trim());
	let end = region.length;
	while (end > 0 && region[end - 1] === "") end -= 1;
	let start = end;
	while (start > 0 && region[start - 1] !== "") start -= 1;
	const header = region.slice(0, start).filter((line) => line.length > 0);

	const options: PromptOption[] = [];
	let selectedIndex: number | undefined;
	for (const line of region.slice(start, end)) {
		if (CURSOR.test(line)) selectedIndex = options.length;
		const label = line.replace(CURSOR, "");
		const numbered = NUMBERED.exec(label);
		options.push(
			numbered?.[1] && numbered[2]
				? { id: numbered[1], label: numbered[2], keystroke: numbered[1] }
				: { id: String(options.length + 1), label },
		);
	}
	if (options.length === 0 || selectedIndex === undefined) return null;

	const text = header.join("\n");
	const promptKind = KINDS.find(([pattern]) => pattern.test(text))?.[1];
	if (promptKind === undefined) return null;
	const toolLabel = header[0] ?? "";
	const argumentText = header.slice(1).join("\n");
	// The cursor is left out: moving it does not make it a different dialog.
	const material = [toolLabel, argumentText, ...options.map((option) => `${option.id}. ${option.label}`)].join(
		"\u0000",
	);
	return {
		dialect: "claude",
		promptKind,
		toolLabel,
		argumentText,
		options,
		selectedIndex,
		fingerprint: createHash("sha256").update(material, "utf8").digest("hex").slice(0, 16),
	};
}
