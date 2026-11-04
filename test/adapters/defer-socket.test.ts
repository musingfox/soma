import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { type DeferServer, requestDefer, serveDefer } from "../../src/adapters/defer-socket/index.ts";
import type { DeferReply, DeferRequest } from "../../src/ports/defer.ts";

const dir = mkdtempSync(join(tmpdir(), "soma-defer-socket-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let sockets = 0;
const socketPath = () => join(dir, `d${sockets++}.sock`);

async function serving(
	reply: (request: DeferRequest) => DeferReply = () => ({ accepted: true, id: "1", at: "x" }),
	readTimeoutMs?: number,
) {
	const path = socketPath();
	const seen: DeferRequest[] = [];
	const server = await serveDefer({
		path,
		defer: async (request) => {
			seen.push(request);
			return reply(request);
		},
		onError: () => {},
		...(readTimeoutMs === undefined ? {} : { readTimeoutMs }),
	});
	return { path, seen, server };
}

/** Sends raw text and reads what the server answers before it ends the connection. */
function raw(path: string, text: string): Promise<string> {
	return new Promise((done, fail) => {
		const socket = connect(path);
		let got = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			got += chunk;
		});
		socket.once("connect", () => socket.write(text));
		socket.once("end", () => done(got));
		socket.once("error", fail);
	});
}

test("a request reaches the core and its reply comes back; the socket is the owner's alone", async () => {
	const { path, seen, server } = await serving();

	const reply = await requestDefer(path, { agent: "card-a", at: "PT2M", instruction: "run the tests" });

	expect(reply).toEqual({ accepted: true, id: "1", at: "x" });
	expect(seen).toEqual([{ agent: "card-a", at: "PT2M", instruction: "run the tests" }]);
	expect(statSync(path).mode & 0o777).toBe(0o600);
	await server.close();
	expect(existsSync(path)).toBe(false);
});

test("a malformed request is refused without reaching the core", async () => {
	const { path, seen, server } = await serving();

	expect(JSON.parse(await raw(path, "not json\n"))).toEqual({ accepted: false, reason: "the request is not JSON" });
	expect(JSON.parse(await raw(path, `${JSON.stringify({ agent: "a", at: 5 })}\n`))).toEqual({
		accepted: false,
		reason: "the request is malformed at at, instruction",
	});
	expect(seen).toEqual([]);
	await server.close();
});

/** A client that connects and sends nothing; resolves when the server ends or drops the connection. */
function idle(path: string): Promise<void> {
	return new Promise((done, fail) => {
		const socket = connect(path);
		socket.once("connect", () => socket.resume());
		socket.once("close", () => done());
		socket.once("error", fail);
	});
}

test("a client that sends no request in time is dropped", async () => {
	const { path, seen, server } = await serving(undefined, 100);
	const started = Date.now();

	await idle(path);

	expect(Date.now() - started).toBeLessThan(2_000);
	expect(seen).toEqual([]);
	await server.close();
});

test("close ends a connection still waiting for its request instead of waiting for it", async () => {
	const { path, server } = await serving();
	const client = idle(path);
	await new Promise((done) => setTimeout(done, 50));

	const closed = await Promise.race([
		server.close().then(() => "closed"),
		new Promise((done) => setTimeout(() => done("still open"), 2_000)),
	]);

	expect(closed).toBe("closed");
	await client;
});

test("a socket file a killed soma left is replaced; one another process serves is not", async () => {
	const stale = socketPath();
	writeFileSync(stale, "");
	const replaced = await serveDefer({ path: stale, defer: async () => ({ accepted: false, reason: "r" }) });
	expect(await requestDefer(stale, { agent: "a", at: "PT1M", instruction: "i" })).toEqual({
		accepted: false,
		reason: "r",
	});

	const live = socketPath();
	const other = createServer();
	await new Promise<void>((done) => other.listen(live, done));
	await expect(serveDefer({ path: live, defer: async () => ({ accepted: false, reason: "" }) })).rejects.toThrow(
		`another process already serves ${live}`,
	);
	await new Promise((done) => other.close(done));
	await replaced.close();
});

test("bin/soma defer runs the CLI with the agent's SOMA_AGENT against SOMA_SOCKET", async () => {
	let server: DeferServer | undefined;
	try {
		const served = await serving((request) => ({ accepted: true, id: "42", at: `at ${request.at}` }));
		server = served.server;
		const bin = resolve(import.meta.dirname, "../../bin/soma");
		// Not spawnSync: the server answering it runs in this process.
		const run = await promisify(execFile)(bin, ["defer", "--at", "PT2M", "run", "the tests"], {
			encoding: "utf8",
			env: { PATH: process.env.PATH, SOMA_AGENT: "card-a", SOMA_SOCKET: served.path, SOMA_NODE: process.execPath },
		});

		expect(run.stderr).toBe("");
		expect(run.stdout).toBe(
			"soma defer: accepted as 42; soma will send this instruction to agent card-a as a new prompt at at PT2M. You can end your turn now.\n",
		);
		expect(served.seen).toEqual([{ agent: "card-a", at: "PT2M", instruction: "run the tests" }]);
	} finally {
		await server?.close();
	}
});

test("bin/soma defer works through a symlinked release directory, as releases/current is", async () => {
	let server: DeferServer | undefined;
	try {
		const served = await serving((request) => ({ accepted: true, id: "43", at: `at ${request.at}` }));
		server = served.server;
		const current = join(dir, "current");
		symlinkSync(resolve(import.meta.dirname, "../.."), current);
		const run = await promisify(execFile)(join(current, "bin/soma"), ["defer", "--at", "PT2M", "run", "it"], {
			encoding: "utf8",
			env: { PATH: process.env.PATH, SOMA_AGENT: "card-a", SOMA_SOCKET: served.path, SOMA_NODE: process.execPath },
		});

		expect(run.stdout).toMatch(/^soma defer: accepted as 43;/);
		expect(served.seen).toEqual([{ agent: "card-a", at: "PT2M", instruction: "run it" }]);
	} finally {
		await server?.close();
	}
});
