import { expect, test } from "vitest";
import type { Job } from "../src/core/domain/dispatch.ts";
import { reconcile } from "../src/core/domain/reconcile.ts";

const job = (agent: string, status: Job["status"]): Job => ({
	card: agent,
	agent,
	sessionId: `s-${agent}`,
	status,
	decisions: [],
});

test("a listed agent's status replaces the job's, even across states the core never saw", () => {
	const jobs = [job("a", { state: "done" }), job("b", { state: "working" })];

	const next = reconcile(jobs, [
		{ name: "a", status: { state: "blocked", kind: "question" } },
		{ name: "b", status: { state: "done" } },
	]);

	expect(next.map((j) => j.status)).toEqual([{ state: "blocked", kind: "question" }, { state: "done" }]);
});

test("a listing without a status leaves the job alone", () => {
	const jobs = [job("a", { state: "working" })];

	expect(reconcile(jobs, [{ name: "a" }])).toEqual(jobs);
});

test("an unlisted agent fails its job unless the job already ended", () => {
	const jobs = [job("a", { state: "working" }), job("b", { state: "done" }), job("c", { state: "error" })];

	expect(reconcile(jobs, []).map((j) => j.status)).toEqual([
		{ state: "error", msg: "agent is gone" },
		{ state: "done" },
		{ state: "error" },
	]);
});

test("agents soma did not dispatch never become jobs", () => {
	expect(reconcile([], [{ name: "someone-else", status: { state: "idle" } }])).toEqual([]);
});
