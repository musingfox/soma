import { describe, expect, test } from "vitest";
import { type Effect, IllegalTransitionError, transition } from "../src/core/domain/agent-state.ts";
import type { AgentState } from "../src/ports/agent.ts";

const idle: AgentState = { state: "idle" };
const working: AgentState = { state: "working" };
const done: AgentState = { state: "done" };
const error: AgentState = { state: "error" };
const permission: AgentState = { state: "blocked", kind: "permission" };
const question: AgentState = { state: "blocked", kind: "question" };
const auth: AgentState = { state: "blocked", kind: "auth" };
const blocked = [permission, question, auth];

const label = (s: AgentState) => (s.state === "blocked" ? `blocked:${s.kind}` : s.state);

describe("legal transitions and their effects", () => {
	const cases: [AgentState, AgentState, Effect][] = [
		[idle, working, "none"],
		[idle, done, "complete"],
		[idle, error, "fail"],
		[working, idle, "complete"],
		[working, done, "complete"],
		[working, error, "fail"],
		[done, working, "none"],
		[done, idle, "none"],
		...blocked.flatMap((b): [AgentState, AgentState, Effect][] => [
			[idle, b, "wake"],
			[working, b, "wake"],
			[b, working, "none"],
			[b, idle, "complete"],
			[b, done, "complete"],
			[b, error, "fail"],
		]),
		...blocked.flatMap((from) =>
			blocked.filter((to) => to !== from).map((to): [AgentState, AgentState, Effect] => [from, to, "wake"]),
		),
	];
	test.each(cases.map(([f, t, e]) => [label(f), label(t), e, f, t] as const))(
		"%s → %s: %s",
		(_f, _t, effect, from, to) => {
			expect(transition(from, to)).toEqual({ next: to, effect });
		},
	);
});

test.each([idle, working, done, error, ...blocked].map((s) => [label(s), s] as const))(
	"repeating %s is a no-op",
	(_, s) => {
		expect(transition(s, { ...s, msg: "again" })).toEqual({ next: s, effect: "none" });
	},
);

describe("illegal transitions", () => {
	const cases: [AgentState, AgentState][] = [
		[done, error],
		...blocked.map((b): [AgentState, AgentState] => [done, b]),
		...[idle, working, done, ...blocked].map((to): [AgentState, AgentState] => [error, to]),
	];
	test.each(cases.map(([f, t]) => [label(f), label(t), f, t] as const))("%s → %s throws", (_f, _t, from, to) => {
		expect(() => transition(from, to)).toThrow(IllegalTransitionError);
	});
});
