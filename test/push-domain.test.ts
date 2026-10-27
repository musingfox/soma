import { expect, test } from "vitest";
import { escalation, type PendingPush, pushTarget } from "../src/core/domain/push.ts";

const MIN = 60_000;

test("the push goes to the interface typed on last within the window, else to the fallback", () => {
	const presence = { "chat.telegram": 10 * MIN, "chat.terminal": 20 * MIN };
	expect(pushTarget(presence, 30 * MIN, 15 * MIN, "chat.telegram")).toBe("chat.terminal");
	expect(pushTarget(presence, 36 * MIN, 15 * MIN, "chat.telegram")).toBe("chat.telegram");
	expect(pushTarget({ "chat.terminal": 0 }, 16 * MIN, 15 * MIN, "chat.telegram")).toBe("chat.telegram");
	expect(pushTarget({}, 0, 15 * MIN, "chat.telegram")).toBe("chat.telegram");
});

const question: PendingPush = {
	key: "notice:1",
	at: 10 * MIN,
	kind: "question",
	content: "trust it?",
	choices: { card: "c", fingerprint: "fp", options: [{ id: "1", label: "Yes" }] },
};
const blocked = [{ card: "c", status: { state: "blocked", kind: "permission", fingerprint: "fp" } as const }];

test("a pending push waits, then is due, while nobody typed and the prompt is still up", () => {
	expect(escalation(question, { "chat.terminal": 9 * MIN }, blocked, 20 * MIN, 15 * MIN)).toBe("wait");
	expect(escalation(question, { "chat.terminal": 9 * MIN }, blocked, 25 * MIN, 15 * MIN)).toBe("due");
});

test("a pending push is dropped once the human typed anywhere after it", () => {
	expect(escalation(question, { "chat.telegram": 11 * MIN }, blocked, 25 * MIN, 15 * MIN)).toBe("drop");
});

test("a pending prompt is dropped once its job is no longer blocked on it", () => {
	const answered = [{ card: "c", status: { state: "working" } as const }];
	const another = [{ card: "c", status: { state: "blocked", kind: "permission", fingerprint: "fp2" } as const }];
	expect(escalation(question, {}, answered, 25 * MIN, 15 * MIN)).toBe("drop");
	expect(escalation(question, {}, another, 25 * MIN, 15 * MIN)).toBe("drop");
	expect(escalation(question, {}, [], 25 * MIN, 15 * MIN)).toBe("drop");
});

test("a failure, which offers no choices, is due on time alone", () => {
	const failure: PendingPush = { key: "failure:1", at: 0, kind: "report", content: "schedule:1 failed" };
	expect(escalation(failure, {}, [], 15 * MIN, 15 * MIN)).toBe("due");
});
