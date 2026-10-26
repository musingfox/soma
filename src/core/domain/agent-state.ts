import type { AgentState } from "../../ports/agent.ts";

export type Effect = "none" | "wake" | "complete" | "fail";

export interface Transition {
	readonly next: AgentState;
	readonly effect: Effect;
}

type State = AgentState["state"];

// done → working is a follow-up prompt; done → idle is the agent side settling after done.
// error is terminal: a failed job is re-dispatched, not revived.
const allowed: Readonly<Record<State, readonly State[]>> = {
	idle: ["working", "blocked", "done", "error"],
	working: ["idle", "blocked", "done", "error"],
	blocked: ["working", "blocked", "idle", "done", "error"],
	done: ["working", "idle"],
	error: [],
};

export class IllegalTransitionError extends Error {
	constructor(from: AgentState, to: AgentState) {
		super(`illegal agent transition ${from.state} → ${to.state}`);
	}
}

function same(a: AgentState, b: AgentState): boolean {
	if (a.state === "blocked" && b.state === "blocked") return a.kind === b.kind;
	return a.state === b.state;
}

export function transition(from: AgentState, to: AgentState): Transition {
	if (same(from, to)) return { next: from, effect: "none" };
	if (!allowed[from.state].includes(to.state)) throw new IllegalTransitionError(from, to);
	switch (to.state) {
		case "blocked":
			return { next: to, effect: "wake" };
		case "done":
			return { next: to, effect: "complete" };
		case "idle":
			return { next: to, effect: from.state === "working" || from.state === "blocked" ? "complete" : "none" };
		case "error":
			return { next: to, effect: "fail" };
		case "working":
			return { next: to, effect: "none" };
	}
}
