import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";

export const FETCH_MAX_CHARS = 20_000;
export const WEB_TIMEOUT_MS = 15_000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type Result = { text: string; isError: boolean };

const failure = (text: string): Result => ({ text, isError: true });

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
	try {
		response = await fetchImpl(url, {
			signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
		});
		body = await response.text();
	} catch (error) {
		const reason =
			error instanceof Error && error.name === "TimeoutError"
				? `no answer within ${timeoutMs / 1000} s`
				: error instanceof Error
					? error.message
					: String(error);
		return failure(`Could not fetch ${url}: ${reason}`);
	}
	if (!response.ok)
		return failure(`${url} answered ${[response.status, response.statusText].filter(Boolean).join(" ")}.`);
	const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
	if (type.includes("html")) {
		const { document } = parseHTML(body);
		// Async extractors call third-party APIs that the timeout above does not cover.
		const page = await Defuddle(document, url, { markdown: true, useAsync: false });
		return { text: cap(`${page.title ? `# ${page.title}\n\n` : ""}${url}\n\n${page.content}`), isError: false };
	}
	if (type.startsWith("text/") || type.includes("json") || type.includes("xml") || type === "")
		return { text: cap(`${url}\n\n${body}`), isError: false };
	return failure(`${url} is ${type}, not a text page.`);
}

export function web(options: { fetch?: Fetch } = {}) {
	const fetchImpl = options.fetch ?? fetch;
	const webFetch = defineTool({
		name: "web_fetch",
		description:
			"Read one web page. Returns its main content as markdown without navigation or ads, or the body as it is " +
			`for plain text and JSON. Long pages are cut at ${FETCH_MAX_CHARS} characters.`,
		parameters: Type.Object({ url: Type.String({ description: "An http or https URL" }) }),
		replay: "safe",
		execute: async ({ url }, _api, context) => {
			const { text, isError } = await fetchPage(url, fetchImpl, context.abortSignal);
			return { output: [{ type: "text" as const, text }], isError };
		},
	});
	return defineExtension({ name: "soma.web", tools: [webFetch] });
}
