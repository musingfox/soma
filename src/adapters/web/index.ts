import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { BlockList, isIP } from "node:net";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { gzipSync } from "node:zlib";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { deliveryTo, type HumanPort, isPrompt, type SaidChoices, type SomaEvent } from "../../ports/human.ts";
import { readableFailure } from "./failure.ts";

/** Serve mode: soma is behind `tailscale serve`, which terminates HTTPS and says who the caller is. */
export interface ServeConfig {
	/** The page's public origin, such as `https://nick-mac-mini.tail361ef.ts.net:8445`: the only Host and Origin accepted. */
	readonly origin: string;
	/** The one `Tailscale-User-Login` allowed, such as `musingfox@github`. */
	readonly login: string;
}

export interface WebConfig {
	/** An IP literal: the server listens on this one address, never on every interface. Loopback in serve mode. */
	readonly host: string;
	readonly port: number;
	/** Set, the server trusts the login header `tailscale serve` adds, so `host` must be 127.0.0.1. */
	readonly serve?: ServeConfig;
}

export interface WebOptions extends WebConfig {
	readonly human: HumanPort;
	readonly onError?: (error: unknown) => void;
	/** Milliseconds between pings; a page that has not answered the last one by the next is dropped. Default 30 s. */
	readonly heartbeatMs?: number;
}

export interface WebServer {
	/** The port it listens on, which a port of 0 leaves to the system. */
	readonly port: number;
	close(): Promise<void>;
}

const REQUEST_PREFIX = "web:";
/** The entry kind of this client's inputs, by which the core says what the page does with each push. */
export const ENTRY_KIND = "chat.web";
/** What the page shows of what the model writes, told to the model in the system prompt. */
export const ABILITIES = [
	"網頁（狐狸的對話泡泡）：markdown 會顯示成格式：標題、粗體、斜體、刪除線、行內程式碼與程式碼區塊、清單、引用、分隔線、表格（太寬時在泡泡裡橫向捲動），以及 http 或 https 的連結。",
	"原始 HTML 一律當文字顯示，所以 `<details>` 不會折疊；圖片只顯示描述文字，不載入。",
	"文字先逐字出現（最多 4 秒）再換成格式；泡泡依長度停留 6 到 45 秒（頁面在眼前時才計時），點一下或時間到就淡出，頁面上不留紀錄。附選項、還在等人按的泡泡不會自己淡出，選定後才開始計時，點泡泡（按鈕以外）仍會讓它淡出。沒有長度上限，但泡泡不大，長文要捲動。",
	"你用 `ask` 問的問題，選項會在泡泡裡顯示成按鈕，人按一個就是回答。",
].join("\n");
export const SOCKET_PATH = "/socket";
/** A larger message closes the connection: typed text is far smaller, and nothing else is buffered without bound. */
export const MAX_MESSAGE_BYTES = 1 << 20;
const HEARTBEAT_MS = 30_000;
/** The header `tailscale serve` sets from the tailnet's own identity, replacing any the client sent. */
export const LOGIN_HEADER = "tailscale-user-login";
export const SERVE_HOST = "127.0.0.1";

const wildcard = new BlockList();
wildcard.addAddress("0.0.0.0", "ipv4");
wildcard.addAddress("::", "ipv6");

/** Throws unless `host` is one IP address: a name may resolve to several, and a wildcard listens on every interface. */
export function checkHost(host: string): void {
	const family = isIP(host);
	if (family === 0) throw new Error(`web host must be an IP address, got "${host}"`);
	if (wildcard.check(host, family === 4 ? "ipv4" : "ipv6")) {
		throw new Error(`web host must not be a wildcard address, got "${host}"`);
	}
}

interface StaticFile {
	readonly type: string;
	readonly body: Buffer;
	readonly gzipped: Buffer;
	readonly etag: string;
}

const staticFile = (type: string, body: Buffer): StaticFile => ({
	type,
	body,
	gzipped: gzipSync(body),
	etag: `"${createHash("sha256").update(body).digest("base64url")}"`,
});
const JS = "text/javascript; charset=utf-8";
/** The page's own ES modules, each served at its name. */
export const PAGE_MODULES = ["page.js", "markdown.js", "choices.js", "scene.js", "fox.js", "room.js", "shapes.js"];
const page = (name: string) => readFileSync(new URL(`./page/${name}`, import.meta.url));
// The package's own published ES modules, served as they are; three.module.js imports ./three.core.js beside it.
const threeBuild = dirname(createRequire(import.meta.url).resolve("three"));
/** Where the page's import map finds three.js. */
export const THREE_PATH = "/vendor/three/";
// marked's ES build, one file with no import of its own; the page's markdown.js lexes with it and builds DOM nodes itself.
const markedBuild = dirname(createRequire(import.meta.url).resolve("marked"));
/** Where the page's import map finds marked. */
export const MARKED_PATH = "/vendor/marked/";

/** Every path the server answers, and nothing else: a URL is looked up whole, never joined onto a directory. */
const FILES = new Map<string, StaticFile>([
	["/", staticFile("text/html; charset=utf-8", page("index.html"))],
	["/house.css", staticFile("text/css; charset=utf-8", page("house.css"))],
	...PAGE_MODULES.map((name): [string, StaticFile] => [`/${name}`, staticFile(JS, page(name))]),
	...["three.module.js", "three.core.js"].map((name): [string, StaticFile] => [
		THREE_PATH + name,
		staticFile(JS, readFileSync(join(threeBuild, name))),
	]),
	[`${MARKED_PATH}marked.esm.js`, staticFile(JS, readFileSync(join(markedBuild, "marked.esm.js")))],
]);

// The page names each message with 128 random bits in hex; a resend keeps the id, so the core admits it once.
const MessageId = z.string().regex(/^[0-9a-f]{32}$/);
const InputSchema = z
	.object({ type: z.literal("input"), id: MessageId, text: z.string().min(1).max(100_000) })
	.strict();
// A press on an option of a question soma asked; the core knows the question and its labels.
const SaySchema = z
	.object({
		type: z.literal("say"),
		id: MessageId,
		question: z.string().min(1).max(64),
		option: z.string().min(1).max(8),
	})
	.strict();
const PageSchema = z.discriminatedUnion("type", [InputSchema, SaySchema]);

/** What the page receives; `loud` is false on a push the core meant for another interface. */
export type WebMessage =
	| { readonly type: "accepted"; readonly id: string }
	// `asked`: the round asked a question in reply here, which rang: the answer does not, and with no text shows nothing.
	| { readonly type: "answer"; readonly id: string; readonly text: string; readonly asked?: true }
	| { readonly type: "failure"; readonly id?: string; readonly text: string; readonly loud: boolean }
	| {
			readonly type: "notice";
			readonly kind: "question" | "report";
			readonly text: string;
			readonly loud: boolean;
			// The options of a question soma asked, offered as buttons; a prompt's are not offered here yet.
			readonly choices?: SaidChoices;
	  }
	// A question's option was said, here or elsewhere; `id` names this page's press the core found already settled.
	| { readonly type: "said"; readonly question: string; readonly label: string; readonly id?: string }
	| { readonly type: "run"; readonly state: "working" | "idle" }
	| { readonly type: "error"; readonly text: string };

/**
 * The web client: one page and a WebSocket on one address. Each message the page sends is an input, typed or the press
 * of an option of a question soma asked; answers and failures of the page's inputs, failures of rounds the core
 * started, notices and the options said go to every page open then. A push the
 * core meant for another interface is shown without ringing, as the terminal does. The `web:` prefix, not a set of ids
 * sent from here, marks this client's rounds, so a round the core finishes after a restart still reaches the page.
 * A page that stops answering pings is dropped and unsubscribed; closing the server drops every page at once, so a page
 * left open cannot hold shutdown. Resolves once listening.
 */
export async function startWeb(options: WebOptions): Promise<WebServer> {
	const { human, host, serve } = options;
	checkHost(host);
	// The login header is trusted only because `tailscale serve` strips the client's and sets its own, which holds when
	// serve is the one connecting: serve mode listens on loopback and nowhere else.
	if (serve !== undefined && host !== SERVE_HOST) {
		throw new Error(`web serve mode must listen on ${SERVE_HOST}, got "${host}"`);
	}
	const serveAuthority = serve === undefined ? undefined : new URL(serve.origin).host;
	/** In serve mode, whether the Host is the origin's and the login is the configured one; always true otherwise. */
	const permitted = (request: IncomingMessage) =>
		serve === undefined || (request.headers[LOGIN_HEADER] === serve.login && request.headers.host === serveAuthority);
	const onError = options.onError ?? ((error) => console.error("[soma] web:", error));
	const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
	// Binary frames are refused and extensions are not offered, so a page sends plain text frames only.
	const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
	/** Whether each page answered the last ping. */
	const alive = new WeakMap<WebSocket, boolean>();
	const sendTo = (socket: WebSocket, message: WebMessage) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
	};

	/** What one page is sent of an event, if anything. A push the core leaves to the history here is not sent. */
	const toMessage = (event: SomaEvent): WebMessage | undefined => {
		const mine = "requestId" in event && event.requestId.startsWith(REQUEST_PREFIX);
		const id = mine ? event.requestId.slice(REQUEST_PREFIX.length) : "";
		if (event.type === "run") return { type: "run", state: event.state };
		if (event.type === "notice") {
			if (event.kind === "forwarded") return undefined;
			const delivery = deliveryTo(event, ENTRY_KIND);
			const { choices } = event;
			return delivery === "log"
				? undefined
				: {
						type: "notice",
						kind: event.kind,
						text: event.content,
						loud: delivery === "ring",
						...(choices !== undefined && !isPrompt(choices) && { choices }),
					};
		}
		if (event.type === "said") return { type: "said", question: event.question, label: event.label };
		if (event.type === "answer") {
			if (mine) return { type: "answer", id, text: event.content, ...(event.asked && { asked: true }) };
			const delivery = deliveryTo(event, ENTRY_KIND);
			if (event.class !== undefined && delivery !== "log")
				return { type: "notice", kind: "report", text: event.content, loud: delivery === "ring" };
		} else if (event.type === "failure") {
			if (mine) return { type: "failure", id, text: readableFailure(event.reason), loud: true };
			const delivery = deliveryTo(event, ENTRY_KIND);
			if (event.class !== undefined && delivery !== "log")
				return {
					type: "failure",
					text: `${event.requestId} 那一輪：${readableFailure(event.reason)}`,
					loud: delivery === "ring",
				};
		}
		return undefined;
	};

	const receive = async (socket: WebSocket, text: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return sendTo(socket, { type: "error", text: "not JSON" });
		}
		const message = PageSchema.safeParse(parsed);
		if (!message.success) return sendTo(socket, { type: "error", text: "not an input" });
		const { id } = message.data;
		const requestId = REQUEST_PREFIX + id;
		try {
			if (message.data.type === "input") {
				await human.submit({ content: message.data.text, entry: { kind: ENTRY_KIND }, requestId });
				return sendTo(socket, { type: "accepted", id });
			}
			const { question, option } = message.data;
			const outcome = await human.say(question, option, { entry: { kind: ENTRY_KIND }, requestId });
			if (outcome.said) return sendTo(socket, { type: "accepted", id });
			if (outcome.refusal === "settled") return sendTo(socket, { type: "said", question, label: outcome.label, id });
			const reason = outcome.refusal === "no_question" ? "找不到這個問題" : "沒有這個選項";
			sendTo(socket, { type: "failure", id, text: `沒有送出：${reason}`, loud: true });
		} catch (error) {
			onError(error);
			sendTo(socket, { type: "failure", id, text: `沒有送出：${(error as Error).message}`, loud: true });
		}
	};

	const server = createServer((request, response) => {
		const file = FILES.get(request.url ?? "");
		if (!permitted(request)) {
			response.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("forbidden\n");
		} else if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405, { allow: "GET, HEAD" }).end();
		} else if (file === undefined) {
			response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found\n");
		} else {
			// Revalidated on every load, so a release's new page is never mixed with an old one, while an unchanged
			// three.js, two megabytes unzipped, is not sent to the phone again.
			const headers = {
				"cache-control": "no-cache",
				etag: file.etag,
				vary: "accept-encoding",
				"x-content-type-options": "nosniff",
			};
			if (request.headers["if-none-match"] === file.etag) {
				response.writeHead(304, headers).end();
				return;
			}
			const gzip = /\bgzip\b/.test(request.headers["accept-encoding"] ?? "");
			const body = gzip ? file.gzipped : file.body;
			response.writeHead(200, {
				...headers,
				"content-type": file.type,
				"content-length": body.length,
				...(gzip && { "content-encoding": "gzip" }),
			});
			response.end(request.method === "HEAD" ? undefined : body);
		}
	});

	let authority = "";
	// A browser opens a WebSocket to any address a page names, whatever site the page came from: only the page served
	// here, under the address configured, may open one. A client without an Origin is not a browser page.
	const allowed = (request: IncomingMessage) =>
		request.url === SOCKET_PATH &&
		permitted(request) &&
		request.headers.host === (serveAuthority ?? authority) &&
		(request.headers.origin === undefined || request.headers.origin === (serve?.origin ?? `http://${authority}`));
	let closing = false;
	server.on("upgrade", (request: IncomingMessage, raw: Duplex, head: Buffer) => {
		if (closing) {
			raw.destroy();
		} else if (!allowed(request)) {
			raw.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
		} else {
			// A request that is not a WebSocket version 13 one gets a 400 from handleUpgrade.
			sockets.handleUpgrade(request, raw, head, (socket) => {
				alive.set(socket, true);
				socket.on("pong", () => alive.set(socket, true));
				// The close event follows an error and does the cleanup; a failed page needs no log line.
				socket.on("error", () => {});
				socket.on("message", (data: RawData, isBinary: boolean) => {
					if (isBinary) return socket.close(1003);
					void receive(socket, (data as Buffer).toString("utf8"));
				});
				// Each open page is a subscriber of its own, so it gets soma's run state at once, and the notices the core
				// held for its first subscriber go to an interface that was there at startup, not to a page that may never open.
				const unsubscribe = human.subscribe((event) => {
					const message = toMessage(event);
					if (message !== undefined) sendTo(socket, message);
				});
				socket.once("close", unsubscribe);
			});
		}
	});

	// A peer that vanished without a close (the phone left the network) keeps its TCP connection for hours: ping every
	// page, and drop the one that has not answered the last ping.
	const heartbeat = setInterval(() => {
		for (const socket of sockets.clients) {
			if (alive.get(socket) === false) {
				socket.terminate();
			} else {
				alive.set(socket, false);
				socket.ping();
			}
		}
	}, heartbeatMs);

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host, port: options.port, exclusive: true }, () => {
			server.off("error", reject);
			resolve();
		});
	});
	server.on("error", onError);
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : options.port;
	authority = isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;

	let closed: Promise<void> | undefined;
	return {
		port,
		// close() would wait for each page to answer its close frame, and a page that is gone never does.
		close: () => {
			closed ??= new Promise<void>((resolve) => {
				closing = true;
				clearInterval(heartbeat);
				for (const socket of sockets.clients) socket.terminate();
				sockets.close();
				server.close(() => resolve());
				server.closeAllConnections();
			});
			return closed;
		},
	};
}
