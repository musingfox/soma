import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const harness = new URL("../src/core/harness.ts", import.meta.url).href;
const script = `
import { acquireDbLock, DbLockedError } from ${JSON.stringify(harness)};
try {
	await acquireDbLock(process.argv[1]);
	console.log("locked");
	process.stdin.resume();
} catch (error) {
	if (!(error instanceof DbLockedError)) throw error;
	console.log(error.message);
	process.exit(1);
}
`;

const children: ChildProcess[] = [];

const start = (db: string) => {
	const child = spawn(process.execPath, ["--input-type=module", "-e", script, db], {
		stdio: ["pipe", "pipe", "inherit"],
	});
	children.push(child);
	let out = "";
	child.stdout.on("data", (chunk) => {
		out += chunk;
	});
	let closed = false;
	child.once("close", () => {
		closed = true;
	});
	const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
	// The first line, or a rejection when the child exits without printing one.
	const line = () =>
		new Promise<string>((resolve, reject) => {
			const check = () => {
				if (out.includes("\n")) resolve(out.trim());
				// "close" comes after the last stdout chunk, unlike "exit".
				else if (closed) reject(new Error(`child exited without output: ${child.exitCode ?? child.signalCode}`));
				else setTimeout(check, 50);
			};
			check();
		});
	return { child, exited, line };
};

test("a second process on the same db exits 1; a SIGKILLed holder's lock is taken over", {
	timeout: 30_000,
}, async () => {
	const dir = mkdtempSync(join(tmpdir(), "soma-lock-"));
	const db = join(dir, "missing", "soma.db");
	try {
		const first = start(db);
		expect(await first.line()).toBe("locked");
		const second = start(db);
		expect(await second.line()).toContain("soma.db");
		expect(await second.exited).toBe(1);
		first.child.kill("SIGKILL");
		await first.exited;
		const third = start(db);
		expect(await third.line()).toBe("locked");
	} finally {
		for (const child of children) child.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});
