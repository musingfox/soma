import { parseHTML } from "linkedom";
import { expect, test } from "vitest";
import { renderMarkdown } from "../../../src/adapters/web/page/markdown.js";

const { document } = parseHTML("<!doctype html><html><body></body></html>");

/** The markup renderMarkdown builds for `source`. */
function html(source: string): string {
	const box = document.createElement("div");
	box.append(renderMarkdown(source, document));
	return box.innerHTML;
}

/** Every element renderMarkdown builds for `source`, with its tag name and attributes. */
function elements(source: string): { tag: string; attrs: Record<string, string> }[] {
	const box = document.createElement("div");
	box.append(renderMarkdown(source, document));
	return [...box.querySelectorAll("*")].map((el) => ({
		tag: el.tagName.toLowerCase(),
		attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
	}));
}

test("paragraphs, bold, italic, strikethrough and inline code", () => {
	expect(html("one\n\ntwo **bold** and *italic* and ~~gone~~ and `code`")).toBe(
		"<p>one</p><p>two <strong>bold</strong> and <em>italic</em> and <del>gone</del> and <code>code</code></p>",
	);
});

test("a hard line break and a rule", () => {
	expect(html("a  \nb\n\n---\n\nc")).toBe("<p>a<br>b</p><hr><p>c</p>");
});

test("headings keep their level", () => {
	expect(html("# one\n\n### three")).toBe("<h1>one</h1><h3>three</h3>");
});

test("a code block keeps its text as written, and its markup is text", () => {
	expect(html("```js\nlet a = 1 < 2;\n  <b>x</b>\n```")).toBe(
		"<pre><code>let a = 1 &lt; 2;\n  &lt;b&gt;x&lt;/b&gt;</code></pre>",
	);
});

test("bullet, numbered and task lists", () => {
	expect(html("- a\n- **b**\n\n3. c\n4. d\n\n- [x] done\n- [ ] todo")).toBe(
		"<ul><li>a</li><li><strong>b</strong></li></ul>" +
			'<ol start="3"><li>c</li><li>d</li></ol>' +
			"<ul><li>☑ done</li><li>☐ todo</li></ul>",
	);
});

test("a nested list, and a loose list whose items hold paragraphs", () => {
	expect(html("- a\n  - b\n- c")).toBe("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>");
	expect(html("- c\n\n  more\n\n- d")).toBe("<ul><li><p>c</p><p>more</p></li><li><p>d</p></li></ul>");
});

test("a blockquote holds blocks", () => {
	expect(html("> quoted *text*\n>\n> - item")).toBe(
		"<blockquote><p>quoted <em>text</em></p><ul><li>item</li></ul></blockquote>",
	);
});

test("a table scrolls inside a wrapper of its own, and keeps its alignment", () => {
	expect(html("| a | b |\n|:--|--:|\n| 1 | **2** |")).toBe(
		'<div class="table-wrap"><table><thead><tr><th style="text-align: left">a</th><th style="text-align: right">b</th></tr></thead>' +
			'<tbody><tr><td style="text-align: left">1</td><td style="text-align: right"><strong>2</strong></td></tr></tbody></table></div>',
	);
});

test("an http or https link opens in a new tab and cannot reach back to the page", () => {
	expect(
		elements('[site](https://example.com/a?x=1&amp;y=2 "hello") and <https://example.org> and http://example.net'),
	).toEqual([
		{ tag: "p", attrs: {} },
		{
			tag: "a",
			attrs: { href: "https://example.com/a?x=1&y=2", title: "hello", target: "_blank", rel: "noopener noreferrer" },
		},
		{ tag: "a", attrs: { href: "https://example.org/", target: "_blank", rel: "noopener noreferrer" } },
		{ tag: "a", attrs: { href: "http://example.net/", target: "_blank", rel: "noopener noreferrer" } },
	]);
});

test("a link that is not http(s) shows its text and no anchor", () => {
	for (const href of [
		"javascript:alert(1)",
		"JaVaScRiPt:alert(1)",
		"  javascript:alert(1)",
		"java&#x09;script:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"vbscript:x",
		"file:///etc/passwd",
		"//evil.example/x",
		"/relative",
		"#frag",
		"mailto:a@b.c",
	]) {
		const source = `[click](<${href}>)`;
		expect([href, html(source)]).toEqual([href, "<p>click</p>"]);
	}
	expect(html("[click][r]\n\n[r]: javascript:alert(1)")).toBe("<p>click</p>");
});

test("an image loads nothing: its description shows as text", () => {
	expect(html("![a cat](https://example.com/cat.png) ![x](javascript:alert(1))")).toBe("<p>a cat x</p>");
	expect(elements("![a cat](https://example.com/cat.png)").map((el) => el.tag)).toEqual(["p"]);
});

test("raw HTML shows as text and builds no element", () => {
	const sources = [
		"<script>alert(1)</script>",
		"hi <img src=x onerror=alert(1)> there",
		"<div onclick=alert(1)>block</div>",
		"<iframe src=https://example.com></iframe>",
		'<a href="javascript:alert(1)">x</a>',
		"<style>body{display:none}</style>",
		"<b>bold?</b>",
		"# <script>alert(1)</script>",
		"- <svg onload=alert(1)>",
		"| <img src=x onerror=alert(1)> |\n|-|\n| <b>x</b> |",
	];
	for (const source of sources) {
		const tags = new Set(
			elements(source)
				.filter((el) => el.attrs.class !== "table-wrap")
				.map((el) => el.tag),
		);
		for (const tag of ["script", "img", "iframe", "style", "svg", "a", "b", "div"])
			expect([source, tag, tags.has(tag)]).toEqual([source, tag, false]);
		expect(html(source)).toContain("&lt;");
	}
	expect(html("<b>bold?</b>")).toBe("<p>&lt;b&gt;bold?&lt;/b&gt;</p>");
});

test("no element carries an event handler, a style beyond table alignment, or a src", () => {
	const source =
		"# t\n\n<img src=x onerror=alert(1)>\n\n[a](https://e.com) ![i](https://e.com/i.png)\n\n| a |\n|:-:|\n| <b onmouseover=x>1</b> |\n\n```\n<script>\n```";
	for (const { tag, attrs } of elements(source)) {
		for (const name of Object.keys(attrs)) {
			expect([tag, name, ["href", "title", "target", "rel", "style", "start", "class"].includes(name)]).toEqual([
				tag,
				name,
				true,
			]);
		}
		if (attrs.style !== undefined) expect(attrs.style).toMatch(/^text-align: (left|right|center)$/);
	}
});

test("character references show as the characters they stand for, once", () => {
	expect(html("a &amp; b &lt;c&gt; &#65; &#x42; &quot;")).toBe('<p>a &amp; b &lt;c&gt; A B "</p>');
	expect(html("&amp;lt;b&amp;gt;")).toBe("<p>&amp;lt;b&amp;gt;</p>");
	expect(html("\\*not italic\\*")).toBe("<p>*not italic*</p>");
});

test("text that is not markdown comes out as the text it is", () => {
	expect(html("plain words, 2 < 3 > 1 & more")).toBe("<p>plain words, 2 &lt; 3 &gt; 1 &amp; more</p>");
	expect(html("")).toBe("");
});
