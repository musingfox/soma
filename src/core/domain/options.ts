/** How many options a question offers the human, whoever asks it: soma's model with `ask`, or a job's agent. */
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
/** An option is a button's text: a few words, not a sentence. */
export const OPTION_MAX_CHARS = 40;

/** Why these option labels cannot be offered, if they cannot. */
export function optionsRefusal(options: readonly string[]): string | undefined {
	if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS)
		return `give ${MIN_OPTIONS} to ${MAX_OPTIONS} options, not ${options.length}`;
	if (options.some((label) => label.trim() === "")) return "an option is empty";
	if (options.some((label) => [...label].length > OPTION_MAX_CHARS))
		return `an option is longer than ${OPTION_MAX_CHARS} characters: keep each to a few words`;
	if (new Set(options.map((label) => label.trim())).size !== options.length) return "two options are the same";
	return undefined;
}

/** The line of a job agent's 需要你 reply under which it lists its options, one numbered line each, ending the reply. */
export const OPTIONS_LINE = "選項：";

const HEADER = /^選項[：:]$/;
// A number, then `.` or `．` and a space, or `)`, `）` or `、` with or without one, and the label. A stop needs the space,
// so a version such as 1.2.0 is no number and a label.
const NUMBERED = /^(\d+)\s*(?:[.．]\s+|[)）、]\s*)(.*)$/;
// A number and its stop in bold, as in `**1.** A`.
const BOLD_NUMBER = /^\*\*(\d+\s*[.．)）、])\*\*/;
const BOLD = /^\*\*(.+)\*\*$/;

/** A line trimmed, with full-width digits as ASCII. */
const digits = (line: string) =>
	line.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0)).trim();

/** `text` without bold markers that wrap it whole as one pair; markers inside it, or around a part of it, stay. */
const unbold = (text: string) => {
	const inner = BOLD.exec(text)?.[1];
	return inner === undefined || inner.includes("**") ? text : inner.trim();
};

/** Whether a line is the header: `選項：`, bold or not, behind a heading marker or not. */
const isHeader = (line: string) => HEADER.test(unbold(digits(line).replace(/^#{1,6}\s*/, "")));

/** A line as an option's number and label, if it is one: bold may wrap the whole line, the number, or the label. */
function optionOf(line: string): { readonly number: number; readonly label: string } | undefined {
	const plain = digits(line);
	const numbered = NUMBERED.exec(BOLD_NUMBER.test(plain) ? plain.replace(BOLD_NUMBER, "$1") : unbold(plain));
	return numbered === null ? undefined : { number: Number(numbered[1]), label: unbold((numbered[2] ?? "").trim()) };
}

/**
 * The options a job's agent listed at the end of its reply in the launch rules' form, and the reply without them: the
 * last `選項：` line, then nothing but its options, numbered from 1 in order, blank lines aside. Agents dress the form in
 * markdown, so the header may be bold or a heading (`**選項：**`, `### 選項：`), and the numbers bold, full-width, or
 * followed by `)` or `、` with or without a space (`**1.**`, `１.`, `1)`, `1、`), though a `.` needs one. Bold markers
 * are taken off only where one pair wraps the whole line, the number or the whole label (`**1. A**`, `**1.** A`,
 * `1. **A**`); any others are part of the label. A list that breaks the form, or holds options `optionsRefusal`
 * refuses, lists none, and the reply is kept whole.
 */
export function listedOptions(reply: string): { readonly text: string; readonly options: string[] } | undefined {
	const lines = reply.split("\n");
	const header = lines.findLastIndex(isHeader);
	if (header <= 0) return undefined;
	const options: string[] = [];
	for (const line of lines.slice(header + 1)) {
		if (line.trim() === "") continue;
		const option = optionOf(line);
		if (option === undefined || option.number !== options.length + 1) return undefined;
		options.push(option.label);
	}
	if (optionsRefusal(options) !== undefined) return undefined;
	return { text: lines.slice(0, header).join("\n").trimEnd(), options };
}
