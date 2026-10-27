import { request } from "node:http";
import { connect } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import { FakeHumanPort } from "../../../src/adapters/fake-human/index.ts";
import {
	checkHost,
	MAX_MESSAGE_BYTES,
	startWeb,
	type WebMessage,
	type WebServer,
} from "../../../src/adapters/web/index.ts";

const HOST = "127.0.0.1";
const ID = "0123456789abcdef0123456789abcdef";
let servers: WebServer[] = [];
afterEach(async () => {
	await Promise.all(servers.map((server) => server.close()));
	servers = [];
});

async function serve(human = new FakeHumanPort(), heartbeatMs?: number) {
	const server = await startWeb({ host: HOST, port: 0, human, heartbeatMs });
	servers.push(server);
	return { human, server, base: `http://${HOST}:${server.port}` };
}

/** A page's socket: every message it got, in order, and a way to wait for the next. */
async function open(port: number) {
	const socket = new WebSocket(`ws://${HOST}:${port}/socket`);
	const received: WebMessage[] = [];
	socket.addEventListener("message", (event) => received.push(JSON.parse(String(event.data)) as WebMessage));
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	// The run state a new subscriber gets first; FakeHumanPort sends none, so the server's own is not asserted here.
	let seen = 0;
	const next = async () => {
		await vi.waitFor(() => expect(received.length).toBeGreaterThan(seen));
		return received[seen++] as WebMessage;
	};
	const send = (message: unknown) => socket.send(JSON.stringify(message));
	return { socket, received, next, send };
}

/** The status of a WebSocket upgrade with the given headers, which a refused one answers with. */
function upgradeStatus(port: number, headers: Record<string, string>): Promise<number | undefined> {
	return new Promise((resolve, reject) => {
		const req = request({
			host: HOST,
			port,
			path: "/socket",
			headers: {
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
				"Sec-WebSocket-Version": "13",
				...headers,
			},
		});
		req.once("response", (response) => {
			response.resume();
			resolve(response.statusCode);
		});
		req.once("upgrade", (response, socket) => {
			socket.destroy();
			resolve(response.statusCode);
		});
		req.once("error", reject);
		req.end();
	});
}

test("serves the page and the placeholder character, and nothing else", async () => {
	const { base } = await serve();
	const page = await fetch(`${base}/`);
	expect(page.status).toBe(200);
	expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
	const html = await page.text();
	expect(html).toContain('name="viewport"');
	expect(html).toContain("/character.svg");
	const image = await fetch(`${base}/character.svg`);
	expect(image.headers.get("content-type")).toBe("image/svg+xml");
	expect(await image.text()).toContain("<svg");
	expect((await fetch(`${base}/secret`)).status).toBe(404);
	expect((await fetch(`${base}/`, { method: "POST", body: "x" })).status).toBe(405);
});

test("a message sent over the socket reaches HumanPort submit as a chat.web input", async () => {
	const { human, server } = await serve();
	const page = await open(server.port);
	page.send({ type: "input", id: ID, text: "今天有什麼會" });
	expect(await page.next()).toEqual({ type: "accepted", id: ID });
	expect(human.inputs).toEqual([{ content: "今天有什麼會", entry: { kind: "chat.web" }, requestId: `web:${ID}` }]);
});

test("a resend keeps its requestId, so the core admits it once", async () => {
	const { human, server } = await serve();
	const page = await open(server.port);
	page.send({ type: "input", id: ID, text: "hi" });
	expect(await page.next()).toEqual({ type: "accepted", id: ID });
	const again = await open(server.port);
	again.send({ type: "input", id: ID, text: "hi" });
	expect(await again.next()).toEqual({ type: "accepted", id: ID });
	expect(human.inputs.map((input) => input.requestId)).toEqual([`web:${ID}`]);
});

test("a message that is not an input is refused and never submitted", async () => {
	const { human, server } = await serve();
	const page = await open(server.port);
	page.socket.send("not json");
	expect(await page.next()).toEqual({ type: "error", text: "not JSON" });
	page.send({ type: "input", id: "1", text: "a guessable id" });
	expect(await page.next()).toEqual({ type: "error", text: "not an input" });
	page.send({ type: "input", id: ID, text: "" });
	expect(await page.next()).toEqual({ type: "error", text: "not an input" });
	expect(human.inputs).toEqual([]);
});

test("the answer of the page's own turn comes back over the socket, to every open page", async () => {
	const { human, server } = await serve();
	const page = await open(server.port);
	const other = await open(server.port);
	page.send({ type: "input", id: ID, text: "hi" });
	expect(await page.next()).toEqual({ type: "accepted", id: ID });
	human.emit({ type: "answer", requestId: `web:${ID}`, content: "你好" });
	expect(await page.next()).toEqual({ type: "answer", id: ID, text: "你好" });
	expect(await other.next()).toEqual({ type: "answer", id: ID, text: "你好" });
	human.emit({ type: "failure", requestId: `web:${ID}`, reason: "no model" });
	expect(await page.next()).toEqual({ type: "failure", id: ID, text: "no model", loud: true });
});

test("the answer of a turn another interface started is not sent; a scheduled turn's is a report", async () => {
	const { human, server } = await serve();
	const page = await open(server.port);
	human.emit({ type: "answer", requestId: "telegram:42", content: "for the phone chat" });
	human.emit({ type: "answer", requestId: "terminal:1793000000000", content: "for the terminal" });
	human.emit({ type: "failure", requestId: "telegram:43", reason: "theirs" });
	human.emit({ type: "answer", requestId: "digest:2026-10-27T10:00:00Z", content: "a digest, noticed apart" });
	human.emit({ type: "notice", kind: "forwarded", requestId: `web:${ID}` });
	human.emit({ type: "answer", requestId: "schedule:7", content: "記得喝水" });
	expect(await page.next()).toEqual({ type: "notice", kind: "report", text: "記得喝水", loud: true });
	expect(page.received).toHaveLength(1);
});

test("a push meant for another interface is shown without ringing", async () => {
	const { human, server } = await serve();
	const page = await open(server.port);
	human.emit({ type: "notice", kind: "question", content: "q1", target: "chat.telegram" });
	human.emit({ type: "notice", kind: "report", content: "r1", target: "chat.web" });
	human.emit({ type: "notice", kind: "report", content: "r2" });
	human.emit({ type: "failure", requestId: "agent:fix-bug:3", reason: "429", target: "chat.terminal" });
	human.emit({ type: "run", state: "working" });
	expect([await page.next(), await page.next(), await page.next(), await page.next(), await page.next()]).toEqual([
		{ type: "notice", kind: "question", text: "q1", loud: false },
		{ type: "notice", kind: "report", text: "r1", loud: true },
		{ type: "notice", kind: "report", text: "r2", loud: true },
		{ type: "failure", text: "agent:fix-bug:3 那一輪：429", loud: false },
		{ type: "run", state: "working" },
	]);
});

test("a closed page unsubscribes", async () => {
	const human = new FakeHumanPort();
	let live = 0;
	const subscribe = human.subscribe.bind(human);
	human.subscribe = (listener) => {
		live += 1;
		const unsubscribe = subscribe(listener);
		return () => {
			live -= 1;
			return unsubscribe();
		};
	};
	const { server } = await serve(human);
	const page = await open(server.port);
	expect(live).toBe(1);
	page.socket.close();
	await vi.waitFor(() => expect(live).toBe(0));
});

/** A human port that counts its live subscribers. */
function countingHuman() {
	const human = new FakeHumanPort();
	const subscribers = { live: 0 };
	const subscribe = human.subscribe.bind(human);
	human.subscribe = (listener) => {
		subscribers.live += 1;
		const unsubscribe = subscribe(listener);
		return () => {
			subscribers.live -= 1;
			return unsubscribe();
		};
	};
	return { human, subscribers };
}

/** A peer that completes the handshake and then never reads or answers: a phone tab left in the background. */
async function openSilent(port: number) {
	const socket = connect({ host: HOST, port });
	socket.write(
		`GET /socket HTTP/1.1\r\nHost: ${HOST}:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
			"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
	);
	await new Promise((resolve) => socket.once("data", resolve));
	return socket;
}

test("closing the server completes while a page stays open and answers nothing", async () => {
	const { human, subscribers } = countingHuman();
	const { server } = await serve(human);
	const silent = await openSilent(server.port);
	const ended = new Promise((resolve) => silent.once("close", resolve));
	await vi.waitFor(() => expect(subscribers.live).toBe(1));
	const started = Date.now();
	await server.close();
	expect(Date.now() - started).toBeLessThan(2000);
	await ended;
	expect(subscribers.live).toBe(0);
	await server.close();
});

test("a page that stops answering pings is closed and unsubscribed; one that answers stays", async () => {
	const { human, subscribers } = countingHuman();
	const { server } = await serve(human, 50);
	const url = `ws://${HOST}:${server.port}/socket`;
	const answering = new WsClient(url);
	const silent = new WsClient(url, { autoPong: false });
	const silentClosed = new Promise((resolve) => silent.once("close", resolve));
	await Promise.all([answering, silent].map((client) => new Promise((resolve) => client.once("open", resolve))));
	expect(subscribers.live).toBe(2);
	await silentClosed;
	await vi.waitFor(() => expect(subscribers.live).toBe(1));
	// Several more intervals on: the page that answers is still there.
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(answering.readyState).toBe(WsClient.OPEN);
	expect(subscribers.live).toBe(1);
	answering.close();
});

test("a message over 1 MiB closes the connection and is never submitted", async () => {
	const { human, server } = await serve();
	const page = await open(server.port);
	const closed = new Promise<CloseEvent>((resolve) => page.socket.addEventListener("close", resolve, { once: true }));
	page.socket.send("x".repeat(MAX_MESSAGE_BYTES + 1));
	expect((await closed).code).toBe(1009);
	expect(human.inputs).toEqual([]);
});

test("a binary message closes the connection", async () => {
	const { human, server } = await serve();
	const page = await open(server.port);
	const closed = new Promise<CloseEvent>((resolve) => page.socket.addEventListener("close", resolve, { once: true }));
	page.socket.send(new Uint8Array([1, 2, 3]));
	expect((await closed).code).toBe(1003);
	expect(human.inputs).toEqual([]);
});

test("only a page served from the configured address may open the socket", async () => {
	const { server } = await serve();
	const authority = `${HOST}:${server.port}`;
	expect(await upgradeStatus(server.port, { Host: authority })).toBe(101);
	expect(await upgradeStatus(server.port, { Host: authority, Origin: `http://${authority}` })).toBe(101);
	expect(await upgradeStatus(server.port, { Host: authority, Origin: "http://evil.example" })).toBe(403);
	// A name rebound to this address keeps the page's own origin, but not the Host.
	const rebound = `evil.example:${server.port}`;
	expect(await upgradeStatus(server.port, { Host: rebound, Origin: `http://${rebound}` })).toBe(403);
});

test("refuses a wildcard or a name for the host", async () => {
	for (const host of ["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "localhost", ""]) {
		expect(() => checkHost(host)).toThrow(/web host must/);
		await expect(startWeb({ host, port: 0, human: new FakeHumanPort() })).rejects.toThrow(/web host must/);
	}
});

test("listens on the configured address only", async () => {
	const { server } = await serve();
	const refused = await new Promise<string>((resolve) => {
		const socket = connect({ host: "::1", port: server.port });
		socket.once("connect", () => {
			socket.destroy();
			resolve("connected");
		});
		socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
	});
	expect(refused).toBe("ECONNREFUSED");
});
