import { describe, expect, test } from "vitest";
import { observe } from "../src/core/domain/bridge.ts";
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
		["done → idle is herdr settling", job({ state: "done" }, 3), { state: "idle" }, "none", undefined],
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
		expect(result.job).toEqual({ ...before, status, seq: 9, launch });
	});
});
