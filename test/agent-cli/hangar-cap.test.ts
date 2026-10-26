// Ported from musingfox/cc-mobile server/__tests__/hangar-cap.test.ts @ d9f0690; describeHangarCap case dropped.
import { describe, expect, test } from "vitest";
import { readPerfCoresViaSysctl, resolveHangarCapWithSource } from "../../src/agent-cli/hangar-cap.ts";

describe("readPerfCoresViaSysctl", () => {
	test("reads the count via the absolute sysctl path", () => {
		const calls: string[][] = [];
		const n = readPerfCoresViaSysctl((argv) => {
			calls.push(argv);
			return { exitCode: 0, stdout: "6\n" };
		});
		expect(n).toBe(6);
		expect(calls).toEqual([["/usr/sbin/sysctl", "-n", "hw.perflevel0.physicalcpu"]]);
	});

	test("non-zero exit -> null", () => {
		expect(readPerfCoresViaSysctl(() => ({ exitCode: 1, stdout: "" }))).toBeNull();
	});

	test("non-numeric output -> null", () => {
		expect(readPerfCoresViaSysctl(() => ({ exitCode: 0, stdout: "abc\n" }))).toBeNull();
	});

	test("zero -> null", () => {
		expect(readPerfCoresViaSysctl(() => ({ exitCode: 0, stdout: "0\n" }))).toBeNull();
	});

	test("a throwing runner -> null", () => {
		expect(
			readPerfCoresViaSysctl(() => {
				throw new Error("ENOENT");
			}),
		).toBeNull();
	});
});

describe("resolveHangarCapWithSource", () => {
	test("source: blank override counts as unset and names the core count", () => {
		expect(resolveHangarCapWithSource("   ", () => 6)).toEqual({
			cap: 4,
			source: "perf-cores",
			cores: 6,
		});
	});

	test("source: a pinned value names the override and skips the reader", () => {
		let calls = 0;
		const r = resolveHangarCapWithSource("3", () => {
			calls++;
			return 6;
		});
		expect(r).toEqual({ cap: 3, source: "override" });
		expect(calls).toBe(0);
	});

	test("source: an unreadable count names the fallback", () => {
		expect(resolveHangarCapWithSource(undefined, () => null)).toEqual({
			cap: 4,
			source: "unreadable",
		});
	});
});
