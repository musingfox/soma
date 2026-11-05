import { readFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import { FakeHumanPort } from "../../../src/adapters/fake-human/index.ts";
import {
	checkHost,
	MARKED_PATH,
	MAX_MESSAGE_BYTES,
	PAGE_MODULES,
	startWeb,
	THREE_PATH,
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

test("serves the page, its stylesheet and its modules, and nothing else", async () => {
	const { base } = await serve();
	const page = await fetch(`${base}/`);
	expect(page.status).toBe(200);
	expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
	const html = await page.text();
	expect(html).toContain('name="viewport"');
	const css = await fetch(`${base}/house.css`);
	expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
	for (const name of PAGE_MODULES) {
		const module = await fetch(`${base}/${name}`);
		expect([name, module.status, module.headers.get("content-type")]).toEqual([
			name,
			200,
			"text/javascript; charset=utf-8",
		]);
	}
	expect((await fetch(`${base}/secret`)).status).toBe(404);
	expect((await fetch(`${base}/`, { method: "POST", body: "x" })).status).toBe(405);
});

test("the page loads everything from soma itself: no external host, and every import is served", async () => {
	const { base } = await serve();
	const html = await (await fetch(`${base}/`)).text();
	const own = [html, await (await fetch(`${base}/house.css`)).text()];
	for (const name of PAGE_MODULES) own.push(await (await fetch(`${base}/${name}`)).text());
	// No fixed scheme either: a page served over https (serve mode) may open only a wss socket.
	for (const text of own) expect(text).not.toMatch(/(?:https?|wss?):\/\/|(?:^|["'(\s])\/\/[a-z0-9]/i);

	const importMap = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1] ?? "{}");
	const urls = [
		...Object.values<string>(importMap.imports),
		...[...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((match) => match[1] as string),
	];
	expect(urls).toContain(`${THREE_PATH}three.module.js`);
	expect(urls).toContain(`${MARKED_PATH}marked.esm.js`);
	for (const url of urls) {
		if (url.startsWith("data:")) continue;
		expect(url).toMatch(/^\/[^/]/);
		expect([url, (await fetch(`${base}${url}`)).status]).toEqual([url, 200]);
	}
	// Every module a page module imports is either a vendored one, through the import map, or one of the page's own.
	const specifiers = own.slice(2).flatMap((text) => [...text.matchAll(/^import [^;]*?"([^"]+)";/gm)].map((m) => m[1]));
	expect(specifiers).toContain("three");
	expect(specifiers).toContain("marked");
	for (const specifier of specifiers) {
		const known = specifier === "three" || specifier === "marked";
		expect([specifier, known || PAGE_MODULES.includes(specifier?.replace(/^\.\//, "") ?? "")]).toEqual([
			specifier,
			true,
		]);
	}
	expect(Object.keys(importMap.imports).sort()).toEqual(["marked", "three"]);
});

/** The status of a GET for `path` sent exactly as written, where fetch would resolve its dot segments first. */
function rawStatus(port: number, path: string): Promise<number | undefined> {
	return new Promise((resolve, reject) => {
		const req = request({ host: HOST, port, path }, (response) => {
			response.resume();
			resolve(response.statusCode);
		});
		req.once("error", reject);
		req.end();
	});
}

test("serves three.js from the pinned dependency, as a JavaScript module", async () => {
	const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
	const pinned: string = pkg.dependencies.three;
	expect(pinned).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
	const installed = JSON.parse(
		readFileSync(new URL("../../../node_modules/three/package.json", import.meta.url), "utf8"),
	);
	expect(installed.version).toBe(pinned);
	const { base } = await serve();
	for (const name of ["three.module.js", "three.core.js"]) {
		const response = await fetch(`${base}${THREE_PATH}${name}`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		const local = readFileSync(new URL(`../../../node_modules/three/build/${name}`, import.meta.url), "utf8");
		expect(await response.text()).toBe(local);
	}
});

test("serves marked from the pinned dependency, as a JavaScript module, and it imports nothing", async () => {
	const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
	const pinned: string = pkg.dependencies.marked;
	expect(pinned).toBe("18.1.1");
	const installed = JSON.parse(
		readFileSync(new URL("../../../node_modules/marked/package.json", import.meta.url), "utf8"),
	);
	expect(installed.version).toBe(pinned);
	const { base } = await serve();
	const response = await fetch(`${base}${MARKED_PATH}marked.esm.js`);
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
	const body = await response.text();
	expect(body).toBe(readFileSync(new URL("../../../node_modules/marked/lib/marked.esm.js", import.meta.url), "utf8"));
	// A module with no import of its own cannot pull anything from elsewhere.
	expect(body).not.toMatch(/^\s*import\s/m);
	expect(body).not.toMatch(/\bimport\(/);
	// The markdown module is one of the page's own files.
	expect(PAGE_MODULES).toContain("markdown.js");
	expect((await fetch(`${base}/markdown.js`)).status).toBe(200);
});

test("a path that climbs out of the served files, or names an unlisted one, is not found", async () => {
	const { server } = await serve();
	for (const path of [
		`${THREE_PATH}../../package.json`,
		`${THREE_PATH}%2e%2e/%2e%2e/package.json`,
		`${THREE_PATH}..%2f..%2fpackage.json`,
		"/../package.json",
		"/node_modules/three/package.json",
		`${THREE_PATH}three.cjs`,
		`${MARKED_PATH}../../package.json`,
		`${MARKED_PATH}%2e%2e/%2e%2e/package.json`,
		`${MARKED_PATH}marked.umd.js`,
		`${MARKED_PATH}marked.esm.js.map`,
		MARKED_PATH,
		"/node_modules/marked/package.json",
		`${THREE_PATH}../three/package.json`,
		THREE_PATH,
		"//etc/passwd",
	]) {
		expect([path, await rawStatus(server.port, path)]).toEqual([path, 404]);
	}
});

test("a file is sent gzipped to a browser that takes it, and not again while unchanged", async () => {
	const { base } = await serve();
	const plain = await new Promise<{ encoding?: string; etag?: string; length: number }>((resolve, reject) => {
		const url = new URL(`${base}${THREE_PATH}three.core.js`);
		const req = request({
			host: url.hostname,
			port: url.port,
			path: url.pathname,
			headers: { "accept-encoding": "gzip" },
		});
		req.once("response", (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("end", () =>
				resolve({
					encoding: response.headers["content-encoding"],
					etag: response.headers.etag,
					length: Buffer.concat(chunks).length,
				}),
			);
		});
		req.once("error", reject);
		req.end();
	});
	expect(plain.encoding).toBe("gzip");
	expect(plain.length).toBeLessThan(500_000);
	const again = await fetch(`${base}${THREE_PATH}three.core.js`, { headers: { "if-none-match": plain.etag ?? "" } });
	expect(again.status).toBe(304);
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
	human.emit({ type: "answer", requestId: "schedule:7", content: "記得喝水", class: "outcome" });
	expect(await page.next()).toEqual({ type: "notice", kind: "report", text: "記得喝水", loud: true });
	expect(page.received).toHaveLength(1);
});

test("a push shown quietly here is shown without ringing, and a logged one is not sent", async () => {
	const { human, server } = await serve();
	const page = await open(server.port);
	const quiet = { "chat.telegram": "ring", "chat.web": "quiet" } as const;
	const logged = { "chat.web": "log" } as const;
	human.emit({ type: "notice", kind: "question", class: "action", content: "q1", delivery: quiet });
	human.emit({ type: "notice", kind: "report", class: "outcome", content: "logged", delivery: logged });
	human.emit({ type: "answer", requestId: "schedule:1", content: "logged", class: "outcome", delivery: logged });
	human.emit({ type: "failure", requestId: "schedule:2", reason: "logged", class: "outcome", delivery: logged });
	human.emit({ type: "notice", kind: "report", class: "outcome", content: "r1", delivery: { "chat.web": "ring" } });
	human.emit({ type: "notice", kind: "report", class: "outcome", content: "r2" });
	const failure = { type: "failure", requestId: "agent:fix-bug:3", reason: "429", class: "outcome" } as const;
	human.emit({ ...failure, delivery: { "chat.terminal": "ring" } });
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

// Serve mode: loopback behind `tailscale serve`, which sets the login header and keeps the public Host.
const ORIGIN = "https://nick-mac-mini.tail361ef.ts.net:8445";
const AUTHORITY = "nick-mac-mini.tail361ef.ts.net:8445";
const LOGIN = "musingfox@github";
const SERVED = { Host: AUTHORITY, "Tailscale-User-Login": LOGIN };

async function serveBehind(human = new FakeHumanPort(), heartbeatMs?: number) {
	const server = await startWeb({ host: HOST, port: 0, human, heartbeatMs, serve: { origin: ORIGIN, login: LOGIN } });
	servers.push(server);
	return { human, server };
}

/** The status of a GET for `path` with exactly the given headers, Host included, which fetch would not let us set. */
function getStatus(port: number, path: string, headers: Record<string, string>): Promise<number | undefined> {
	return new Promise((resolve, reject) => {
		const req = request({ host: HOST, port, path, headers }, (response) => {
			response.resume();
			resolve(response.statusCode);
		});
		req.once("error", reject);
		req.end();
	});
}

test("serve mode: a request needs the configured login, else 403, whatever the path or method", async () => {
	const { server } = await serveBehind();
	const { port } = server;
	expect(await getStatus(port, "/", SERVED)).toBe(200);
	expect(await getStatus(port, "/house.css", SERVED)).toBe(200);
	expect(await getStatus(port, "/", { Host: AUTHORITY })).toBe(403);
	expect(await getStatus(port, "/", { Host: AUTHORITY, "Tailscale-User-Login": "someone@github" })).toBe(403);
	expect(await getStatus(port, "/", { Host: AUTHORITY, "Tailscale-User-Login": "" })).toBe(403);
	expect(await getStatus(port, "/", { Host: AUTHORITY, "Tailscale-User-Login": `${LOGIN}, ${LOGIN}` })).toBe(403);
	// The 403 comes before the allowlist's 404.
	expect(await getStatus(port, "/secret", { Host: AUTHORITY })).toBe(403);
	expect(await getStatus(port, "/secret", SERVED)).toBe(404);
	const post = await new Promise<number | undefined>((resolve, reject) => {
		const req = request({ host: HOST, port, path: "/", method: "POST", headers: { Host: AUTHORITY } }, (response) => {
			response.resume();
			resolve(response.statusCode);
		});
		req.once("error", reject);
		req.end("x");
	});
	expect(post).toBe(403);
});

test("serve mode: the Host must be the origin's, whatever the login", async () => {
	const { server } = await serveBehind();
	const login = { "Tailscale-User-Login": LOGIN };
	expect(await getStatus(server.port, "/", { ...login, Host: `${HOST}:${server.port}` })).toBe(403);
	expect(await getStatus(server.port, "/", { ...login, Host: "nick-mac-mini.tail361ef.ts.net" })).toBe(403);
	expect(await getStatus(server.port, "/", { ...login, Host: `evil.example:8445` })).toBe(403);
});

test("serve mode: the upgrade needs the login, the origin's Host and, when sent, the origin, before any handshake", async () => {
	const { server } = await serveBehind();
	const { port } = server;
	expect(await upgradeStatus(port, SERVED)).toBe(101);
	expect(await upgradeStatus(port, { ...SERVED, Origin: ORIGIN })).toBe(101);
	expect(await upgradeStatus(port, { Host: AUTHORITY })).toBe(403);
	expect(await upgradeStatus(port, { Host: AUTHORITY, Origin: ORIGIN })).toBe(403);
	expect(await upgradeStatus(port, { Host: AUTHORITY, "Tailscale-User-Login": "someone@github" })).toBe(403);
	expect(await upgradeStatus(port, { ...SERVED, Origin: "http://evil.example" })).toBe(403);
	// Neither the plain-http form of the origin nor the loopback page's own origin is the page serve publishes.
	expect(await upgradeStatus(port, { ...SERVED, Origin: `http://${AUTHORITY}` })).toBe(403);
	expect(await upgradeStatus(port, { ...SERVED, Origin: `http://${HOST}:${port}` })).toBe(403);
	expect(await upgradeStatus(port, { ...SERVED, Origin: "https://nick-mac-mini.tail361ef.ts.net" })).toBe(403);
	expect(await upgradeStatus(port, { ...SERVED, Host: `${HOST}:${port}` })).toBe(403);
});

test("serve mode: a refused upgrade never reaches the WebSocket server", async () => {
	const human = new FakeHumanPort();
	const { server } = await serveBehind(human);
	const refused = new WsClient(`ws://${HOST}:${server.port}/socket`, { headers: { Host: AUTHORITY } });
	const status = await new Promise<number | undefined>((resolve) => {
		refused.once("unexpected-response", (_request, response) => resolve(response.statusCode));
		refused.once("error", () => {});
	});
	expect(status).toBe(403);
	expect(human.inputs).toEqual([]);
});

test("serve mode: a page with the login and the origin talks over the socket, and the limits hold", async () => {
	const human = new FakeHumanPort();
	const { server } = await serveBehind(human);
	const headers = { ...SERVED, Origin: ORIGIN };
	const open = new WsClient(`ws://${HOST}:${server.port}/socket`, { headers });
	const received: WebMessage[] = [];
	open.on("message", (data) => received.push(JSON.parse(String(data)) as WebMessage));
	await new Promise((resolve, reject) => {
		open.once("open", resolve);
		open.once("error", reject);
	});
	open.send(JSON.stringify({ type: "input", id: ID, text: "hello" }));
	await vi.waitFor(() => expect(received).toContainEqual({ type: "accepted", id: ID }));
	expect(human.inputs).toHaveLength(1);

	const closed = new Promise<number>((resolve) => open.once("close", resolve));
	open.send("x".repeat(MAX_MESSAGE_BYTES + 1));
	expect(await closed).toBe(1009);
	expect(human.inputs).toHaveLength(1);
});

test("serve mode: closing completes while a page is open, and pings drop a page that does not answer", async () => {
	const { server } = await serveBehind(new FakeHumanPort(), 20);
	const page = new WsClient(`ws://${HOST}:${server.port}/socket`, { headers: SERVED });
	await new Promise((resolve, reject) => {
		page.once("open", resolve);
		page.once("error", reject);
	});
	const pings: number[] = [];
	page.on("ping", () => pings.push(Date.now()));
	await vi.waitFor(() => expect(pings.length).toBeGreaterThan(0));
	const left = new Promise((resolve) => page.once("close", resolve));
	await server.close();
	await left;
});

test("serve mode listens on 127.0.0.1 only", async () => {
	for (const host of ["100.101.102.103", "::1", "192.168.1.10"]) {
		await expect(
			startWeb({ host, port: 0, human: new FakeHumanPort(), serve: { origin: ORIGIN, login: LOGIN } }),
		).rejects.toThrow(/web serve mode must listen on 127\.0\.0\.1/);
	}
});

test("without serve, a login header is neither required nor consulted", async () => {
	const { server, base } = await serve();
	expect((await fetch(`${base}/`)).status).toBe(200);
	expect((await fetch(`${base}/`, { headers: { "Tailscale-User-Login": "anyone@github" } })).status).toBe(200);
	const authority = `${HOST}:${server.port}`;
	expect(await upgradeStatus(server.port, { Host: authority, "Tailscale-User-Login": "anyone@github" })).toBe(101);
});
