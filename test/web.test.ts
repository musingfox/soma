import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { expect, test } from "vitest";
import {
	FETCH_MAX_BYTES,
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

test("no more than the byte cap is read, so an endless page cannot stall parsing", async () => {
	// One element per chunk: Defuddle's time follows the element count, not the bytes this test counts. A chunk of 1024
	// <p> spent 2.4 s of the 5 s budget in Defuddle, and CPU load took it past 5 s.
	const chunk = new TextEncoder().encode(`<p>${"filler text. ".repeat(1496)}</p>`);
	let pulled = 0;
	const endless = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				new TextEncoder().encode("<html><head><title>Huge</title></head><body><article><p>The first paragraph.</p>"),
			);
		},
		pull(controller) {
			pulled += chunk.byteLength;
			controller.enqueue(chunk);
		},
	});
	const result = await fetchPage(
		"https://example.com/huge",
		async () => new Response(endless, { headers: { "content-type": "text/html" } }),
		signal,
	);
	expect(result.isError).toBe(false);
	expect(result.text).toContain("The first paragraph.");
	expect(result.text).toMatch(/\[Read only the first 512 KB of the page\.\]$/);
	expect(pulled).toBeLessThan(FETCH_MAX_BYTES + 3 * chunk.byteLength);
});

/** Just under the byte cap, so it is read whole; dense as the 512 KB page in `FETCH_MAX_BYTES`, it took 1.6 s to parse. */
const densePage = (() => {
	const paragraph = (i: number) => `<p>Item ${i} ${"word ".repeat(100)}<em>e</em></p>`;
	const paragraphs: string[] = [];
	let size = Buffer.byteLength(html(""));
	for (let i = 0; size + paragraph(i).length <= FETCH_MAX_BYTES; i++) {
		paragraphs.push(paragraph(i));
		size += paragraph(i).length;
	}
	return html(paragraphs.join(""));
})();

test("a dense page parses while a timer set beside it still fires on time", async () => {
	const started = performance.now();
	let fired = Number.POSITIVE_INFINITY;
	setTimeout(() => {
		fired = performance.now() - started;
	}, 10);
	const result = await fetchPage("https://example.com/dense", serve(densePage), signal);
	const parsed = performance.now() - started;
	expect(result.isError).toBe(false);
	// The parse outlasted the 100 ms, so a parse on the event loop would have kept the timer from firing in them.
	expect(parsed).toBeGreaterThan(100);
	expect(fired).toBeLessThan(100);
}, 60_000);

test("a dense page comes back as the parse on the main thread gave it", async () => {
	const url = "https://example.com/dense";
	const result = await fetchPage(url, serve(densePage), signal);
	const page = await Defuddle(parseHTML(densePage).document, url, { markdown: true, useAsync: false });
	const text = `# ${page.title}\n\n${url}\n\n${page.content}`;
	expect(result).toEqual({
		isError: false,
		text: `${text.slice(0, FETCH_MAX_CHARS)}\n\n[Cut at ${FETCH_MAX_CHARS} of ${text.length} characters.]`,
	});
}, 60_000);

test("pages fetched at once each come back with their own content", async () => {
	const pages = await Promise.all(
		[0, 1, 2].map((i) =>
			fetchPage(`https://example.com/${i}`, serve(html(`<p>Only page ${i} says this.</p>`)), signal),
		),
	);
	pages.forEach((page, i) => {
		expect(page.text).toContain(`https://example.com/${i}\n\n`);
		expect(page.text).toContain(`Only page ${i} says this.`);
	});
});

test("a page the parser throws on is an error result, and the next page still parses", async () => {
	expect(await fetchPage("https://example.com/broken", serve("<"), signal)).toEqual({
		isError: true,
		text: "https://example.com/broken could not be parsed as HTML.",
	});
	expect((await fetchPage("https://example.com/a", serve(html("<p>Fine.</p>")), signal)).text).toContain("Fine.");
});

test("plain node parses a page without a build and exits once it is answered", () => {
	const module = resolve(import.meta.dirname, "../src/core/extensions/web/index.ts");
	const script =
		`const { fetchPage } = await import(${JSON.stringify(module)});` +
		`const page = new Response("<html><body><article><p>Parsed in a worker.</p></article></body></html>", ` +
		`{ headers: { "content-type": "text/html" } });` +
		`console.log((await fetchPage("https://example.com/", async () => page, undefined)).text);`;
	// A file, not --eval: the worker takes node's flags, and it cannot load with --eval's --input-type.
	const dir = mkdtempSync(join(tmpdir(), "soma-web-"));
	try {
		writeFileSync(join(dir, "fetch.mjs"), script);
		const run = spawnSync(process.execPath, [join(dir, "fetch.mjs")], { encoding: "utf8", timeout: 30_000 });
		expect(run.stdout).toContain("Parsed in a worker.");
		expect(run.status).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 60_000);

test("a page of exactly the byte cap is not reported as cut, one byte more is", async () => {
	const chunked = (total: number) => {
		let sent = 0;
		return new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent >= total) return controller.close();
				const size = Math.min(16 * 1024, total - sent);
				sent += size;
				controller.enqueue(new Uint8Array(size).fill(0x61));
			},
		});
	};
	const read = (total: number) =>
		fetchPage(
			"https://example.com/a.txt",
			async () => new Response(chunked(total), { headers: { "content-type": "text/plain" } }),
			signal,
		);
	expect((await read(FETCH_MAX_BYTES)).text).not.toContain("Read only");
	expect((await read(FETCH_MAX_BYTES + 1)).text).toContain("Read only the first 512 KB");
});

test("a page is decoded in the charset its response names", async () => {
	const big5 = new Uint8Array([0xa4, 0xa4, 0xa4, 0xe5]);
	const result = await fetchPage(
		"https://example.com/tw.txt",
		async () => new Response(big5, { headers: { "content-type": "text/plain; charset=big5" } }),
		signal,
	);
	expect(result.text).toBe("https://example.com/tw.txt\n\n中文");
});

test("an empty page or one of no stated type is an error result", async () => {
	expect(await fetchPage("https://example.com/empty", serve(""), signal)).toEqual({
		isError: true,
		text: "https://example.com/empty answered with an empty page.",
	});
	expect(await fetchPage("https://example.com/blob", async () => new Response(new Uint8Array([0, 1])), signal)).toEqual(
		{
			isError: true,
			text: "https://example.com/blob is of no stated type, not a text page.",
		},
	);
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
	await search("node release", 0, KEY, exa(exaResults), signal);
	expect(JSON.parse(String(exa.calls[2]?.request?.body)).numResults).toBe(1);
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
