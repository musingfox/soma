import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { liveSession, signalReaches } from "../../src/agent-cli/process-session.ts";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await chmod(directory, 0o700).catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
});

const SESSION = "7e33597b-e33d-4c6d-a700-e21b2f54223e";
const OTHER = "0b6f6c1e-8a1c-4d5e-9f00-1234567890ab";

async function sessions(files: Record<string, unknown>) {
	const directory = await mkdtemp(join(tmpdir(), "soma-sessions-"));
	directories.push(directory);
	for (const [name, content] of Object.entries(files)) {
		await writeFile(join(directory, name), typeof content === "string" ? content : JSON.stringify(content));
	}
	return directory;
}

const record = (pid: number, sessionId = SESSION) => ({
	pid,
	sessionId,
	cwd: "/Users/me/repo",
	startedAt: 1,
	procStart: "Mon Nov 23 12:00:00 2026",
	kind: "interactive",
});

test("a claude alive now whose pid file names the session is found, with its pid and cwd", async () => {
	const dir = await sessions({ "41.json": record(41, OTHER), "42.json": record(42) });

	expect(await liveSession(dir, (pid) => pid === 42)(SESSION)).toEqual({ pid: 42, cwd: "/Users/me/repo" });
});

test("another session, a dead pid, a file not named for its pid and one that does not parse are no open session", async () => {
	const dir = await sessions({
		"41.json": record(41, OTHER),
		"43.json": record(43),
		"44.json": record(45),
		"46.json": "{ not json",
		"notes.txt": "x",
	});
	const alive = (pid: number) => pid !== 43;

	expect(await liveSession(dir, alive)(SESSION)).toBeUndefined();
	expect(await liveSession(dir, alive)(OTHER)).toEqual({ pid: 41, cwd: "/Users/me/repo" });
});

test("a sessions directory that does not exist holds no open session; one that cannot be listed throws", async () => {
	const dir = await sessions({ "a-file": "x" });
	await mkdir(join(dir, "locked"));
	await chmod(join(dir, "locked"), 0o000);

	expect(await liveSession(join(dir, "missing"), () => true)(SESSION)).toBeUndefined();
	await expect(liveSession(join(dir, "a-file"), () => true)(SESSION)).rejects.toThrow(/ENOTDIR/);
	await expect(liveSession(join(dir, "locked"), () => true)(SESSION)).rejects.toThrow(/EACCES/);
	await chmod(join(dir, "locked"), 0o700);
});

test("signal 0 reaches this process, and launchd's, which is another user's, and no pid that has exited", () => {
	expect(signalReaches(process.pid)).toBe(true);
	expect(signalReaches(1)).toBe(true);
	expect(signalReaches(2 ** 22 + 12345)).toBe(false);
});
