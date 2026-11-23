import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { readProcessChildren, readProcessStart } from "../../../src/adapters/rex/process-start.ts";

const zone = process.env.TZ;
afterEach(() => {
	if (zone === undefined) delete process.env.TZ;
	else process.env.TZ = zone;
});

test("a process's start is the same instant whatever TZ soma runs under", async () => {
	const startedAt = async (tz: string) => {
		process.env.TZ = tz;
		return readProcessStart(process.pid);
	};

	const taipei = await startedAt("Asia/Taipei");
	const utc = await startedAt("UTC");

	expect(taipei).toBeDefined();
	expect(utc).toBe(taipei);
	// ps tells the start to the second.
	const started = Date.now() - process.uptime() * 1000;
	expect(Math.abs((utc as number) - started)).toBeLessThan(2_000);
});

test("a process that is gone has no start", async () => {
	expect(await readProcessStart(2 ** 22 + 12_345)).toBeUndefined();
});

test("the children of a process are listed by pid, and a pid no process holds has none", async () => {
	const child = spawn("/bin/sleep", ["5"], { stdio: "ignore" });
	try {
		expect(await readProcessChildren(process.pid)).toContain(child.pid);
		expect(await readProcessChildren(2 ** 22 + 12345)).toEqual([]);
	} finally {
		child.kill();
		await once(child, "exit");
	}
});
