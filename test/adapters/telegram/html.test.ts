import { expect, test } from "vitest";
import { htmlToPlain, markdownToHtml, splitHtml } from "../../../src/adapters/telegram/html.ts";

/** The tags of `html` nest and close, so Telegram can parse the part. */
function balanced(html: string): boolean {
	const open: string[] = [];
	for (const [, closing, name = ""] of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
		if (closing === "") open.push(name);
		else if (open.pop() !== name) return false;
	}
	return open.length === 0;
}

test("bold, italic, strikethrough and inline code become Telegram's tags", () => {
	expect(markdownToHtml("**b** and __c__")).toBe("<b>b</b> and <b>c</b>");
	expect(markdownToHtml("*i* and _j_")).toBe("<i>i</i> and <i>j</i>");
	expect(markdownToHtml("~~gone~~")).toBe("<s>gone</s>");
	expect(markdownToHtml("run `npm test` now")).toBe("run <code>npm test</code> now");
	expect(markdownToHtml("***both***")).toBe("<i><b>both</b></i>");
});

test("a code block keeps its language, and one without a language is plain pre", () => {
	expect(markdownToHtml("```ts\nconst a = 1;\n```")).toBe('<pre><code class="language-ts">const a = 1;</code></pre>');
	expect(markdownToHtml("```\nplain\n```")).toBe("<pre>plain</pre>");
	expect(markdownToHtml("    indented")).toBe("<pre>indented</pre>");
});

test("a link becomes an anchor; one Telegram would not open keeps its address in the text", () => {
	expect(markdownToHtml("[docs](https://example.com/a?x=1&y=2)")).toBe(
		'<a href="https://example.com/a?x=1&amp;y=2">docs</a>',
	);
	expect(markdownToHtml("see <https://example.com>")).toBe('see <a href="https://example.com">https://example.com</a>');
	expect(markdownToHtml("[here](notes/a.md)")).toBe("here (notes/a.md)");
	expect(markdownToHtml("![chart](https://example.com/c.png)")).toBe('<a href="https://example.com/c.png">chart</a>');
});

test("a blockquote becomes blockquote, and a quote inside a quote is not nested", () => {
	expect(markdownToHtml("> quoted **text**")).toBe("<blockquote>quoted <b>text</b></blockquote>");
	expect(markdownToHtml("> a\n>\n> > b")).toBe("<blockquote>a\n\nb</blockquote>");
});

test("<, > and & in text are escaped, and so is raw HTML the model wrote", () => {
	expect(markdownToHtml("1 < 2 && 3 > 2")).toBe("1 &lt; 2 &amp;&amp; 3 &gt; 2");
	expect(markdownToHtml("<b>not bold</b> <script>x</script>")).toBe(
		"&lt;b&gt;not bold&lt;/b&gt; &lt;script&gt;x&lt;/script&gt;",
	);
	expect(markdownToHtml("&amp; and &lt;")).toBe("&amp; and &lt;");
	expect(markdownToHtml('[a<b](https://e.com/?q="x"&r)')).toBe(
		'<a href="https://e.com/?q=&quot;x&quot;&amp;r">a&lt;b</a>',
	);
});

test("<, > and & in code are escaped, in a span and in a block", () => {
	expect(markdownToHtml("use `a<b && c>d`")).toBe("use <code>a&lt;b &amp;&amp; c&gt;d</code>");
	expect(markdownToHtml('```html\n<div class="x">&</div>\n```')).toBe(
		'<pre><code class="language-html">&lt;div class="x"&gt;&amp;&lt;/div&gt;</code></pre>',
	);
	expect(markdownToHtml("```\n</pre><b>\n```")).toBe("<pre>&lt;/pre&gt;&lt;b&gt;</pre>");
});

test("a heading becomes a bold line, whatever its level", () => {
	expect(markdownToHtml("# Title")).toBe("<b>Title</b>");
	expect(markdownToHtml("### Sub with `code` & more\n\ntext")).toBe(
		"<b>Sub with <code>code</code> &amp; more</b>\n\ntext",
	);
});

test("lists become • lines, numbers stay, nesting indents, and tasks show their box", () => {
	expect(markdownToHtml("- one\n- **two**\n- three")).toBe("• one\n• <b>two</b>\n• three");
	expect(markdownToHtml("1. one\n2. two")).toBe("1. one\n2. two");
	expect(markdownToHtml("3. three\n4. four")).toBe("3. three\n4. four");
	expect(markdownToHtml("- a\n  - b\n    - c\n- d")).toBe("• a\n  • b\n    • c\n• d");
	expect(markdownToHtml("- [x] done\n- [ ] todo")).toBe("☑ done\n☐ todo");
	expect(markdownToHtml("- a\n\n  more\n- b")).toBe("• a\n  more\n• b");
});

test("a table becomes aligned lines in a pre block, with the header marked off", () => {
	const table = "| name | qty |\n|:-----|----:|\n| apple | 3 |\n| **fig** | 12 |";
	expect(markdownToHtml(table)).toBe(
		["<pre>name  | qty", "------+----", "apple |   3", "fig   |  12</pre>"].join("\n"),
	);
	expect(markdownToHtml("| a | b |\n|---|---|\n| <x> | & |")).toBe(
		["<pre>a   | b", "----+--", "&lt;x&gt; | &amp;</pre>"].join("\n"),
	);
});

test("a table counts wide characters as two columns", () => {
	expect(markdownToHtml("| 名稱 | n |\n|---|---|\n| ab | 1 |")).toBe(
		["<pre>名稱 | n", "-----+--", "ab   | 1</pre>"].join("\n"),
	);
});

test("a horizontal rule becomes a line and paragraphs keep a blank line between them", () => {
	expect(markdownToHtml("a\n\n---\n\nb")).toBe("a\n\n──────────\n\nb");
	expect(markdownToHtml("line one  \nline two")).toBe("line one\nline two");
});

test("empty or blank markdown converts to nothing", () => {
	expect(markdownToHtml("")).toBe("");
	expect(markdownToHtml("  \n ")).toBe("");
});

test("splitHtml leaves a short text whole and cuts a long one at a line break", () => {
	expect(splitHtml("<b>short</b>", 4096)).toEqual(["<b>short</b>"]);
	expect(splitHtml(`${"a".repeat(7)}\n${"b".repeat(5)}`, 10)).toEqual(["aaaaaaa", "bbbbb"]);
	expect(splitHtml("a".repeat(25), 10)).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
});

test("splitHtml closes what is open at a cut and reopens it in the next part", () => {
	const parts = splitHtml(`<b>${"word ".repeat(40)}</b>`, 100);
	expect(parts.length).toBeGreaterThan(1);
	for (const part of parts) {
		expect(part.length).toBeLessThanOrEqual(100);
		expect(balanced(part)).toBe(true);
		expect(part.startsWith("<b>")).toBe(true);
		expect(part.endsWith("</b>")).toBe(true);
	}
	expect(parts.map(htmlToPlain).join("").replace(/\s+/g, "")).toBe("word".repeat(40));
});

test("splitHtml keeps a code block's language on every part and never cuts a tag or an entity", () => {
	const code = `<pre><code class="language-ts">${"a &lt; b;\n".repeat(60)}</code></pre>`;
	const parts = splitHtml(code, 200);
	expect(parts.length).toBeGreaterThan(2);
	for (const part of parts) {
		expect(part.length).toBeLessThanOrEqual(200);
		expect(balanced(part)).toBe(true);
		expect(part.startsWith('<pre><code class="language-ts">')).toBe(true);
		expect(part.replace(/<[^>]*>/g, "")).not.toMatch(/&(?![a-z]+;)/);
	}
	const lines = parts.map((part) => part.replace(/<[^>]*>/g, "")).join("\n");
	expect(lines.match(/a &lt; b;/g)).toHaveLength(60);
});

test("splitHtml splits a real converted answer into balanced parts within the limit", () => {
	const answer = [
		"# Report",
		...Array.from({ length: 80 }, (_, i) => `- item ${i} with **bold ${i}** and \`code <${i}>\``),
		`> a quote ${"that runs on ".repeat(40)}`,
		`\`\`\`py\n${"print('x & y')\n".repeat(80)}\`\`\``,
	].join("\n\n");
	const parts = splitHtml(markdownToHtml(answer), 1000);
	expect(parts.length).toBeGreaterThan(3);
	for (const part of parts) {
		expect(part.length).toBeLessThanOrEqual(1000);
		expect(balanced(part)).toBe(true);
	}
});

test("htmlToPlain drops tags and decodes the three entities", () => {
	expect(htmlToPlain('<b>a</b> &lt;x&gt; &amp; <a href="https://e.com/?a&amp;b">l</a>')).toBe("a <x> & l");
	expect(htmlToPlain('<pre><code class="language-ts">a &quot;b&quot;</code></pre>')).toBe('a "b"');
});
