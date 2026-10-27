import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
import type { Duplex } from "node:stream";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { type HumanPort, PUSHED_FAILURES, type SomaEvent } from "../../ports/human.ts";

export interface WebConfig {
	/** An IP literal: the server listens on this one address, never on every interface. */
	readonly host: string;
	readonly port: number;
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
/** The entry kind of this client's inputs, which the core names as a push's target when it means the page. */
const ENTRY_KIND = "chat.web";
// Rounds started by these sources produce something the human did not ask for here: show them as notices.
// A digest round is not among them: its report arrives as a notice entry of its own.
const PUSHED_SOURCES = ["schedule:"];
export const SOCKET_PATH = "/socket";
/** A larger message closes the connection: typed text is far smaller, and nothing else is buffered without bound. */
export const MAX_MESSAGE_BYTES = 1 << 20;
const HEARTBEAT_MS = 30_000;

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

const page = (name: string) => readFileSync(new URL(`./page/${name}`, import.meta.url));
const FILES: Record<string, { type: string; body: Buffer }> = {
	"/": { type: "text/html; charset=utf-8", body: page("index.html") },
	"/character.svg": { type: "image/svg+xml", body: page("character.svg") },
};

// The page names each message with 128 random bits in hex; a resend keeps the id, so the core admits it once.
const InputSchema = z
	.object({ type: z.literal("input"), id: z.string().regex(/^[0-9a-f]{32}$/), text: z.string().min(1).max(100_000) })
	.strict();

/** What the page receives; `loud` is false on a push the core meant for another interface. */
export type WebMessage =
	| { readonly type: "accepted"; readonly id: string }
	| { readonly type: "answer"; readonly id: string; readonly text: string }
	| { readonly type: "failure"; readonly id?: string; readonly text: string; readonly loud: boolean }
	| { readonly type: "notice"; readonly kind: "question" | "report"; readonly text: string; readonly loud: boolean }
	| { readonly type: "run"; readonly state: "working" | "idle" }
	| { readonly type: "error"; readonly text: string };

/**
 * The web client: one page and a WebSocket on one address. Each message the page sends is an input; answers and
 * failures of the page's inputs, failures of rounds the core started, and notices go to every page open then. A push the
 * core meant for another interface is shown without ringing, as the terminal does. The `web:` prefix, not a set of ids
 * sent from here, marks this client's rounds, so a round the core finishes after a restart still reaches the page.
 * A page that stops answering pings is dropped and unsubscribed; closing the server drops every page at once, so a page
 * left open cannot hold shutdown. Resolves once listening.
 */
export async function startWeb(options: WebOptions): Promise<WebServer> {
	const { human, host } = options;
	checkHost(host);
	const onError = options.onError ?? ((error) => console.error("[soma] web:", error));
	const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
	// Binary frames are refused and extensions are not offered, so a page sends plain text frames only.
	const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
	/** Whether each page answered the last ping. */
	const alive = new WeakMap<WebSocket, boolean>();
	const sendTo = (socket: WebSocket, message: WebMessage) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
	};

	const loud = ({ target }: { target?: string }) => target === undefined || target === ENTRY_KIND;
	/** What one page is sent of an event, if anything. */
	const toMessage = (event: SomaEvent): WebMessage | undefined => {
		const mine = "requestId" in event && event.requestId.startsWith(REQUEST_PREFIX);
		const id = mine ? event.requestId.slice(REQUEST_PREFIX.length) : "";
		if (event.type === "run") return { type: "run", state: event.state };
		if (event.type === "notice") {
			return event.kind === "forwarded"
				? undefined
				: { type: "notice", kind: event.kind, text: event.content, loud: loud(event) };
		}
		if (event.type === "answer") {
			if (mine) return { type: "answer", id, text: event.content };
			if (PUSHED_SOURCES.some((source) => event.requestId.startsWith(source)))
				return { type: "notice", kind: "report", text: event.content, loud: true };
		} else if (event.type === "failure") {
			if (mine) return { type: "failure", id, text: event.reason, loud: true };
			if (PUSHED_FAILURES.some((source) => event.requestId.startsWith(source)))
				return { type: "failure", text: `${event.requestId} 那一輪：${event.reason}`, loud: loud(event) };
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
		const input = InputSchema.safeParse(parsed);
		if (!input.success) return sendTo(socket, { type: "error", text: "not an input" });
		const { id } = input.data;
		try {
			await human.submit({ content: input.data.text, entry: { kind: ENTRY_KIND }, requestId: REQUEST_PREFIX + id });
			sendTo(socket, { type: "accepted", id });
		} catch (error) {
			onError(error);
			sendTo(socket, { type: "failure", id, text: `沒有送出：${(error as Error).message}`, loud: true });
		}
	};

	const server = createServer((request, response) => {
		const file = FILES[request.url ?? ""];
		if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405, { allow: "GET, HEAD" }).end();
		} else if (file === undefined) {
			response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found\n");
		} else {
			response.writeHead(200, {
				"content-type": file.type,
				"content-length": file.body.length,
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
			});
			response.end(request.method === "HEAD" ? undefined : file.body);
		}
	});

	let authority = "";
	// A browser opens a WebSocket to any address a page names, whatever site the page came from: only the page served
	// here, under the address configured, may open one. A client without an Origin is not a browser page.
	const allowed = (request: IncomingMessage) =>
		request.url === SOCKET_PATH &&
		request.headers.host === authority &&
		(request.headers.origin === undefined || request.headers.origin === `http://${authority}`);
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
