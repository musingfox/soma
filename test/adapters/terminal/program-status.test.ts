import { describe, expect, test } from "vitest";
import {
	formatProgramStatus,
	isProgramStatusReply,
	isRecordId,
	type ProgramStatus,
} from "../../../src/adapters/terminal/program-status.ts";

// The receiving side of https://www.superlogical.com/rex/docs/build/program-status, written from the spec's
// Syntax, Keys and Limits sections: it returns why a terminal would discard the report, or the decoded pairs.
function receive(sequence: string): { error: string } | { pairs: Record<string, string> } {
	if (Buffer.byteLength(sequence) > 4096) return { error: "sequence over 4096 bytes" };
	const [osc, st] = ["\x1b]7501;", "\x1b\\"];
	if (!sequence.startsWith(osc) || !sequence.endsWith(st)) return { error: "not an OSC 7501 report" };
	const pairs: Record<string, string> = {};
	for (const pair of sequence.slice(osc.length, -st.length).split(":")) {
		const [, key, value] = /^([a-z]+)=([A-Za-z0-9_.,+/=-]*)$/.exec(pair) ?? [];
		if (key === undefined || value === undefined) return { error: `malformed pair ${pair}` };
		if (key.length > 16) return { error: "key over 16 bytes" };
		pairs[key] = value;
	}
	for (const [key, encoded, decoded] of [
		["msg", 2732, 2048],
		["title", 256, 192],
	] as const) {
		const value = pairs[key];
		if (value === undefined) continue;
		if (value.length > encoded) return { error: `${key} over ${encoded} encoded bytes` };
		const text = Buffer.from(value, "base64");
		if (text.length > decoded) return { error: `${key} over ${decoded} decoded bytes` };
		const codes = Array.from(text.toString("utf8"), (char) => char.codePointAt(0) ?? 0);
		if (codes.some((code) => code <= 0x1f || (code >= 0x7f && code <= 0x9f))) {
			return { error: `${key} has a control character` };
		}
		pairs[key] = text.toString("utf8");
	}
	if ((pairs.app ?? "").length > 32) return { error: "app over 32 bytes" };
	return { pairs };
}

const pairsOf = (status: ProgramStatus) => {
	const received = receive(formatProgramStatus(status));
	if ("error" in received) throw new Error(received.error);
	return received.pairs;
};

describe("formatProgramStatus", () => {
	test("reports a child record with id, title, app and kind", () => {
		expect(
			pairsOf({
				state: "blocked",
				id: "job/terminal-osc7501",
				app: "soma",
				kind: "question",
				title: "卡片",
				message: "?",
			}),
		).toEqual({ state: "blocked", id: "job/terminal-osc7501", app: "soma", kind: "question", title: "卡片", msg: "?" });
	});

	test("addresses the root record when id is absent", () => {
		expect(pairsOf({ state: "working", app: "soma" })).toEqual({ state: "working", app: "soma" });
	});

	test("sends kind only with blocked", () => {
		expect(pairsOf({ state: "working", kind: "question" })).toEqual({ state: "working" });
	});

	test("replaces control characters in msg and title, so terminals do not discard the report", () => {
		const pairs = pairsOf({ state: "done", id: "a", title: "line\none", message: "a\tb\u0007c\u009bd\r\n" });
		expect(pairs.title).toBe("line one");
		expect(pairs.msg).toBe("a b c d");
	});

	test("cuts msg and title at the decoded limits without splitting a character", () => {
		const pairs = pairsOf({ state: "done", id: "a", title: "題".repeat(100), message: "訊".repeat(1000) });
		expect(Buffer.byteLength(pairs.title as string)).toBe(192);
		expect(Buffer.byteLength(pairs.msg as string)).toBe(2046);
		expect(pairs.msg).toBe("訊".repeat(682));
	});

	test("keeps the largest report within every limit", () => {
		const id = Array.from({ length: 4 }, (_, i) => `${i}`.repeat(31)).join("/");
		const sequence = formatProgramStatus({
			state: "blocked",
			id,
			app: "a".repeat(32),
			kind: "permission",
			title: "x".repeat(500),
			message: "y".repeat(5000),
		});
		expect(receive(sequence)).not.toHaveProperty("error");
		expect(Buffer.byteLength(sequence)).toBeLessThan(3300);
	});

	test("omits an app outside the character set", () => {
		expect(pairsOf({ state: "idle", app: "so ma" })).toEqual({ state: "idle" });
	});

	test("throws on an invalid id instead of falling back to the root record", () => {
		expect(() => formatProgramStatus({ state: "done", id: "job/has space" })).toThrow(/record id/);
	});
});

test("isRecordId follows the id grammar and limits", () => {
	expect(isRecordId("job/terminal-osc7501")).toBe(true);
	expect(isRecordId("a".repeat(32))).toBe(true);
	expect(isRecordId("a".repeat(33))).toBe(false);
	expect(isRecordId(Array(8).fill("a").join("/"))).toBe(true);
	expect(isRecordId(Array(9).fill("a").join("/"))).toBe(false);
	expect(isRecordId(Array(5).fill("a".repeat(32)).join("/"))).toBe(false);
	expect(isRecordId("job//x")).toBe(false);
	expect(isRecordId("")).toBe(false);
});

test("isProgramStatusReply accepts replies with or without pairs", () => {
	expect(isProgramStatusReply("\x1b]7501;?\x1b\\")).toBe(true);
	expect(isProgramStatusReply("\x1b]7501;?:states=idle,working\x07")).toBe(true);
	expect(isProgramStatusReply("\x1b[?62;22c")).toBe(false);
});
