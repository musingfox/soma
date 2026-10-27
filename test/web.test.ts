import { expect, test } from "vitest";
import { FETCH_MAX_CHARS, fetchPage, web } from "../src/core/extensions/web/index.ts";

const signal = new AbortController().signal;
const html = (body: string) =>
	`<!doctype html><html><head><title>A page</title></head><body><nav>Home | About</nav>` +
	`<article><h1>A page</h1>${body}</article><footer>© footer</footer></body></html>`;
const serve =
	(body: string, init: ResponseInit = { headers: { "content-type": "text/html; charset=utf-8" } }) =>
	async () =>
		new Response(body, init);

test("the web tools may rerun on recovery", () => {
	const tools = web().tools ?? [];
	expect(tools.map((tool) => [tool.name, tool.replay])).toEqual([["web_fetch", "safe"]]);
});

test("an HTML page comes back as its title, URL and main content in markdown, without navigation", async () => {
	const paragraphs = Array.from({ length: 5 }, (_, i) => `<p>Paragraph ${i} of the <strong>main</strong> text.</p>`);
	const result = await fetchPage("https://example.com/a", serve(html(paragraphs.join(""))), signal);
	expect(result.isError).toBe(false);
	expect(result.text).toMatch(/^# A page\n\nhttps:\/\/example\.com\/a\n\n/);
	expect(result.text).toContain("Paragraph 3 of the **main** text.");
	expect(result.text).not.toContain("Home | About");
	expect(result.text).not.toContain("<p>");
});

test("a plain-text page comes back as it is", async () => {
	const result = await fetchPage(
		"https://example.com/notes.md",
		serve("# Notes\n\nraw", { headers: { "content-type": "text/markdown" } }),
		signal,
	);
	expect(result).toEqual({ isError: false, text: "https://example.com/notes.md\n\n# Notes\n\nraw" });
});

test("a long page is cut at the cap and says how long it was", async () => {
	const long = "x".repeat(FETCH_MAX_CHARS * 2);
	const result = await fetchPage(
		"https://example.com/long",
		serve(long, { headers: { "content-type": "text/plain" } }),
		signal,
	);
	expect(result.isError).toBe(false);
	expect(result.text).toContain(
		`[Cut at ${FETCH_MAX_CHARS} of ${long.length + "https://example.com/long\n\n".length} characters.]`,
	);
	expect(result.text.length).toBeLessThan(FETCH_MAX_CHARS + 100);
});

test("only http and https URLs are fetched", async () => {
	let called = false;
	const result = await fetchPage(
		"file:///etc/passwd",
		async () => {
			called = true;
			return new Response("");
		},
		signal,
	);
	expect(result).toEqual({ isError: true, text: "Only http and https URLs can be fetched: file:///etc/passwd" });
	expect(called).toBe(false);
	expect((await fetchPage("not a url", serve(""), signal)).isError).toBe(true);
});

test("a non-2xx status is an error result naming the status", async () => {
	const result = await fetchPage(
		"https://example.com/gone",
		serve("nope", { status: 404, statusText: "Not Found" }),
		signal,
	);
	expect(result).toEqual({ isError: true, text: "https://example.com/gone answered 404 Not Found." });
});

test("a binary page is an error result naming its type", async () => {
	const result = await fetchPage(
		"https://example.com/a.pdf",
		serve("%PDF", { headers: { "content-type": "application/pdf" } }),
		signal,
	);
	expect(result).toEqual({ isError: true, text: "https://example.com/a.pdf is application/pdf, not a text page." });
});

test("a network failure or timeout is an error result", async () => {
	const failing = async () => {
		throw new TypeError("fetch failed");
	};
	expect(await fetchPage("https://example.com/", failing, signal)).toEqual({
		isError: true,
		text: "Could not fetch https://example.com/: fetch failed",
	});
	const hanging = (_input: unknown, init?: RequestInit) =>
		new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
	expect(await fetchPage("https://example.com/", hanging, signal, 10)).toEqual({
		isError: true,
		text: "Could not fetch https://example.com/: no answer within 0.01 s",
	});
});
