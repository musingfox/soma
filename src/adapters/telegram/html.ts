import { marked, type Token, type Tokens } from "marked";

// What parse_mode HTML takes: https://core.telegram.org/bots/api#html-style. The model writes markdown, so the
// markup is the lexer's tokens and everything else is text: escaped, never passed through.

export const escapeHtml = (text: string) =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttribute = (text: string) => escapeHtml(text).replaceAll('"', "&quot;");

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** Markdown reads `&amp;` in text as `&`; code and attributes keep it as written. */
const decodeEntities = (text: string) =>
	text.replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (whole, decimal?: string, hex?: string, name?: string) => {
		const code = decimal !== undefined ? Number(decimal) : hex !== undefined ? Number.parseInt(hex, 16) : undefined;
		if (code === undefined) return NAMED_ENTITIES[(name ?? "").toLowerCase()] ?? whole;
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
	});

// A link Telegram opens; any other address stays visible in the text instead.
const OPENABLE = /^(?:https?:\/\/|tg:\/\/|mailto:)/i;
const RULE = "──────────";

interface Context {
	/** Inside a heading or a quote: its tag is already open, so a nested one is left out. */
	readonly bold?: boolean;
	readonly quoted?: boolean;
}

function link(href: string, label: string): string {
	if (OPENABLE.test(href)) return `<a href="${escapeAttribute(href)}">${label}</a>`;
	return label === "" || label === escapeHtml(href) ? escapeHtml(href) : `${label} (${escapeHtml(href)})`;
}

/** The nested tokens of a token of any type, as the lexer gives them. */
const children = (token: Token): Token[] | undefined => (token as Tokens.Generic).tokens;

function inline(tokens: readonly Token[] | undefined, context: Context = {}): string {
	return (tokens ?? []).map((token) => span(token, context)).join("");
}

function span(token: Token, context: Context): string {
	switch (token.type) {
		case "text":
			return token.tokens ? inline(token.tokens, context) : escapeHtml(decodeEntities(token.text));
		case "escape":
			return escapeHtml(token.text);
		case "strong":
			return context.bold ? inline(token.tokens, context) : `<b>${inline(token.tokens, context)}</b>`;
		case "em":
			return `<i>${inline(token.tokens, context)}</i>`;
		case "del":
			return `<s>${inline(token.tokens, context)}</s>`;
		case "codespan":
			return `<code>${escapeHtml(token.text)}</code>`;
		case "br":
			return "\n";
		case "link":
			return link(token.href, inline(token.tokens, context));
		case "image":
			return link(token.href, escapeHtml(token.text));
		case "checkbox":
			return "";
		default:
			// Raw HTML from the model is shown as the text it is.
			return children(token) ? inline(children(token), context) : escapeHtml(token.raw);
	}
}

/** The width a character takes in a monospace font: 2 for the wide scripts and emoji. */
function width(text: string): number {
	let total = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			(code >= 0x1f300 && code <= 0x1faff) ||
			(code >= 0x20000 && code <= 0x3fffd);
		total += wide ? 2 : 1;
	}
	return total;
}

function pad(text: string, size: number, align: "center" | "left" | "right" | null): string {
	const gap = Math.max(0, size - width(text));
	if (align === "right") return " ".repeat(gap) + text;
	if (align === "center") return " ".repeat(Math.floor(gap / 2)) + text + " ".repeat(Math.ceil(gap / 2));
	return text + " ".repeat(gap);
}

/** Telegram has no tables: aligned columns in a monospace block read as one. */
function table({ header, rows }: Tokens.Table): string {
	const plain = (cell: Tokens.TableCell) => htmlToPlain(inline(cell.tokens)).replace(/\s+/g, " ").trim();
	const grid = [header, ...rows].map((row) => row.map(plain));
	const sizes = header.map((_, column) => Math.max(...grid.map((row) => width(row[column] ?? ""))));
	const line = (row: string[]) =>
		escapeHtml(
			row
				.map((cell, column) => pad(cell, sizes[column] ?? 0, header[column]?.align ?? null))
				.join(" | ")
				.trimEnd(),
		);
	const rule = sizes
		.map((size, column) => "-".repeat(size + (column === 0 || column === sizes.length - 1 ? 1 : 2)))
		.join("+");
	const [head = [], ...body] = grid;
	return `<pre>${[line(head), rule, ...body.map(line)].join("\n")}</pre>`;
}

function list({ items, ordered, start }: Tokens.List, context: Context): string {
	return items
		.map((item, index) => {
			const marker = item.task ? (item.checked ? "☑" : "☐") : ordered ? `${(start || 1) + index}.` : "•";
			const indent = " ".repeat(ordered && !item.task ? marker.length + 1 : 2);
			const body = blocks(item.tokens, context).join("\n");
			return `${marker} ${body.replaceAll("\n", `\n${indent}`)}`;
		})
		.join("\n");
}

function block(token: Token, context: Context): string | undefined {
	switch (token.type) {
		case "space":
		case "def":
		case "checkbox":
			return undefined;
		case "heading":
			return `<b>${inline(token.tokens, { ...context, bold: true })}</b>`;
		case "paragraph":
		case "text":
			return inline(token.tokens ?? [token], context);
		case "code": {
			const language = /^[\w+#.-]+$/.exec(token.lang?.split(/\s/)[0] ?? "")?.[0];
			const code = escapeHtml(token.text);
			return language === undefined
				? `<pre>${code}</pre>`
				: `<pre><code class="language-${language}">${code}</code></pre>`;
		}
		case "blockquote": {
			const inner = blocks((token as Tokens.Blockquote).tokens, { ...context, quoted: true }).join("\n\n");
			return context.quoted ? inner : `<blockquote>${inner}</blockquote>`;
		}
		case "list":
			return list(token as Tokens.List, context);
		case "table":
			return table(token as Tokens.Table);
		case "hr":
			return RULE;
		default:
			return children(token) ? inline(children(token), context) : escapeHtml(token.raw.trim());
	}
}

function blocks(tokens: readonly Token[], context: Context): string[] {
	return tokens.map((token) => block(token, context)).filter((html): html is string => html !== undefined);
}

/** Markdown as the HTML subset parse_mode HTML takes; what it cannot show becomes readable text. */
export function markdownToHtml(markdown: string): string {
	return blocks(marked.lexer(markdown), {}).join("\n\n").trim();
}

/** The text of `html` as Telegram would show it: for a part sent again without a parse mode. */
export function htmlToPlain(html: string): string {
	return html
		.replace(/<[^>]*>/g, "")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&amp;", "&");
}

const closing = (stack: readonly string[]) =>
	[...stack]
		.reverse()
		.map((tag) => `</${/^<([\w-]+)/.exec(tag)?.[1]}>`)
		.join("");

/**
 * Cut HTML into parts of at most `limit` characters that each stand alone: at a line break when one is past the
 * middle of a part, never inside a tag, an entity or a surrogate pair. What is open at a cut is closed there and
 * opened again, with its attributes, at the start of the next part.
 */
export function splitHtml(html: string, limit: number): string[] {
	const tokens = html.match(/<[^>]*>|&#?\w+;|[\s\S]/gu) ?? [];
	const parts: string[] = [];
	const emit = (part: string) => {
		if (htmlToPlain(part).trim() !== "") parts.push(part);
	};
	let at = 0;
	let carried: string[] = [];
	while (at < tokens.length) {
		const stack = [...carried];
		const reopened = carried.join("");
		let body = "";
		let visible = false;
		// The latest line break past the middle of the part: where it is cut, if it overflows.
		let lineBreak: { at: number; body: string; stack: string[] } | undefined;
		let cut: { at: number; body: string; stack: string[] } | undefined;
		for (; at < tokens.length; at += 1) {
			const token = tokens[at] as string;
			const next = [...stack];
			if (token.startsWith("</")) next.pop();
			else if (token.startsWith("<")) next.push(token);
			if (visible && reopened.length + body.length + token.length + closing(next).length > limit) {
				cut = lineBreak;
				break;
			}
			if (token === "\n" && reopened.length + body.length >= limit / 2)
				lineBreak = { at: at + 1, body, stack: [...stack] };
			body += token;
			visible ||= !token.startsWith("<");
			stack.splice(0, stack.length, ...next);
		}
		if (cut === undefined) {
			emit(reopened + body + closing(stack));
			carried = [...stack];
		} else {
			emit(reopened + cut.body + closing(cut.stack));
			carried = cut.stack;
			at = cut.at;
		}
	}
	return parts;
}
