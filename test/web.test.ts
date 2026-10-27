import { expect, test } from "vitest";
import {
	FETCH_MAX_CHARS,
	fetchPage,
	SEARCH_DEFAULT_RESULTS,
	SEARCH_MAX_RESULTS,
	search,
	web,
} from "../src/core/extensions/web/index.ts";

const signal = new AbortController().signal;
const html = (body: string) =>
	`<!doctype html><html><head><title>A page</title></head><body><nav>Home | About</nav>` +
	`<article><h1>A page</h1>${body}</article><footer>© footer</footer></body></html>`;
const serve =
	(body: string, init: ResponseInit = { headers: { "content-type": "text/html; charset=utf-8" } }) =>
	async () =>
		new Response(body, init);

test("the web tools may rerun on recovery, and search is offered only with a key", () => {
	const tools = (key?: string) => (web({ exaApiKey: key }).tools ?? []).map((tool) => [tool.name, tool.replay]);
	expect(tools("k")).toEqual([
		["web_search", "safe"],
		["web_fetch", "safe"],
	]);
	expect(tools()).toEqual([["web_fetch", "safe"]]);
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

const KEY = "exa-secret-key";
const exaResults = {
	results: [
		{
			title: "Node.js 24 released",
			url: "https://nodejs.org/en/blog/release/v24.0.0",
			publishedDate: "2026-05-06T00:00:00.000Z",
			author: "Node.js",
			highlights: ["Node.js 24 is now available.", "It ships V8 13.6."],
			highlightScores: [0.9, 0.8],
			id: "x",
		},
		{ title: null, url: "https://example.com/untitled", highlights: [] },
	],
	requestId: "r",
};
const exa =
	(body: unknown, init: ResponseInit = { headers: { "content-type": "application/json" } }) =>
	async (input: string, request?: RequestInit) => {
		exa.calls.push({ input, request });
		return new Response(typeof body === "string" ? body : JSON.stringify(body), init);
	};
exa.calls = [] as { input: string; request?: RequestInit }[];

test("a search asks Exa for highlights with the key in a header, five results unless told otherwise", async () => {
	exa.calls = [];
	await search("node release", undefined, KEY, exa(exaResults), signal);
	await search("node release", 99, KEY, exa(exaResults), signal);
	const [first, second] = exa.calls;
	expect(first?.input).toBe("https://api.exa.ai/search");
	expect(first?.request?.method).toBe("POST");
	expect(new Headers(first?.request?.headers).get("x-api-key")).toBe(KEY);
	expect(JSON.parse(String(first?.request?.body))).toEqual({
		query: "node release",
		numResults: SEARCH_DEFAULT_RESULTS,
		contents: { highlights: true },
	});
	expect(JSON.parse(String(second?.request?.body)).numResults).toBe(SEARCH_MAX_RESULTS);
});

test("each result comes back as title, URL, date and highlights, in no provider's vocabulary", async () => {
	const result = await search("node release", 2, KEY, exa(exaResults), signal);
	expect(result).toEqual({
		isError: false,
		text:
			"1. Node.js 24 released\n   https://nodejs.org/en/blog/release/v24.0.0\n   2026-05-06\n" +
			"   Node.js 24 is now available.\n   It ships V8 13.6.\n\n" +
			"2. https://example.com/untitled\n   https://example.com/untitled",
	});
	expect((await search("nothing", 2, KEY, exa({ results: [] }), signal)).text).toBe("No results for: nothing");
});

test("a failed search is an error result that never carries the key", async () => {
	const unauthorized = await search(
		"q",
		undefined,
		KEY,
		exa({ error: `Invalid key ${KEY}` }, { status: 401, statusText: "Unauthorized" }),
		signal,
	);
	expect(unauthorized).toEqual({ isError: true, text: "Search failed: 401 Unauthorized: Invalid key [key]" });
	const failing = async () => {
		throw new TypeError(`fetch failed for ${KEY}`);
	};
	const offline = await search("q", undefined, KEY, failing, signal);
	expect(offline).toEqual({ isError: true, text: "Search failed: fetch failed for [key]" });
	const hanging = (_input: unknown, init?: RequestInit) =>
		new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
	expect(await search("q", undefined, KEY, hanging, signal, 10)).toEqual({
		isError: true,
		text: "Search failed: no answer within 0.01 s",
	});
	const garbled = await search("q", undefined, KEY, exa("<html>"), signal);
	expect(garbled.isError).toBe(true);
});
