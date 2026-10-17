import { expect, test } from "vitest";
import { resolveAt } from "../src/core/domain/schedule.ts";

const now = Date.parse("2026-10-18T10:00:00Z");

test("a duration counts from now", () => {
	expect(resolveAt("PT2M", now)).toBe(now + 120_000);
	expect(resolveAt("P1DT1H30S", now)).toBe(now + 86_400_000 + 3_600_000 + 30_000);
});

test("a date-time is taken as is", () => {
	expect(resolveAt("2026-10-18T10:05:00Z", now)).toBe(now + 300_000);
});

test("a past date-time or an unparsable value is rejected", () => {
	expect(() => resolveAt("2026-10-18T09:59:00Z", now)).toThrow(/past/);
	expect(() => resolveAt("in two minutes", now)).toThrow(/ISO 8601/);
	expect(() => resolveAt("P", now)).toThrow(/ISO 8601/);
	expect(() => resolveAt("PT", now)).toThrow(/ISO 8601/);
});
