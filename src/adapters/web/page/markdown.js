// Markdown to DOM nodes, for the speech bubble. marked only lexes; every node here is built with createElement and
// createTextNode from its tokens, so the model's text, and what it quotes, never goes through an HTML parser: raw HTML
// shows as text, an image shows its description and loads nothing, and a link needs an http(s) address.
import { Lexer } from "marked";

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The character references marked leaves in text, hrefs and titles, decoded in one pass; any other stays as written. */
function decode(text) {
	return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-z]+));/g, (whole, dec, hex, name) => {
		if (name) return Object.hasOwn(NAMED, name) ? NAMED[name] : whole;
		const code = dec ? Number(dec) : Number.parseInt(hex, 16);
		return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
	});
}

/** The normalized address when it is absolute http or https, else undefined: a relative or any other scheme gets none. */
function safeHref(href) {
	try {
		const url = new URL(decode(href).trim());
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

/** What an inline token shows as plain text, for an image's description. */
function plain(tokens) {
	return tokens
		.map((token) => {
			if (token.tokens) return plain(token.tokens);
			return token.type === "br" ? " " : decode(token.text ?? token.raw ?? "");
		})
		.join("");
}

/** Renders `source` as a fragment of `doc`: paragraphs, emphasis, code, lists, links, quotes, headings and tables. */
export function renderMarkdown(source, doc = document) {
	const el = (tag, ...children) => {
		const node = doc.createElement(tag);
		node.append(...children);
		return node;
	};
	const text = (value) => doc.createTextNode(value);

	const inline = (tokens) =>
		tokens.flatMap((token) => {
			switch (token.type) {
				case "strong":
				case "em":
				case "del":
					return [el(token.type, ...inline(token.tokens))];
				case "codespan":
					return [el("code", text(token.text))];
				case "br":
					return [el("br")];
				case "escape":
					return [text(token.text)];
				case "link": {
					const href = safeHref(token.href);
					const children = inline(token.tokens);
					if (href === undefined) return children;
					const anchor = el("a", ...children);
					anchor.setAttribute("href", href);
					if (token.title) anchor.setAttribute("title", decode(token.title));
					anchor.setAttribute("target", "_blank");
					anchor.setAttribute("rel", "noopener noreferrer");
					return [anchor];
				}
				case "image":
					return [text(plain(token.tokens))];
				case "checkbox":
					return [text(token.checked ? "☑ " : "☐ ")];
				case "html":
					// Shown as the text it is, never parsed.
					return [text(token.text)];
				default:
					return token.tokens ? inline(token.tokens) : [text(decode(token.text ?? token.raw ?? ""))];
			}
		});

	const cell = (tag, { tokens, align }) => {
		const node = el(tag, ...inline(tokens));
		if (align) node.setAttribute("style", `text-align: ${align}`);
		return node;
	};

	const block = (tokens) =>
		tokens.flatMap((token) => {
			switch (token.type) {
				case "space":
				case "def":
					return [];
				case "paragraph":
					return [el("p", ...inline(token.tokens))];
				case "heading":
					return [el(`h${Math.min(6, Math.max(1, token.depth))}`, ...inline(token.tokens))];
				case "code":
					return [el("pre", el("code", text(token.text)))];
				case "blockquote":
					return [el("blockquote", ...block(token.tokens))];
				case "hr":
					return [el("hr")];
				case "list": {
					const list = el(token.ordered ? "ol" : "ul", ...token.items.map((item) => el("li", ...item_(item))));
					if (token.ordered && token.start !== "" && token.start !== 1) list.setAttribute("start", String(token.start));
					return [list];
				}
				case "table": {
					const table = el(
						"table",
						el("thead", el("tr", ...token.header.map((head) => cell("th", head)))),
						el("tbody", ...token.rows.map((row) => el("tr", ...row.map((one) => cell("td", one))))),
					);
					const wrap = el("div", table);
					wrap.setAttribute("class", "table-wrap");
					return [wrap];
				}
				case "html":
					return [el("p", text(token.text.trim()))];
				case "text":
				case "checkbox":
					// A tight list item's text or its checkbox, or a stray one: inline content with no paragraph around it.
					return inline(token.tokens ?? [token]);
				default:
					return token.tokens ? block(token.tokens) : [el("p", text(decode(token.text ?? token.raw ?? "")))];
			}
		});

	/** A list item's children: a loose one's paragraphs stay paragraphs, a tight one's text sits in the item. */
	const item_ = (item) => block(item.tokens);

	const fragment = doc.createDocumentFragment();
	fragment.append(...block(Lexer.lex(source)));
	return fragment;
}
