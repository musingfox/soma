import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import { z } from "zod";
import { createRexClient, RexRpcError, RexTransportError } from "../../../src/adapters/rex/client.ts";
import type { SessionEvent } from "../../../src/adapters/rex/schema.ts";
import { acceptKey, createFrameDecoder, encodeFrame, OPCODE } from "../../../src/adapters/rex/websocket.ts";

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
