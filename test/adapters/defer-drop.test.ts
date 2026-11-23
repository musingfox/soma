import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import { type DropServer, serveDrop } from "../../src/adapters/defer-drop/index.ts";
import type { DeferReply, DeferRequest } from "../../src/ports/defer.ts";

const root = mkdtempSync(join(tmpdir(), "soma-defer-drop-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const fresh = () => join(root, `d${dirs++}`);
const servers: DropServer[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
});

const SESSION = "7e33597b-e33d-4c6d-a700-e21b2f54223e";
const VALID = `session: ${SESSION}\ncwd: /Users/me/workspace/soma\nat: PT2M\n\nrun the tests\n`;

/** Puts a request in as the script does, by a rename, with its modification time at `mtime` (epoch seconds). */
function put(dir: string, name: string, text: string | Buffer, mtime?: number) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const temporary = join(dir, `${name}.tmp`);
	writeFileSync(temporary, text, { mode: 0o600 });
	if (mtime !== undefined) utimesSync(temporary, mtime, mtime);
	renameSync(temporary, join(dir, `${name}.req`));
}

async function until(done: () => boolean, ms = 3_000) {
	const end = Date.now() + ms;
	while (!done()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function serving(
	dir: string,
	reply: (request: DeferRequest, call: number) => DeferReply = () => ({
		accepted: true,
		id: "7",
		at: "2026-11-23T10:00:00.000Z",
	}),
) {
	const seen: DeferRequest[] = [];
	const errors: Error[] = [];
	const server = await serveDrop({
		dir,
		defer: async (request) => {
			seen.push(request);
			return reply(request, seen.length);
		},
		onError: (error) => errors.push(error),
		scanMs: 10,
	});
	servers.push(server);
	return { seen, errors, server };
}

const replyOf = (dir: string, name: string) => readFileSync(join(dir, `${name}.reply`), "utf8");
// The reply is renamed into place before the request is removed: answered once both are done.
const answered = (dir: string, name: string) => () =>
	existsSync(join(dir, `${name}.reply`)) && !existsSync(join(dir, `${name}.req`));

test("a request reaches defer with its six fields, and its reply is one line, 0600, with the request gone", async () => {
	const dir = fresh();
	put(dir, "s1-100-42", VALID, 1_763_892_000);
	const { seen } = await serving(dir);

	await until(answered(dir, "s1-100-42"));

	expect(seen).toEqual([
		{
			session: SESSION,
			cwd: "/Users/me/workspace/soma",
			at: "PT2M",
			instruction: "run the tests\n",
			request: "s1-100-42",
			setAt: 1_763_892_000_000,
		},
	]);
	expect(replyOf(dir, "s1-100-42")).toBe("accepted 7 2026-11-23T10:00:00.000Z\n");
	expect(statSync(join(dir, "s1-100-42.reply")).mode & 0o777).toBe(0o600);
	expect(existsSync(join(dir, "s1-100-42.req"))).toBe(false);
});

test("a refusal is written as one line, its reason's line breaks made spaces", async () => {
	const dir = fresh();
	put(dir, "r1", VALID);
	await serving(dir, () => ({ accepted: false, reason: "the time\nhad passed\r\nlong ago" }));

	await until(answered(dir, "r1"));

	expect(replyOf(dir, "r1")).toBe("refused the time had passed long ago\n");
	expect(existsSync(join(dir, "r1.req"))).toBe(false);
});

test("each malformed text, a link and a file over 64 KiB are refused, naming why, and defer is not called", async () => {
	const dir = fresh();
	const cases: Record<string, string | Buffer> = {
		missing: `session: ${SESSION}\nat: PT2M\n\nx`,
		twice: `session: ${SESSION}\ncwd: /w\nat: PT2M\nat: PT3M\n\nx`,
		unknown: `session: ${SESSION}\ncwd: /w\nat: PT2M\nagent: card-a\n\nx`,
		unblank: `session: ${SESSION}\ncwd: /w\nat: PT2M\nx`,
		big: `${VALID}${"x".repeat(64 * 1024)}`,
		binary: Buffer.from([0x73, 0xff, 0xfe, 0x0a]),
	};
	for (const [name, text] of Object.entries(cases)) put(dir, name, text);
	writeFileSync(join(root, "target"), VALID);
	symlinkSync(join(root, "target"), join(dir, "link.req"));
	const { seen } = await serving(dir);

	await until(() => [...Object.keys(cases), "link"].every((name) => answered(dir, name)()));

	expect(Object.fromEntries([...Object.keys(cases), "link"].map((name) => [name, replyOf(dir, name)]))).toEqual({
		missing: "refused the request has no cwd header\n",
		twice: "refused the request has its at header twice\n",
		unknown: 'refused the request\'s header line "agent: card-a" is not one of session, cwd, at\n',
		unblank: "refused the request has no empty line after its headers\n",
		big: "refused the request is over 65536 bytes\n",
		binary: "refused the request is not UTF-8 text\n",
		link: "refused the request is not a regular file\n",
	});
	expect(seen).toEqual([]);
	expect(readFileSync(join(root, "target"), "utf8")).toBe(VALID);
});

test("a .tmp file and names not of a request or reply are left alone, however old", async () => {
	const dir = fresh();
	const strangers = ["half.tmp", "notes.txt", "-dash.req", "bad_name.req", "a.b.req", "x.reply.old", "x.req.tmp"];
	mkdirSync(dir, { mode: 0o700 });
	// Old enough that a scan pruning more than replies would take them.
	const old = Date.now() / 1000 - 25 * 3600;
	for (const name of strangers) {
		writeFileSync(join(dir, name), VALID);
		utimesSync(join(dir, name), old, old);
	}
	put(dir, "zz", VALID);
	const { seen, server } = await serving(dir);

	await until(answered(dir, "zz"));
	await server.close();

	expect(seen.map((each) => (each as { request?: string }).request)).toEqual(["zz"]);
	expect(readdirSync(dir).sort()).toEqual([...strangers, "zz.reply"].sort());
	for (const name of strangers) expect(readFileSync(join(dir, name), "utf8")).toBe(VALID);
});

test("a defer that throws leaves the request and writes no reply, is told once, and a later scan answers it", async () => {
	const dir = fresh();
	put(dir, "t1", VALID);
	let failing = true;
	const { seen, errors } = await serving(dir, () => {
		if (failing) throw new Error("the storage failed");
		return { accepted: true, id: "9", at: "2026-11-23T10:00:00.000Z" };
	});

	await until(() => seen.length >= 3);
	expect(existsSync(join(dir, "t1.req"))).toBe(true);
	expect(existsSync(join(dir, "t1.reply"))).toBe(false);
	failing = false;
	await until(answered(dir, "t1"));

	expect(new Set(seen.map((each) => (each as { request?: string }).request))).toEqual(new Set(["t1"]));
	expect(errors.map((error) => error.message)).toEqual(["soma failed to record t1.req: the storage failed"]);
	expect(replyOf(dir, "t1")).toBe("accepted 9 2026-11-23T10:00:00.000Z\n");
	expect(existsSync(join(dir, "t1.req"))).toBe(false);
});

test("a reply that cannot be written leaves the request, and the next scan asks defer again under the same name", async () => {
	const dir = fresh();
	put(dir, "w1", VALID);
	mkdirSync(join(dir, "w1.reply"));
	const { seen, errors } = await serving(dir);

	await until(() => seen.length >= 2);
	expect(existsSync(join(dir, "w1.req"))).toBe(true);
	rmSync(join(dir, "w1.reply"), { recursive: true });
	await until(answered(dir, "w1"));

	expect(new Set(seen.map((each) => (each as { request?: string }).request))).toEqual(new Set(["w1"]));
	expect(errors).toHaveLength(1);
	expect(replyOf(dir, "w1")).toBe("accepted 7 2026-11-23T10:00:00.000Z\n");
});

test("a reply older than 24 hours is removed at a scan, and a fresh one is kept", async () => {
	const dir = fresh();
	mkdirSync(dir, { mode: 0o700 });
	const old = Date.now() / 1000 - 25 * 3600;
	for (const name of ["old.reply", "old.tmp", "fresh.reply"]) writeFileSync(join(dir, name), "accepted 1 x\n");
	utimesSync(join(dir, "old.reply"), old, old);
	utimesSync(join(dir, "old.tmp"), old, old);
	const { server } = await serving(dir);

	await until(() => !existsSync(join(dir, "old.reply")));
	await server.close();

	expect(readdirSync(dir).sort()).toEqual(["fresh.reply", "old.tmp"]);
});

test("a directory open to group or others, or not a directory, is refused; a missing one is made 0700", async () => {
	const open = fresh();
	mkdirSync(open);
	chmodSync(open, 0o750);
	await expect(serving(open)).rejects.toThrow(/is open to group or others \(mode 750\)/);
	chmodSync(open, 0o702);
	await expect(serving(open)).rejects.toThrow(/is open to group or others/);
	const file = fresh();
	writeFileSync(file, "");
	await expect(serving(file)).rejects.toThrow(/is not a directory/);
	const linked = fresh();
	const target = fresh();
	mkdirSync(target, { mode: 0o700 });
	symlinkSync(target, linked);
	await expect(serving(linked)).rejects.toThrow(/is not a directory/);

	const missing = fresh();
	await serving(missing);
	expect(statSync(missing).isDirectory()).toBe(true);
	expect(statSync(missing).mode & 0o777).toBe(0o700);
});

test("close waits for the scan under way and no scan follows it", async () => {
	const dir = fresh();
	put(dir, "c1", VALID);
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const seen: DeferRequest[] = [];
	const server = await serveDrop({
		dir,
		defer: async (request) => {
			seen.push(request);
			await held;
			return { accepted: true, id: "1", at: "x" };
		},
		scanMs: 10,
	});
	await until(() => seen.length === 1);

	const closing = server.close();
	let closed = false;
	void closing.then(() => {
		closed = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(closed).toBe(false);
	release();
	await closing;
	put(dir, "c2", VALID);
	await new Promise((resolve) => setTimeout(resolve, 50));

	expect(replyOf(dir, "c1")).toBe("accepted 1 x\n");
	expect(seen).toHaveLength(1);
	expect(existsSync(join(dir, "c2.req"))).toBe(true);
});
