import { execFile } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { type DeferServer, requestDefer, requestDispatch, serveDefer } from "../../src/adapters/defer-socket/index.ts";
import { runDefer } from "../../src/defer-cli.ts";
import type { DeferReply, DeferRequest } from "../../src/ports/defer.ts";
import type { DispatchReply, DispatchRequest } from "../../src/ports/dispatch.ts";

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

const STARTED: DispatchReply = {
	dispatched: true,
	how: "started",
	card: "card-a",
	agent: "card-a",
	sessionId: "s-1",
	repo: "/w/soma",
	state: "idle",
};

/** A socket serving both kinds of request, each recorded as the core received it. */
async function servingBoth(reply: (request: DispatchRequest) => DispatchReply = () => STARTED) {
	const path = socketPath();
	const deferred: DeferRequest[] = [];
	const dispatched: DispatchRequest[] = [];
	const server = await serveDefer({
		path,
		defer: async (request) => {
			deferred.push(request);
			return { accepted: true, id: "1", at: "x" };
		},
		dispatch: async (request) => {
			dispatched.push(request);
			return reply(request);
		},
		onError: () => {},
	});
	return { path, deferred, dispatched, server };
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

test("a dispatch request reaches the core's dispatch and its reply comes back; a defer still reaches defer", async () => {
	const { path, deferred, dispatched, server } = await servingBoth();

	expect(await requestDispatch(path, { repo: "/w/soma", card: "card-a" })).toEqual(STARTED);
	expect(await requestDefer(path, { agent: "card-a", at: "PT2M", instruction: "x" })).toEqual({
		accepted: true,
		id: "1",
		at: "x",
	});

	expect(dispatched).toEqual([{ repo: "/w/soma", card: "card-a" }]);
	expect(deferred).toEqual([{ agent: "card-a", at: "PT2M", instruction: "x" }]);
	await server.close();
});

test("a malformed dispatch request is refused in dispatch's shape without reaching the core", async () => {
	const { path, deferred, dispatched, server } = await servingBoth();

	expect(JSON.parse(await raw(path, `${JSON.stringify({ kind: "dispatch", card: "card-a" })}\n`))).toEqual({
		dispatched: false,
		reason: "the request is malformed at repo",
	});
	expect([deferred, dispatched]).toEqual([[], []]);
	await server.close();
});

test("a soma serving no dispatch refuses one, and a core that throws is a refusal naming the error", async () => {
	const { path, server } = await serving();
	expect(await requestDispatch(path, { repo: "/w/soma", card: "card-a" })).toEqual({
		dispatched: false,
		reason: "this soma does not serve soma dispatch",
	});
	await server.close();

	const failing = socketPath();
	const throwing = await serveDefer({
		path: failing,
		defer: async () => ({ accepted: false, reason: "" }),
		dispatch: async () => {
			throw new Error("database is locked");
		},
		onError: () => {},
	});
	expect(await requestDispatch(failing, { repo: "/w/soma", card: "card-a" })).toEqual({
		dispatched: false,
		reason: "soma failed to dispatch it: database is locked",
	});
	await throwing.close();
});

test("a dispatch request that carries a SOMA_AGENT is refused, and none reaches the core", async () => {
	const { path, deferred, dispatched, server } = await servingBoth();
	const refused = {
		dispatched: false,
		reason: "an agent soma dispatched cannot start jobs (SOMA_AGENT=card-b)",
	};

	expect(await requestDispatch(path, { repo: "/w/soma", card: "card-a", agent: "card-b" })).toEqual(refused);
	expect(
		JSON.parse(
			await raw(path, `${JSON.stringify({ kind: "dispatch", repo: "/w/soma", card: "a", agent: "card-b" })}\n`),
		),
	).toEqual(refused);
	expect([deferred, dispatched]).toEqual([[], []]);

	// A request with no such field, as an older CLI sends, is served; so is one a current CLI sends for a human.
	const old = JSON.parse(await raw(path, `${JSON.stringify({ kind: "dispatch", repo: "/w/soma", card: "card-a" })}\n`));
	expect(old).toEqual(STARTED);
	expect(await requestDispatch(path, { repo: "/w/soma", card: "card-a" })).toEqual(STARTED);
	expect(dispatched).toEqual([
		{ repo: "/w/soma", card: "card-a" },
		{ repo: "/w/soma", card: "card-a" },
	]);
	await server.close();
});

test("a dispatch request with a blank SOMA_AGENT is no agent's and is served", async () => {
	const { path, dispatched, server } = await servingBoth();

	expect(await requestDispatch(path, { repo: "/w/soma", card: "card-a", agent: " " })).toEqual(STARTED);
	expect(dispatched).toEqual([{ repo: "/w/soma", card: "card-a" }]);
	await server.close();
});

/** Runs bin/soma dispatch with `env` against a soma serving both kinds; its config names the served socket. */
async function binDispatch(env: Record<string, string>) {
	let server: DeferServer | undefined;
	try {
		const served = await servingBoth();
		server = served.server;
		const bin = resolve(import.meta.dirname, "../../bin/soma");
		const config = join(dir, `dispatch-config-${sockets++}.json`);
		writeFileSync(config, JSON.stringify({ deferSocket: served.path }));
		const run = await promisify(execFile)(bin, ["dispatch", "--repo", "/w/soma", "card-a"], {
			encoding: "utf8",
			env: { PATH: process.env.PATH, SOMA_CONFIG: config, SOMA_NODE: process.execPath, ...env },
		}).then(
			({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
			(error: { code: number; stdout: string; stderr: string }) => error,
		);
		return { run, dispatched: served.dispatched, path: served.path };
	} finally {
		await server?.close();
	}
}

test("bin/soma dispatch sends the repo and card to the socket soma's config names and prints soma's reply", async () => {
	const { run, dispatched } = await binDispatch({});

	expect(run.stderr).toBe("");
	expect(run.stdout).toBe(
		"soma dispatch: started agent card-a for card card-a in /w/soma, session s-1; soma sends it the card's launch prompt once it is ready.\n",
	);
	expect(dispatched).toEqual([{ repo: "/w/soma", card: "card-a" }]);
});

test("bin/soma dispatch ignores SOMA_SOCKET, and in an agent's shell refuses and sends nothing", async () => {
	const other = socketPath();
	const ignored = await binDispatch({ SOMA_SOCKET: other });
	expect(ignored.run.code).toBe(0);
	expect(ignored.dispatched).toEqual([{ repo: "/w/soma", card: "card-a" }]);

	const agent = await binDispatch({ SOMA_AGENT: "card-b", SOMA_SOCKET: ignored.path });
	expect(agent.run).toMatchObject({
		code: 1,
		stdout: "",
		stderr: "soma dispatch: not dispatched: an agent soma dispatched cannot start jobs (SOMA_AGENT=card-b)\n",
	});
	expect(agent.dispatched).toEqual([]);
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

/** Leaves a socket file nobody answers on at `path`, as a killed soma does. */
async function staleSocket(path: string): Promise<void> {
	const killed = promisify(execFile)(process.execPath, [
		"-e",
		"require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))",
		path,
	]);
	await expect(killed).rejects.toMatchObject({ signal: "SIGKILL" });
	expect(lstatSync(path).isSocket()).toBe(true);
}

test("a socket file a killed soma left is replaced; one another process serves is not", async () => {
	const stale = socketPath();
	await staleSocket(stale);
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

test("a file at the socket path that is not a socket is left alone, and soma defer is not served there", async () => {
	const path = socketPath();
	writeFileSync(path, "not soma's");

	await expect(serveDefer({ path, defer: async () => ({ accepted: false, reason: "" }) })).rejects.toThrow(
		`${path} is not a socket, so soma leaves it alone; soma defer is not served`,
	);

	expect(readFileSync(path, "utf8")).toBe("not soma's");
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

test("soma defer calls the outcome unknown once the request went out, and says nothing was deferred only when it could not connect", async () => {
	const defer = async (path: string) => {
		const err: string[] = [];
		const status = await runDefer(
			["--at", "PT2M", "run the tests"],
			{ SOMA_AGENT: "card-a", SOMA_SOCKET: path },
			{ out: () => {}, err: (line) => err.push(line) },
			(socket, request) => requestDefer(socket, request, 200),
		);
		return { status, err };
	};
	// As a soma that recorded the request and then stopped before its reply: one stays silent, one drops the connection.
	const silent = socketPath();
	const dropping = socketPath();
	const servers = [
		createServer((socket) => socket.resume()),
		createServer((socket) => socket.once("data", () => socket.destroy())),
	];
	await new Promise<void>((done) => servers[0]?.listen(silent, done));
	await new Promise<void>((done) => servers[1]?.listen(dropping, done));
	try {
		for (const path of [silent, dropping]) {
			const lost = await defer(path);
			expect(lost.status).toBe(1);
			expect(lost.err).toEqual([expect.stringMatching(/whether it was deferred is unknown/)]);
			expect(lost.err[0]).toMatch(/Do not run soma defer again for it/);
			expect(lost.err[0]).not.toMatch(/nothing was deferred/);
		}
	} finally {
		for (const server of servers) await new Promise((done) => server.close(done));
	}

	const down = await defer(join(dir, "nobody.sock"));
	expect(down.status).toBe(1);
	expect(down.err).toEqual([expect.stringMatching(/^soma defer: soma is not answering on .*; nothing was deferred$/)]);
});
