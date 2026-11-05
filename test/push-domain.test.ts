import { expect, test } from "vitest";
import { deliveries, escalates, escalation, type PendingPush, PRESETS, pushTarget } from "../src/core/domain/push.ts";

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
	expect(escalation(question, { "chat.terminal": 9 * MIN }, blocked, {}, 20 * MIN, 15 * MIN)).toBe("wait");
	expect(escalation(question, { "chat.terminal": 9 * MIN }, blocked, {}, 25 * MIN, 15 * MIN)).toBe("due");
});

test("a pending push is dropped once the human typed anywhere after it", () => {
	expect(escalation(question, { "chat.telegram": 11 * MIN }, blocked, {}, 25 * MIN, 15 * MIN)).toBe("drop");
});

test("a pending prompt is dropped once its job is no longer blocked on it", () => {
	const answered = [{ card: "c", status: { state: "working" } as const }];
	const another = [{ card: "c", status: { state: "blocked", kind: "permission", fingerprint: "fp2" } as const }];
	expect(escalation(question, {}, answered, {}, 25 * MIN, 15 * MIN)).toBe("drop");
	expect(escalation(question, {}, another, {}, 25 * MIN, 15 * MIN)).toBe("drop");
	expect(escalation(question, {}, [], {}, 25 * MIN, 15 * MIN)).toBe("drop");
});

test("a failure, which offers no choices, is due on time alone", () => {
	const failure: PendingPush = { key: "failure:1", at: 0, kind: "report", content: "schedule:1 failed" };
	expect(escalation(failure, {}, [], {}, 15 * MIN, 15 * MIN)).toBe("due");
});

const foreignQuestion: PendingPush = {
	key: "notice:2",
	at: 10 * MIN,
	kind: "question",
	content: "foreign agent is blocked",
	foreign: { id: "pane-1", told: { fingerprint: "fp", msg: "approve Bash" } },
};

test("a pending foreign push is due while its agent is still at the prompt told, and dropped once it is not", () => {
	const at = { "pane-1": { fingerprint: "fp", msg: "approve Bash" } };
	expect(escalation(foreignQuestion, {}, [], at, 20 * MIN, 15 * MIN)).toBe("wait");
	expect(escalation(foreignQuestion, {}, [], at, 25 * MIN, 15 * MIN)).toBe("due");
	// Answered, at the pane or by respond: the agent is past it, so it is forgotten.
	expect(escalation(foreignQuestion, {}, [], {}, 25 * MIN, 15 * MIN)).toBe("drop");
	// Another prompt told since.
	const another = { "pane-1": { fingerprint: "fp2", msg: "approve Bash" } };
	expect(escalation(foreignQuestion, {}, [], another, 25 * MIN, 15 * MIN)).toBe("drop");
	// Another agent's prompt is none of its business.
	expect(escalation(foreignQuestion, {}, [], { "pane-2": at["pane-1"] }, 25 * MIN, 15 * MIN)).toBe("drop");
});

const TELEGRAM = "chat.telegram";
const TERMINAL = "chat.terminal";
const WEB = "chat.web";

test("instant rings every class, ask rings only an action and logs the rest", () => {
	expect(PRESETS.instant).toEqual({ action: "ring", outcome: "ring", ambient: "ring" });
	expect(PRESETS.ask).toEqual({ action: "ring", outcome: "log", ambient: "log" });
});

test("instant everywhere is the push rule as before: the target rings, every other interface shows it quietly", () => {
	const policies = { [TELEGRAM]: PRESETS.instant, [TERMINAL]: PRESETS.instant, [WEB]: PRESETS.instant };
	for (const messageClass of ["action", "outcome", "ambient"] as const) {
		expect(deliveries(policies, messageClass, TERMINAL)).toEqual({
			[TELEGRAM]: "quiet",
			[TERMINAL]: "ring",
			[WEB]: "quiet",
		});
	}
	// An interface the policies do not name is instant.
	expect(deliveries({}, "outcome", TERMINAL)).toEqual({ [TERMINAL]: "ring" });
});

test("Telegram at ask, the target, rings for an action and does not show an outcome or an ambient report", () => {
	const policies = { [TELEGRAM]: PRESETS.ask, [TERMINAL]: PRESETS.instant };
	expect(deliveries(policies, "action", TELEGRAM)).toEqual({ [TELEGRAM]: "ring", [TERMINAL]: "quiet" });
	// The target at log: nobody rings, and the ring does not fall through to the terminal.
	expect(deliveries(policies, "outcome", TELEGRAM)).toEqual({ [TELEGRAM]: "log", [TERMINAL]: "quiet" });
	expect(deliveries(policies, "ambient", TELEGRAM)).toEqual({ [TELEGRAM]: "log", [TERMINAL]: "quiet" });
});

test("an interface at ask that is not the target shows an action quietly and never shows the rest", () => {
	const policies = { [TELEGRAM]: PRESETS.ask, [TERMINAL]: PRESETS.instant };
	expect(deliveries(policies, "action", TERMINAL)).toEqual({ [TELEGRAM]: "quiet", [TERMINAL]: "ring" });
	expect(deliveries(policies, "outcome", TERMINAL)).toEqual({ [TELEGRAM]: "log", [TERMINAL]: "ring" });
});

test("a custom table: a target whose policy is quiet shows it without a sound, and nobody else rings", () => {
	const custom = { action: "ring", outcome: "quiet", ambient: "log" } as const;
	const policies = { [TELEGRAM]: PRESETS.instant, [WEB]: custom };
	expect(deliveries(policies, "outcome", WEB)).toEqual({ [TELEGRAM]: "quiet", [WEB]: "quiet" });
	expect(deliveries(policies, "ambient", WEB)).toEqual({ [TELEGRAM]: "quiet", [WEB]: "log" });
	expect(deliveries(policies, "action", WEB)).toEqual({ [TELEGRAM]: "quiet", [WEB]: "ring" });
	expect(deliveries(policies, "outcome", TELEGRAM)).toEqual({ [TELEGRAM]: "ring", [WEB]: "quiet" });
});

test("without a target each interface follows its own policy", () => {
	const custom = { action: "ring", outcome: "quiet", ambient: "log" } as const;
	const policies = { [TERMINAL]: PRESETS.instant, [WEB]: custom };
	expect(deliveries(policies, "outcome", undefined)).toEqual({ [TERMINAL]: "ring", [WEB]: "quiet" });
	expect(deliveries(policies, "ambient", undefined)).toEqual({ [TERMINAL]: "ring", [WEB]: "log" });
});

test("an unheeded push escalates to the default interface only when its policy shows that class", () => {
	expect(escalates({}, TELEGRAM, "action")).toBe(true);
	expect(escalates({ [TELEGRAM]: PRESETS.instant }, TELEGRAM, "outcome")).toBe(true);
	expect(escalates({ [TELEGRAM]: PRESETS.ask }, TELEGRAM, "action")).toBe(true);
	expect(escalates({ [TELEGRAM]: PRESETS.ask }, TELEGRAM, "outcome")).toBe(false);
	const quiet = { action: "quiet", outcome: "quiet", ambient: "quiet" } as const;
	expect(escalates({ [TELEGRAM]: quiet }, TELEGRAM, "action")).toBe(true);
	const muted = { action: "log", outcome: "log", ambient: "log" } as const;
	expect(escalates({ [TELEGRAM]: muted }, TELEGRAM, "action")).toBe(false);
});
