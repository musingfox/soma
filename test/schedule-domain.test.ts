import { expect, test } from "vitest";
import { nextFire, parseCron, resolveAt } from "../src/core/domain/schedule.ts";

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

// Built with local fields, so each expectation holds in whatever zone the machine is in.
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test("a step, a range, a stepped range and a list each pick their minutes", () => {
	expect(nextFire("*/15 * * * *", at(2026, 11, 23, 10, 1))).toBe(at(2026, 11, 23, 10, 15));
	expect(nextFire("10-12 * * * *", at(2026, 11, 23, 10, 12))).toBe(at(2026, 11, 23, 11, 10));
	expect(nextFire("0-30/20 * * * *", at(2026, 11, 23, 10, 21))).toBe(at(2026, 11, 23, 11, 0));
	expect(nextFire("5,50 9 * * *", at(2026, 11, 23, 9, 6))).toBe(at(2026, 11, 23, 9, 50));
	expect(nextFire("0 8 1 */3 *", at(2026, 11, 23))).toBe(at(2027, 1, 1, 8));
});

test("the next fire is strictly after the given time, at a whole minute", () => {
	expect(nextFire("30 10 * * *", at(2026, 11, 23, 10, 30))).toBe(at(2026, 11, 24, 10, 30));
	expect(nextFire("* * * * *", at(2026, 11, 23, 10, 30))).toBe(at(2026, 11, 23, 10, 31));
	expect(nextFire("* * * * *", at(2026, 11, 23, 10, 30) + 59_999)).toBe(at(2026, 11, 23, 10, 31));
	expect(nextFire("30 10 * * *", at(2026, 11, 23, 10, 30) - 1)).toBe(at(2026, 11, 23, 10, 30));
});

test("day of week 7 is Sunday, as 0 is", () => {
	// 2026-11-23 is a Monday.
	expect(nextFire("0 9 * * 7", at(2026, 11, 23))).toBe(at(2026, 11, 29, 9));
	expect(nextFire("0 9 * * 0", at(2026, 11, 23))).toBe(at(2026, 11, 29, 9));
	expect(nextFire("0 9 * * 5-7", at(2026, 11, 23))).toBe(at(2026, 11, 27, 9));
});

test("with both day fields restricted a day matches when either does, otherwise both must", () => {
	// The 1st of December 2026 is a Tuesday; the first Friday after 2026-11-23 is the 27th.
	expect(nextFire("0 9 1 * 5", at(2026, 11, 23))).toBe(at(2026, 11, 27, 9));
	expect(nextFire("0 9 1 * 5", at(2026, 11, 27, 9))).toBe(at(2026, 12, 1, 9));
	expect(nextFire("0 9 1 * *", at(2026, 11, 23))).toBe(at(2026, 12, 1, 9));
	expect(nextFire("0 9 * * 5", at(2026, 11, 28))).toBe(at(2026, 12, 4, 9));
	// Restricted by a step as well: only a literal `*` leaves a day field open.
	expect(nextFire("0 9 */10 * 1", at(2026, 11, 23, 10))).toBe(at(2026, 11, 30, 9));
});

test("each kind of malformed cron is rejected, naming the field or the reason", () => {
	expect(() => parseCron("* * * *")).toThrow(/5 fields/);
	expect(() => parseCron("* * * * * *")).toThrow(/5 fields/);
	expect(() => parseCron("")).toThrow(/5 fields/);
	expect(() => parseCron("60 * * * *")).toThrow(/minute field .*0-59/);
	expect(() => parseCron("* 24 * * *")).toThrow(/hour field .*0-23/);
	expect(() => parseCron("* * 0 * *")).toThrow(/day of month field .*1-31/);
	expect(() => parseCron("* * * 13 *")).toThrow(/month field .*1-12/);
	expect(() => parseCron("* * * * 8")).toThrow(/day of week field .*0-7/);
	expect(() => parseCron("* * * * MON")).toThrow(/day of week field has "MON"/);
	expect(() => parseCron("* * * JAN *")).toThrow(/month field has "JAN"/);
	expect(() => parseCron("@daily")).toThrow(/5 fields/);
	expect(() => parseCron("* * ? * *")).toThrow(/day of month field has "\?"/);
	expect(() => parseCron("* * L * *")).toThrow(/day of month field has "L"/);
	expect(() => parseCron("* * 15W * *")).toThrow(/day of month field has "15W"/);
	expect(() => parseCron("* * * * 1#2")).toThrow(/day of week field has "1#2"/);
	expect(() => parseCron("30-10 * * * *")).toThrow(/minute field .*ends before it starts/);
	expect(() => parseCron("*/0 * * * *")).toThrow(/minute field .*step of 0/);
	expect(() => parseCron("5/2 * * * *")).toThrow(/minute field .*step follows/);
	expect(() => parseCron("1,,2 * * * *")).toThrow(/minute field has ""/);
	expect(() => nextFire("* * * * 8", at(2026, 11, 23))).toThrow(RangeError);
});

test("a cron that matches no minute in five years is rejected", () => {
	expect(() => nextFire("0 0 30 2 *", at(2026, 11, 23))).toThrow(/matches no minute in the next five years/);
	expect(() => nextFire("0 0 31 4 *", at(2026, 11, 23))).toThrow(RangeError);
	// A leap day is within five years of any time.
	expect(nextFire("0 0 29 2 *", at(2026, 11, 23))).toBe(at(2028, 2, 29));
});
