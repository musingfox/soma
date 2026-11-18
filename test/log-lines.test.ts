import { execFileSync } from "node:child_process";
import { Console } from "node:console";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { installErrorPrinting } from "../src/error-printing.ts";
import { installTimestamps, runningFrom, startedLine } from "../src/log-lines.ts";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;
const AT = new Date("2026-11-18T09:30:00.123Z");

/** A console whose output is kept, with soma's error printing and timestamps in place, in main's order. */
function capture(now?: () => Date) {
	const chunks: string[] = [];
	const stream = new Writable({
		write(chunk, _encoding, done) {
			chunks.push(String(chunk));
			done();
		},
	});
	const target = new Console({ stdout: stream, stderr: stream });
	installErrorPrinting(target);
	installTimestamps(target, now);
	return { target, output: () => chunks.join("") };
}

test("each of log, info, warn and error starts its line with the ISO time it was logged and a space", () => {
	for (const method of ["log", "info", "warn", "error"] as const) {
		const { target, output } = capture();
		target[method]("[soma] x");
		expect(output()).toMatch(ISO);
		expect(output().replace(ISO, "")).toBe("[soma] x\n");
	}
});

test("the stamp is the time as toISOString gives it, before what was logged, a non-string or format string alike", () => {
	const { target, output } = capture(() => AT);
	target.log("%s=%d", "a", 1);
	target.warn({ a: 1 });
	target.error();
	expect(output()).toBe(`${AT.toISOString()} a=1\n${AT.toISOString()} { a: 1 }\n${AT.toISOString()} \n`);
});

test("a multi-line message is stamped once, on its first line, and its stack frames are unchanged", () => {
	const { target, output } = capture(() => AT);
	target.error("[soma] event bridge:", new Error("boom"));
	const lines = output().trimEnd().split("\n");
	expect(lines[0]).toBe(`${AT.toISOString()} [soma] event bridge: Error: boom`);
	expect(lines.length).toBeGreaterThan(1);
	for (const line of lines.slice(1)) expect(line).toMatch(/^ {4}at /);
});

test("a ZodError still prints as its issues, stamped, without throwing", () => {
	const { target, output } = capture(() => AT);
	const failed = z.object({ id: z.number() }).safeParse({ id: "42" });
	if (failed.success) throw new Error("expected the value not to parse");

	expect(() => target.error("[soma] telegram:", failed.error)).not.toThrow();

	expect(output().split("\n").slice(0, 2)).toEqual([
		`${AT.toISOString()} [soma] telegram: ZodError: 1 issue`,
		"  id: Expected number, received string",
	]);
});

test("an error whose inspection throws still prints stamped, through error printing's fallback", () => {
	const { target, output } = capture(() => AT);
	class Listed extends Error {
		get errors() {
			return [new Error("inner")];
		}
	}

	expect(() => target.error("[soma] x:", new Listed("outer"))).not.toThrow();

	expect(output()).toMatch(
		new RegExp(`^${AT.toISOString().replaceAll(".", "\\.")} \\[soma\\] x: Error: outer\\n {4}at `),
	);
});

const root = realpathSync(mkdtempSync(join(tmpdir(), "soma-log-lines-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("soma runs from the release a releases/ directory names, through the current link too", () => {
	const release = join(root, "releases", "abc1234");
	mkdirSync(release, { recursive: true });
	symlinkSync("abc1234", join(root, "releases", "current"));

	expect(runningFrom(release)).toBe("release abc1234");
	expect(runningFrom(join(root, "releases", "current"))).toBe("release abc1234");
});

test("elsewhere soma runs from the commit checked out, whatever GIT_ variables a hook exported", () => {
	const repo = join(root, "checkout");
	mkdirSync(repo);
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
	git("init", "--quiet");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--no-verify", "--allow-empty", "-m", "first");
	const sha = git("rev-parse", "--short", "HEAD");
	const saved = process.env.GIT_DIR;
	process.env.GIT_DIR = join(root, "no-such-repo");
	try {
		expect(runningFrom(repo)).toBe(`commit ${sha}`);
	} finally {
		if (saved === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = saved;
	}
	expect(runningFrom(join(root, "releases"))).toBeUndefined();
});

test("the started line names what soma runs from when that is known", () => {
	expect(startedLine("release abc1234")).toBe("[soma] started from release abc1234");
	expect(startedLine(undefined)).toBe("[soma] started");
});
