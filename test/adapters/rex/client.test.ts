import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import { z } from "zod";
import { createRexClient, RexRpcError, RexTransportError } from "../../../src/adapters/rex/client.ts";
import type { SessionEvent } from "../../../src/adapters/rex/schema.ts";
import {
	acceptKey,
	createFrameDecoder,
	encodeFrame,
	OPCODE,
	type OpenWebSocket,
} from "../../../src/adapters/rex/websocket.ts";

const dir = mkdtempSync(join(tmpdir(), "soma-rex-client-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let sockets = 0;

type Peer = { send(message: object): void; drop(): void };
type Request = { id: string; method: string; payload?: Record<string, unknown> };

/** A rex control endpoint: it answers the hello, then hands each request to `answer`. */
function fakeRex(answer: (request: Request, peer: Peer) => object | undefined) {
	const path = join(dir, `rex-${sockets++}.sock`);
	const hellos: Record<string, unknown>[] = [];
	const requests: Request[] = [];
	const peers: Peer[] = [];
	const server: Server = createServer((_req, res) => res.writeHead(404).end());
	server.on("upgrade", (req, socket: Socket) => {
		const key = String(req.headers["sec-websocket-key"]);
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${acceptKey(key)}\r\nSec-WebSocket-Protocol: ${req.headers["sec-websocket-protocol"]}\r\n\r\n`,
		);
		const peer: Peer = {
			send: (message) => socket.write(encodeFrame(OPCODE.text, Buffer.from(JSON.stringify(message)), false)),
			drop: () => socket.destroy(),
		};
		peers.push(peer);
		const decode = createFrameDecoder();
		let welcomed = false;
		socket.on("error", () => {});
		socket.on("data", (chunk: Buffer) => {
			for (const frame of decode(chunk)) {
				if (frame.opcode !== OPCODE.text) continue;
				const message = JSON.parse(frame.payload.toString("utf8"));
				if (!welcomed) {
					welcomed = true;
					hellos.push(message);
					peer.send({
						type: "welcome",
						protocol: "rex.control.v1",
						limits: { max_message_bytes: 1 << 20 },
						api_revision: 7,
					});
					continue;
				}
				requests.push(message);
				const reply = answer(message, peer);
				if (reply !== undefined) peer.send({ type: "response", id: message.id, seq: 0, ...reply });
			}
		});
	});
	const listening = new Promise<void>((resolve) => server.listen(path, resolve));
	const close = () =>
		new Promise((resolve) => {
			for (const peer of peers) peer.drop();
			server.close(resolve);
		});
	return { path, hellos, requests, peers, listening, close };
}

type FakePeer = { message(message: object): void; close(error?: Error): void };

/**
 * An `open` with no socket: each attempt hands every frame soma sends to `serve(attempt)`, which may answer and close in
 * one synchronous step, as frames that came in one chunk are.
 */
function fakeOpen(serve: (attempt: number) => (message: Request & { type: string }, peer: FakePeer) => void) {
	let attempts = 0;
	const peers: FakePeer[] = [];
	const open: OpenWebSocket = async (_options, handlers) => {
		const handle = serve(++attempts);
		let closed = false;
		const peer: FakePeer = {
			message: (message) => handlers.onMessage(JSON.stringify(message)),
			close(error) {
				if (closed) return;
				closed = true;
				handlers.onClose(error);
			},
		};
		peers.push(peer);
		return {
			send(text) {
				if (closed) throw new Error("WebSocket is closed");
				handle(JSON.parse(text), peer);
			},
			close: () => peer.close(),
			ref() {},
			unref() {},
		};
	};
	return { open, peers, attempts: () => attempts };
}

const welcome = {
	type: "welcome",
	protocol: "rex.control.v1",
	limits: { max_message_bytes: 1 << 20 },
	api_revision: 7,
};
const view = { client_id: "client:1", view: { revision: 0, session_id: "session:h", windows: [] } };
const closers: (() => unknown)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

test("the hello names API revision 7, and a response is matched to its request by id", async () => {
	const rex = fakeRex((request) => ({ payload: { echoed: request.method } }));
	await rex.listening;
	const client = createRexClient({ socketPath: rex.path });
	closers.push(() => client.close(), rex.close);

	const [a, b] = await Promise.all([
		client.call("server.version", {}, z.object({ echoed: z.string() })),
		client.call("server.status", {}, z.object({ echoed: z.string() })),
	]);

	expect(a).toEqual({ echoed: "server.version" });
	expect(b).toEqual({ echoed: "server.status" });
	expect(rex.hellos).toEqual([{ type: "hello", api_revision: 7, client: { kind: "agent", name: "soma" } }]);
	expect(rex.requests.map(({ type, method }: Request & { type?: string }) => [type, method])).toEqual([
		["request", "server.version"],
		["request", "server.status"],
	]);
});

test("an error response rejects with its code", async () => {
	const rex = fakeRex(() => ({ error: { code: "session_not_found", message: "no session", status: 404 } }));
	await rex.listening;
	const client = createRexClient({ socketPath: rex.path });
	closers.push(() => client.close(), rex.close);

	const failed = client.call("session.view", { session_id: "session:x" }, z.object({}));

	await expect(failed).rejects.toBeInstanceOf(RexRpcError);
	await expect(failed).rejects.toMatchObject({ code: "session_not_found", status: 404 });
});

test("a dropped connection is opened again while events are listened to, attached again, then announced", async () => {
	const rex = fakeRex((request) => (request.method === "session.attach" ? { payload: view } : { payload: {} }));
	await rex.listening;
	const client = createRexClient({ socketPath: rex.path, reconnectMs: 5, onError: () => {} });
	closers.push(() => client.close(), rex.close);
	const events: SessionEvent[] = [];
	client.onSessionEvent((event) => events.push(event));
	let connections = 0;
	const reconnected = new Promise<void>((resolve) =>
		client.onConnected(() => {
			connections += 1;
			if (connections === 2) resolve();
		}),
	);

	await client.attach("session:h");
	const blockEvent = {
		session_id: "session:h",
		event: { type: "block_event", payload: { block_id: "block:a", name: "bell", payload: {} } },
	};
	rex.peers[0]?.send({ type: "event", seq: 1, payload: { type: "session_event", payload: blockEvent } });
	await new Promise((resolve) => setTimeout(resolve, 20));
	rex.peers[0]?.drop();
	await reconnected;

	expect(events).toEqual([blockEvent]);
	expect(rex.hellos).toHaveLength(2);
	expect(rex.requests.filter((request) => request.method === "session.attach")).toHaveLength(2);
});

test("a session rex says does not exist is attached no more, so it fails no connection opened after", async () => {
	const gone = new Set(["session:gone"]);
	const rex = fakeRex((request) => {
		if (request.method !== "session.attach") return { payload: {} };
		return gone.has(String(request.payload?.session_id))
			? { error: { code: "session_not_found", message: "no session", status: 404 } }
			: { payload: view };
	});
	await rex.listening;
	const errors: string[] = [];
	const client = createRexClient({
		socketPath: rex.path,
		reconnectMs: 5,
		onError: (error) => errors.push(error.message),
	});
	closers.push(() => client.close(), rex.close);
	client.onSessionEvent(() => {});
	let connections = 0;
	client.onConnected(() => {
		connections += 1;
	});
	const opened = async (count: number) => {
		while (connections < count) await new Promise((resolve) => setTimeout(resolve, 5));
	};
	const attaches = () =>
		rex.requests.filter((request) => request.method === "session.attach").map((request) => request.payload?.session_id);

	await expect(client.attach("session:gone")).rejects.toMatchObject({ code: "session_not_found" });
	await client.attach("session:h");
	await opened(1);
	// Gone while attached: the next connection finds it so, and the one after does not ask.
	gone.add("session:h");
	rex.peers[0]?.drop();
	await opened(2);
	rex.peers[1]?.drop();
	await opened(3);

	expect(attaches()).toEqual(["session:gone", "session:h", "session:h"]);
	expect(errors.filter((message) => message.includes("session_not_found"))).toEqual([]);
});

test("a request in flight when the connection drops rejects as a transport error", async () => {
	const rex = fakeRex((_request, peer) => {
		peer.drop();
		return undefined;
	});
	await rex.listening;
	const client = createRexClient({ socketPath: rex.path });
	closers.push(() => client.close(), rex.close);

	await expect(client.call("session.view", {}, z.object({}))).rejects.toBeInstanceOf(RexTransportError);
});

/** A rex that welcomes, answers every request with `{ ok: true }` and a `session.attach` with a view. */
const serving = (message: Request & { type: string }, peer: FakePeer) => {
	if (message.type === "hello") peer.message(welcome);
	else
		peer.message({
			type: "response",
			id: message.id,
			seq: 0,
			payload: message.method === "session.attach" ? view : { ok: true },
		});
};
const ok = z.object({ ok: z.literal(true) });

test("a connection closed in its welcome's own chunk counts as dropped, and is opened again", async () => {
	const rex = fakeOpen((attempt) => (message, peer) => {
		serving(message, peer);
		if (attempt === 1) peer.close(new Error("WebSocket closed by the server: 1001 going away"));
	});
	const client = createRexClient({ socketPath: "unused", open: rex.open, reconnectMs: 5, onError: () => {} });
	closers.push(() => client.close());
	client.onSessionEvent(() => {});
	const connected = new Promise<void>((resolve) => client.onConnected(resolve));

	await expect(client.attach("session:h")).rejects.toThrow(/^rex connection closed: WebSocket closed by the server/);
	await connected;

	await expect(client.call("x", {}, ok)).resolves.toEqual({ ok: true });
	expect(rex.attempts()).toBe(2);
});

test("a connection closed in its attach's own chunk is not handed out", async () => {
	const rex = fakeOpen((attempt) => (message, peer) => {
		serving(message, peer);
		if (attempt === 2 && message.method === "session.attach") peer.close();
	});
	const client = createRexClient({ socketPath: "unused", open: rex.open, reconnectMs: 5, onError: () => {} });
	closers.push(() => client.close());
	await client.attach("session:h");
	rex.peers[0]?.close(new Error("WebSocket connection dropped"));

	await expect(client.call("x", {}, ok)).rejects.toThrow(/^rex connection closed$/);
	await expect(client.call("x", {}, ok)).resolves.toEqual({ ok: true });
	expect(rex.attempts()).toBe(3);
});

test("frames round-trip through the codec at every length encoding", () => {
	const decode = createFrameDecoder();
	for (const length of [0, 125, 126, 65_535, 65_536]) {
		const payload = Buffer.alloc(length, 7);
		const encoded = encodeFrame(OPCODE.text, payload, true);
		// Fed in two halves: a frame cut short waits for the rest.
		const half = Math.floor(encoded.length / 2);
		expect(decode(encoded.subarray(0, half))).toEqual([]);
		const [frame] = decode(encoded.subarray(half));
		expect(frame?.payload.equals(payload)).toBe(true);
		expect(frame?.fin).toBe(true);
	}
});
