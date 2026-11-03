import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { z } from "zod";

export const FETCH_MAX_CHARS = 20_000;
export const WEB_TIMEOUT_MS = 15_000;
/**
 * Parsing is synchronous and outside the timeout, and its time grows faster than the page: dense 1 MB took 4.8 s, 512 KB
 * 1.7 s. A 416 KB GitHub page lost its README when cut at 256 KB.
 */
export const FETCH_MAX_BYTES = 512 * 1024;
export const SEARCH_DEFAULT_RESULTS = 5;
export const SEARCH_MAX_RESULTS = 10;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type Result = { text: string; isError: boolean };

const failure = (text: string): Result => ({ text, isError: true });

const withTimeout = (signal: AbortSignal | undefined, timeoutMs: number) =>
	AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);

const reasonOf = (error: unknown, timeoutMs: number) =>
	error instanceof Error && error.name === "TimeoutError"
		? `no answer within ${timeoutMs / 1000} s`
		: error instanceof Error
			? error.message
			: String(error);

/** At most `FETCH_MAX_BYTES` of the body, decoded in the charset the response names; `cut` when there was more. */
async function readBody(response: Response): Promise<{ body: string; cut: boolean }> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	let ended = true;
	const reader = response.body?.getReader();
	while (reader) {
		if (size >= FETCH_MAX_BYTES) {
			ended = (await reader.read()).done;
			break;
		}
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		size += value.byteLength;
	}
	await reader?.cancel();
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const charset = /charset=([^;]+)/i.exec(response.headers.get("content-type") ?? "")?.[1]?.trim();
	let decoder: TextDecoder;
	try {
		decoder = new TextDecoder(charset ?? "utf-8");
	} catch {
		decoder = new TextDecoder();
	}
	return { body: decoder.decode(bytes.subarray(0, FETCH_MAX_BYTES)), cut: !ended };
}

function cap(text: string): string {
	if (text.length <= FETCH_MAX_CHARS) return text;
	return `${text.slice(0, FETCH_MAX_CHARS)}\n\n[Cut at ${FETCH_MAX_CHARS} of ${text.length} characters.]`;
}

/** The page's main content as markdown, or its body when it is already text; every failure is a readable result. */
export async function fetchPage(
	url: string,
	fetchImpl: Fetch,
	signal: AbortSignal | undefined,
	timeoutMs = WEB_TIMEOUT_MS,
): Promise<Result> {
	const protocol = URL.parse(url)?.protocol;
	if (protocol !== "http:" && protocol !== "https:") return failure(`Only http and https URLs can be fetched: ${url}`);
	let response: Response;
	let body: string;
	let cut: boolean;
	try {
		response = await fetchImpl(url, { signal: withTimeout(signal, timeoutMs) });
		({ body, cut } = await readBody(response));
	} catch (error) {
		return failure(`Could not fetch ${url}: ${reasonOf(error, timeoutMs)}`);
	}
	if (!response.ok)
		return failure(`${url} answered ${[response.status, response.statusText].filter(Boolean).join(" ")}.`);
	const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
	if (body.trim() === "") return failure(`${url} answered with an empty page.`);
	const note = cut ? `\n\n[Read only the first ${FETCH_MAX_BYTES / 1024} KB of the page.]` : "";
	if (type.includes("html")) {
		try {
			const { document } = parseHTML(body);
			// Async extractors call third-party APIs that the timeout above does not cover.
			const page = await Defuddle(document, url, { markdown: true, useAsync: false });
			const text = `${page.title ? `# ${page.title}\n\n` : ""}${url}\n\n${page.content}`;
			return { text: cap(text) + note, isError: false };
		} catch {
			return failure(`${url} could not be parsed as HTML.`);
		}
	}
	if (type.startsWith("text/") || type.includes("json") || type.includes("xml"))
		return { text: cap(`${url}\n\n${body}`) + note, isError: false };
	return failure(`${url} is ${type || "of no stated type"}, not a text page.`);
}

const ExaAnswer = z.object({
	results: z.array(
		z.object({
			title: z.string().nullish(),
			url: z.string(),
			publishedDate: z.string().nullish(),
			highlights: z.array(z.string()).nullish(),
		}),
	),
});

/** Exa's results as numbered plain text; the key is scrubbed from every failure, whatever echoed it. */
export async function search(
	query: string,
	limit: number | undefined,
	key: string,
	fetchImpl: Fetch,
	signal: AbortSignal | undefined,
	timeoutMs = WEB_TIMEOUT_MS,
): Promise<Result> {
	const failed = (reason: string) => failure(`Search failed: ${reason}`.replaceAll(key, "[key]"));
	let response: Response;
	let body: string;
	try {
		response = await fetchImpl("https://api.exa.ai/search", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": key },
			body: JSON.stringify({
				query,
				numResults: Math.min(Math.max(Math.trunc(limit ?? SEARCH_DEFAULT_RESULTS), 1), SEARCH_MAX_RESULTS),
				contents: { highlights: true },
			}),
			signal: withTimeout(signal, timeoutMs),
		});
		({ body } = await readBody(response));
	} catch (error) {
		return failed(reasonOf(error, timeoutMs));
	}
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		json = undefined;
	}
	if (!response.ok) {
		const status = [response.status, response.statusText].filter(Boolean).join(" ");
		const detail = z.object({ error: z.string() }).safeParse(json);
		return failed(detail.success ? `${status}: ${detail.data.error}` : status);
	}
	const answer = ExaAnswer.safeParse(json);
	if (!answer.success) return failed("the search provider's answer was not in the expected shape");
	if (answer.data.results.length === 0) return { text: `No results for: ${query}`, isError: false };
	const entries = answer.data.results.map((result, i) =>
		[
			`${i + 1}. ${result.title || result.url}`,
			result.url,
			...(result.publishedDate ? [result.publishedDate.slice(0, 10)] : []),
			...(result.highlights ?? []),
		].join("\n   "),
	);
	return { text: entries.join("\n\n"), isError: false };
}

export function web(options: { fetch?: Fetch; exaApiKey?: string } = {}) {
	const fetchImpl = options.fetch ?? fetch;
	const webFetch = defineTool({
		name: "web_fetch",
		description:
			"Read one web page. Returns its main content as markdown without navigation or ads, or the body as it is " +
			`for plain text and JSON. Long pages are cut at ${FETCH_MAX_CHARS} characters.`,
		parameters: obj({ url: str({ description: "An http or https URL" }) }),
		replay: "safe",
		execute: async ({ url }, _api, context) => {
			const { text, isError } = await fetchPage(url, fetchImpl, context.abortSignal);
			return { output: [{ type: "text" as const, text }], isError };
		},
	});
	const { exaApiKey } = options;
	const webSearch =
		exaApiKey &&
		defineTool({
			name: "web_search",
			description:
				"Search the web for current information. Returns numbered results, each with title, URL, date when known " +
				"and the passages most relevant to the query. Read a result in full with web_fetch.",
			parameters: obj({
				query: str({ description: "What to look for, in natural language" }),
				limit: opt(
					int({
						minimum: 1,
						maximum: SEARCH_MAX_RESULTS,
						description: `How many results, ${SEARCH_DEFAULT_RESULTS} unless set`,
					}),
				),
			}),
			replay: "safe",
			execute: async ({ query, limit }, _api, context) => {
				const { text, isError } = await search(query, limit, exaApiKey, fetchImpl, context.abortSignal);
				return { output: [{ type: "text" as const, text }], isError };
			},
		});
	return defineExtension({ name: "soma.web", tools: webSearch ? [webSearch, webFetch] : [webFetch] });
}
