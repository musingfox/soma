import { describe, expect, test } from "vitest";
import { complete, observe } from "../src/core/domain/bridge.ts";
import type { Job } from "../src/core/domain/dispatch.ts";
import type { AgentState } from "../src/ports/agent.ts";

const job = (status: AgentState, seq?: number, launch?: string): Job => ({
	card: "c",
	agent: "c",
	sessionId: "s",
	status,
	...(seq === undefined ? {} : { seq }),
	...(launch === undefined ? {} : { launch }),
	decisions: [],
});
const blocked: AgentState = { state: "blocked", kind: "permission" };

describe("observe", () => {
	test("an observation under the job's own seq is a repeat", () => {
		const before = job(blocked, 4);
		expect(observe(before, blocked, 4)).toEqual({ job: before, action: "none" });
	});

	test.each([
		["blocked wakes, and keeps the held launch prompt", job({ state: "idle" }, 1, "L"), blocked, "wake", "L"],
		[
			"an auth block escalates instead of waking",
			job({ state: "working" }, 1),
			{ state: "blocked", kind: "auth" },
			"escalate",
			undefined,
		],
		[
			"the first idle after launch sends the launch prompt",
			job(blocked, 1, "L"),
			{ state: "idle" },
			"launch",
			undefined,
		],
		[
			"working drops a launch prompt someone else beat",
			job({ state: "idle" }, 1, "L"),
			{ state: "working" },
			"none",
			undefined,
		],
		["working → idle completes", job({ state: "working" }, 2), { state: "idle" }, "complete", undefined],
		["blocked → idle completes", job(blocked, 2), { state: "idle" }, "complete", undefined],
		["working → done completes", job({ state: "working" }, 2), { state: "done" }, "complete", undefined],
		["done → idle is the agent side settling", job({ state: "done" }, 3), { state: "idle" }, "none", undefined],
		[
			"idle → idle under a moved seq is a turn between samples",
			job({ state: "idle" }, 3),
			{ state: "idle" },
			"complete",
			undefined,
		],
		[
			"done → done under a moved seq is another turn",
			job({ state: "done" }, 3),
			{ state: "done" },
			"complete",
			undefined,
		],
		["idle seen first after dispatch is no turn", job({ state: "idle" }), { state: "idle" }, "none", undefined],
		[
			"done seen first after dispatch is no turn of its own",
			job({ state: "done" }),
			{ state: "done" },
			"none",
			undefined,
		],
	] as const)("%s", (_name, before, status, action, launch) => {
		const result = observe(before, status, 9);
		expect(result.action).toBe(action);
		const handedOver = status.state === "blocked" ? {} : undefined;
		expect(result.job).toEqual({ ...before, status, seq: 9, launch, handedOver });
	});
});

describe("observe a re-reported block", () => {
	const prompt = { state: "blocked", kind: "question", msg: "answer: which?", fingerprint: "fp-1" } as const;
	const handedOver = { fingerprint: "fp-1", msg: "answer: which?" };
	const handed = (seq: number, launch?: string): Job => ({ ...job(prompt, seq, launch), handedOver });

	test("a wake or an escalation remembers the prompt it handed over", () => {
		expect(observe(job({ state: "working" }, 4), prompt, 5)).toEqual({
			job: { ...job(prompt, 5), handedOver },
			action: "wake",
		});
		const auth = { state: "blocked", kind: "auth" } as const;
		expect(observe(job({ state: "working" }, 4), auth, 5)).toEqual({
			job: { ...job(auth, 5), handedOver: {} },
			action: "escalate",
		});
	});

	test("the prompt last handed over, under a new seq, records the seq and hands nothing over", () => {
		const before = handed(4, "L");
		expect(observe(before, { ...prompt }, 5)).toEqual({ job: { ...before, seq: 5 }, action: "none" });
	});

	test.each([
		["another fingerprint wakes", { ...prompt, fingerprint: "fp-2" }, "wake"],
		["another msg wakes", { ...prompt, msg: "answer: which one?" }, "wake"],
		["another auth prompt escalates", { ...prompt, kind: "auth", fingerprint: "fp-2" }, "escalate"],
	] as const)("%s", (_name, status, action) => {
		expect(observe(handed(4), status, 5).action).toBe(action);
	});

	test("a stored blocked status that was never handed over, as reconcile writes, is handed over", () => {
		expect(observe(job(prompt, 4), prompt, 5).action).toBe("wake");
		expect(observe(job(prompt), prompt, 5).action).toBe("wake");
		expect(observe(job({ state: "blocked", kind: "auth" }), { state: "blocked", kind: "auth" }, 5).action).toBe(
			"escalate",
		);
	});

	test("an observed working forgets the prompt, so the same one wakes again", () => {
		const working = observe(handed(4), { state: "working" }, 5).job;
		expect(working.handedOver).toBeUndefined();
		expect(observe(working, prompt, 6).action).toBe("wake");
	});
});

describe("complete", () => {
	const finished = (resultId?: string) => ({
		job: { ...job({ state: "idle" }, 9), ...(resultId === undefined ? {} : { resultId }) },
		action: "complete" as const,
	});

	test("the reply already recorded is no new turn", () => {
		const observed = finished("msg_1");
		expect(complete(observed, { id: "msg_1", text: "結果：完成" })).toEqual({ job: observed.job, action: "none" });
	});

	test.each([
		["a new reply is a turn", "msg_1"],
		["the first reply is a turn", undefined],
	] as const)("%s", (_name, stored) => {
		expect(complete(finished(stored), { id: "msg_2", text: "結果：需要你" })).toEqual({
			job: { ...finished(stored).job, outcome: "需要你", resultId: "msg_2" },
			action: "complete",
		});
	});

	test("an unreadable reply is a turn of unknown outcome, and keeps the recorded id", () => {
		expect(complete(finished("msg_1"), undefined)).toEqual({
			job: { ...finished("msg_1").job, outcome: "未知" },
			action: "complete",
		});
	});

	test("anything but a complete passes through", () => {
		const observed = { job: job({ state: "working" }, 2), action: "none" as const };
		expect(complete(observed, { id: "msg_1", text: "x" })).toBe(observed);
	});
});

describe("complete a transcript that ends without a reply", () => {
	const idle = { job: { ...job({ state: "idle" }, 9), resultId: "u-1" }, action: "complete" as const };

	test("is the same turn when its last record was recorded", () => {
		expect(complete(idle, { id: "u-1" })).toEqual({ job: idle.job, action: "none" });
	});

	test("is a turn of unknown outcome under a new last record, which it stores", () => {
		expect(complete(idle, { id: "u-2" })).toEqual({
			job: { ...idle.job, outcome: "未知", resultId: "u-2" },
			action: "complete",
		});
	});

	test("after a turn with a reply is a new turn of unknown outcome", () => {
		const replied = complete({ ...idle, job: job({ state: "done" }, 3) }, { id: "a-1", text: "結果：需要你" }).job;
		expect(replied).toMatchObject({ outcome: "需要你", resultId: "a-1" });
		const interrupted = complete({ job: { ...replied, seq: 4 }, action: "complete" }, { id: "u-2" });
		expect(interrupted).toEqual({ job: { ...replied, seq: 4, outcome: "未知", resultId: "u-2" }, action: "complete" });
		expect(complete({ job: { ...interrupted.job, seq: 5 }, action: "complete" }, { id: "u-2" }).action).toBe("none");
	});
});

test("a job whose move could not read its last record takes the first it reads as that record, and records no turn", () => {
	const moved: Job = { ...job({ state: "idle" }, 1), outcome: "完成", resultId: "old", resultUnread: true };
	const observed = observe(moved, { state: "idle" }, 2);
	expect(observed.action).toBe("complete");

	const { job: next, action } = complete(observed, { id: "cut", text: "結果：失敗\npartial" });

	expect(action).toBe("none");
	expect(next).toMatchObject({ resultId: "cut", outcome: "完成", seq: 2 });
	expect(next.resultUnread).toBeUndefined();
});

test("a job whose move could not read its last record, and that reads nothing now, goes on waiting to read it", () => {
	const moved: Job = { ...job({ state: "idle" }, 1), resultId: "old", resultUnread: true };

	const { job: next, action } = complete(observe(moved, { state: "idle" }, 2), undefined);

	expect(action).toBe("none");
	expect(next).toMatchObject({ resultId: "old", resultUnread: true });
});
