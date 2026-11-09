/**
 * Worker entry for `fetchPage`: parses each page it is sent with linkedom and Defuddle and answers with its title and
 * markdown content, or with no page when the parse threw.
 */
import { parentPort } from "node:worker_threads";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";

export type ParseRequest = { id: number; html: string; url: string };
export type ParseAnswer = { id: number; page?: { title: string; content: string } };

parentPort?.on("message", async ({ id, html, url }: ParseRequest) => {
	let answer: ParseAnswer = { id };
	try {
		const { document } = parseHTML(html);
		// Async extractors call third-party APIs that the fetch timeout does not cover.
		const page = await Defuddle(document, url, { markdown: true, useAsync: false });
		answer = { id, page: { title: page.title, content: page.content } };
	} catch {}
	parentPort?.postMessage(answer);
});
