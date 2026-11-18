import { expect, test } from "vitest";
import { type DreamEntry, type DreamRecords, redact, renderDreamInput } from "../src/core/domain/dream.ts";

const now = Date.now();

const render = (records: Partial<DreamRecords>) =>
	renderDreamInput({
		since: now - 24 * 60 * 60_000,
		until: now,
		timeZone: "UTC",
		entries: [],
		unanswered: new Map(),
		stopped: new Set(),
		facts: [],
		memory: { lines: [], revisions: [] },
		...records,
	});

const toolResult = (text: string): DreamEntry => ({
	id: 7,
	kind: "pi.tool-result",
	model: [{ role: "toolResult", toolName: "bash", timestamp: now - 1000, content: [{ type: "text", text }] }],
});

test("a bot token inside a Telegram API URL is replaced", () => {
	const out = redact("curl https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ/getMe");
	expect(out).toBe("curl https://api.telegram.org/bot[secret]/getMe");
});

test("a long token is redacted before a cut could leave less than 40 of its characters", () => {
	const token = "Q7r8S9t0U1v2W3x4Y5z6A7b8C9d0E1f2A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
	// The tool result's cut at 160 falls 39 characters into the token.
	const out = render({ entries: [toolResult(`${"，".repeat(120)} ${token}`)] });
	expect(out).not.toContain(token.slice(0, 20));
	expect(out).toContain("[long-token]");
});

test("a provider key in a log line is redacted before the profile erases its ids", () => {
	const key =
		"sk-ant-api03-Zq8vKxLmNpRtWyBcDfGhJk-QwErTyUiOpAsDfGhJkLzXcVbNm-Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLlMmNnOoPp-QqRrSsTtAA";
	const log = `${new Date(now - 1000).toISOString()} [soma] anthropic: 401 for key ${key}`;
	const out = render({ log: { text: log } });
	expect(out).toContain("1｜[soma] anthropic: 401 for key [secret]");
	for (const part of ["QwErTyUiOpAsDfGhJkLzXcVbNm", "QqRrSsTtAA"]) expect(out).not.toContain(part);
});
