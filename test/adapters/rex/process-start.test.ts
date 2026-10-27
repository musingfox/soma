import { afterEach, expect, test } from "vitest";
import { readProcessStart } from "../../../src/adapters/rex/process-start.ts";

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
