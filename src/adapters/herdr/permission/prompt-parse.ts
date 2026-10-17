// Ported from musingfox/cc-mobile server/herdr/permission/prompt-parse.ts @ d9f0690.
/**
 * prompt-parse.ts — BlockedPromptParse: the permission prompt drawn on the
 * terminal, turned into structured data.
 *
 * Why the screen at all: while claude is `blocked` the transcript contains
 * nothing about the pending tool call. Live wire fact (probe 2026-08-02, P4):
 * 43 s of `blocked` produced zero transcript bytes; the `assistant` record
 * carrying the `tool_use` block is gated on the permission decision, not
 * lazily flushed. So `pane.read --source detection` is the ONLY machine-readable
 * source of tool identity and arguments while a prompt is up, and every field
 * this returns is parsed screen text rather than the structured hook `input`
 * JSON the deleted PreToolUse pipeline supplied (Decision H3).
 *
 * Option wording and count are not fixed — the live capture offers three for a
 * Bash command inside the project and two elsewhere — so they are parsed, never
 * synthesised.
 */

import { createHash } from "node:crypto";
import { parseClaudeQuestion } from "./claude-question.ts";
import { parseOmpPrompt } from "./omp-prompt.ts";

export interface PromptOption {
	/** Stable within one prompt: claude's printed digit, omp's list position. */
	id: string;
	/** The terminal's own wording, verbatim. */
	label: string;
	/**
	 * The single key that chooses this option, where one exists. claude prints a
	 * digit and takes that digit. omp has none: its options are unnumbered and
	 * chosen by travelling to them, a distance that depends on where the cursor
	 * is when the answer arrives — see `ompAnswerKeys`.
	 */
	keystroke?: string;
}

/** Whose terminal drew the prompt. Decides how an answer is pressed. */
export type PromptDialect = "claude" | "omp";

/**
 * What the terminal is waiting for. A permission prompt is a gate the agent
 * needs opened; a question is an answer only the user has. They are the same
 * shape on the wire and different upstream: an unanswered permission may decay
 * to a deny, while a question has no safe default to decay to.
 */
export type PromptKind = "permission" | "question";

export interface ParsedPrompt {
	dialect: PromptDialect;
	/** Permission gate or question. Every parsed prompt says which it is. */
	promptKind: PromptKind;
	/** The prompt's title line, e.g. "Bash command" or omp's "bash". */
	toolLabel: string;
	/** The argument body, e.g. the command about to run. May be multi-line. */
	argumentText: string;
	/** claude's own one-line summary, when the prompt carries one. */
	description?: string;
	options: PromptOption[];
	/** Which option the terminal's own cursor is on, when it draws one (omp). */
	selectedIndex?: number;
	/** Hash of the parsed region only — see `fingerprintOf`. */
	fingerprint: string;
}

/**
 * The marker every permission prompt carries. herdr's own detection rules key
 * on the same string (`claude.toml` `bash_permission_prompt` /
 * `generic_permission_prompt`), so matching it here means cc-mobile and the
 * daemon agree on what a prompt is.
 *
 * Matching the marker FIRST (rather than the horizontal rule above it) is what
 * makes the first-run trust dialog parse as `null`: that dialog also draws a
 * rule and numbered options, but it asks "Quick safety check", not this. Sending
 * a digit — or worse, the unattended `esc` — at that dialog exits claude.
 */
const PROCEED_MARKER = /do you want to proceed\?/i;

/** A bare horizontal rule. Box-drawing rows inside claude's banner start with `│`. */
const RULE = /^\s*─{20,}\s*$/;

/** `❯ 1. Yes` / `   3. No` — the cursor caret is optional. */
const OPTION_LINE = /^\s*(?:[❯>]\s*)?(\d+)\.\s+(\S.*?)\s*$/;

/** How far back to look for the prompt region when no rule precedes the marker. */
const MAX_HEADER_LOOKBACK = 12;

/**
 * A hash of what the user was shown, and nothing else.
 *
 * Deliberately NOT a hash of the raw `pane.read` body: the surrounding screen
 * carries a live spinner ("✻ Brewed for 18s", "⏺ Running 1 shell command…") that
 * changes between two reads of the *same* prompt. Fingerprinting that would make
 * every answer look stale and refuse every keystroke. Only the parsed region —
 * title, arguments, description and the option labels — takes part, which is
 * exactly the set of things whose change means "this is a different question".
 */
function fingerprintOf(parts: {
	toolLabel: string;
	argumentText: string;
	description?: string;
	options: PromptOption[];
}): string {
	const material = [
		parts.toolLabel,
		parts.argumentText,
		parts.description ?? "",
		...parts.options.map((option) => `${option.id}. ${option.label}`),
	].join("\u0000");
	return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 16);
}

/**
 * Parses a `pane.read --source detection` body into the pending permission
 * request, or `null` when the screen is not a tool permission prompt.
 *
 * Never throws: a screen shape nobody anticipated must degrade to "unparseable"
 * (the caller then shows the raw tail with a Cancel action), never to a crash in
 * the event stream.
 */
export function parseBlockedPrompt(input: { text: string }): ParsedPrompt | null {
	const lines = input.text.split("\n");

	// Last marker wins: the screen is scrollback, and an older answered prompt may
	// still be visible above the live one.
	let markerIndex = -1;
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i] ?? "";
		if (PROCEED_MARKER.test(line)) {
			markerIndex = i;
			break;
		}
	}
	// Not claude's permission prompt. It may still be claude's *question* screen
	// or omp's prompt, each of which shares nothing with this one but the
	// terminal it is drawn on — so they get the same screen in turn rather than
	// this one loosening its rules to cover all three (#33). The ordering is not
	// what protects the first-run trust dialog: that screen carries no
	// `Chat about this` anchor and no `Allow tool:`, so every parser here
	// refuses it on its own. Marker-first is only the cheapest question to ask,
	// and a screen holding both a live marker and a live anchor has not been
	// observed — claude collapses an answered permission box into a one-line
	// summary (probed 2026-09-14 on v2.1.270: two answered Bash prompts, then a
	// question screen, and the marker was gone from `--source detection`).
	if (markerIndex === -1) return parseClaudeQuestion(input) ?? parseOmpPrompt(input);

	// ── header: between the rule that opens the prompt box and the marker ──────
	let start = markerIndex - 1;
	const floor = Math.max(0, markerIndex - MAX_HEADER_LOOKBACK);
	while (start >= floor && !RULE.test(lines[start] ?? "")) start -= 1;
	const headerFrom = start >= floor ? start + 1 : floor;

	const header = lines
		.slice(headerFrom, markerIndex)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	const toolLabel = header[0] ?? "";
	const body = header.slice(1);
	// With two or more body lines the last is claude's summary and the rest are
	// the arguments (a Write prompt shows several argument lines). With one there
	// is nothing to summarise, so it is the argument.
	const description = body.length >= 2 ? body[body.length - 1] : undefined;
	const argumentText = (body.length >= 2 ? body.slice(0, -1) : body).join("\n");

	// ── options: numbered lines below the marker, up to the next rule ──────────
	const options: PromptOption[] = [];
	for (let i = markerIndex + 1; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (RULE.test(line)) break;
		const match = OPTION_LINE.exec(line);
		if (!match) continue;
		const [, id, label] = match;
		if (!id || !label) continue;
		options.push({ id, label, keystroke: id });
	}

	return {
		dialect: "claude",
		promptKind: "permission",
		toolLabel,
		argumentText,
		...(description ? { description } : {}),
		options,
		fingerprint: fingerprintOf({ toolLabel, argumentText, description, options }),
	};
}
