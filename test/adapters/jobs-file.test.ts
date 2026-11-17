import {
	chmodSync,
	closeSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { jobsFile } from "../../src/adapters/jobs/jobs-file.ts";

const dir = mkdtempSync(join(tmpdir(), "soma-jobs-file-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a write is the JSON value, mode 0600, with no temporary file left beside it", () => {
	const path = join(dir, "a.jobs.json");

	jobsFile(path).write({ version: 1, jobs: [{ card: "a" }] });

	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, jobs: [{ card: "a" }] });
	expect(statSync(path).mode & 0o777).toBe(0o600);
	expect(readdirSync(dir).filter((name) => name.startsWith("a."))).toEqual(["a.jobs.json"]);
});

test("a write over an older file replaces it whole, and keeps the mode", () => {
	const path = join(dir, "b.jobs.json");
	const file = jobsFile(path);
	file.write({ jobs: ["x".repeat(10_000)] });

	file.write({ jobs: [] });

	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ jobs: [] });
	expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("a write replaces the file by rename: a reader that had it open still reads the old value whole", () => {
	const path = join(dir, "c.jobs.json");
	const file = jobsFile(path);
	file.write({ n: 0, filler: "x".repeat(100_000) });
	for (let n = 1; n <= 20; n++) {
		const inode = statSync(path).ino;
		// A reader mid-read holds the file it opened. A write to a temporary file leaves that file as it was and swaps a
		// new one in under the name; a write to the path itself truncates and refills the very file the reader holds.
		const reader = openSync(path, "r");
		try {
			file.write({ n, filler: "y".repeat(100_000) });

			expect(JSON.parse(readFileSync(reader, "utf8"))).toMatchObject({ n: n - 1 });
		} finally {
			closeSync(reader);
		}
		expect(statSync(path).ino).not.toBe(inode);
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ n });
	}
});

test("a write over a stale temporary file left at 0644 still publishes the file as 0600", () => {
	const path = join(dir, "f.jobs.json");
	writeFileSync(`${path}.tmp`, "stale", { mode: 0o644 });
	chmodSync(`${path}.tmp`, 0o644);

	jobsFile(path).write({ version: 2 });

	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 2 });
	expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("read gives back what was written, and nothing when there is no file", () => {
	const path = join(dir, "d.jobs.json");
	const file = jobsFile(path);
	expect(file.read()).toBeUndefined();

	file.write({ version: 1 });

	expect(file.read()).toEqual({ version: 1 });
});

test("read throws on a file that is not JSON", () => {
	const path = join(dir, "e.jobs.json");
	writeFileSync(path, "{ half");

	expect(() => jobsFile(path).read()).toThrow();
});
