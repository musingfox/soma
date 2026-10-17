// Ported from musingfox/cc-mobile server/herdr/agent-state.test.ts @ d9f0690; backend cases dropped, expectations moved to OSC 7501 states.
/**
 * agent-state.test.ts — HerdrAgentStateSnapshot.
 *
 * The status subscription only speaks on change, so a client that reloads
 * mid-session used to see nothing until the next transition. These cases pin
 * the level-triggered answer: one snapshot, one state per live uuid, and a
 * missing key wherever the daemon has nothing usable to say.
 */

import { describe, expect, test } from "vitest";
import { statesFromSnapshot } from "../../../src/adapters/herdr/agent-state.ts";
import type { SessionSnapshot } from "../../../src/adapters/herdr/schema.ts";

/** A minimal agent record — only pane_id and agent_status matter to the join. */
function agent(pane_id: string, agent_status: string) {
	return {
		terminal_id: "t1",
		agent_status,
		workspace_id: "w1",
		tab_id: "tab1",
		pane_id,
		focused: false,
		revision: 1,
	} as unknown as SessionSnapshot["agents"][number];
}

function snapshot(
	panes: Array<Record<string, unknown>>,
	agents: Array<Record<string, unknown>> = [],
): Pick<SessionSnapshot, "panes" | "agents"> {
	return {
		panes: panes as unknown as SessionSnapshot["panes"],
		agents: agents as unknown as SessionSnapshot["agents"],
	};
}

const resolveOne = (uuid: string) => (uuid === "u1" ? "p1" : undefined);

describe("statesFromSnapshot — pane status mapping", () => {
	test("a working pane reads as working", () => {
		const states = statesFromSnapshot(
			snapshot([{ pane_id: "p1", workspace_id: "w1", agent_status: "working" }]),
			resolveOne,
			["u1"],
		);
		expect(states).toEqual({ u1: { state: "working" } });
	});

	test("a blocked pane reads as blocked", () => {
		const states = statesFromSnapshot(
			snapshot([{ pane_id: "p1", workspace_id: "w1", agent_status: "blocked" }]),
			resolveOne,
			["u1"],
		);
		expect(states).toEqual({ u1: { state: "blocked", kind: "permission" } });
	});

	test("`done` and `idle` stay distinct", () => {
		expect(
			statesFromSnapshot(snapshot([{ pane_id: "p1", workspace_id: "w1", agent_status: "done" }]), resolveOne, ["u1"]),
		).toEqual({ u1: { state: "done" } });
		expect(
			statesFromSnapshot(snapshot([{ pane_id: "p1", workspace_id: "w1", agent_status: "idle" }]), resolveOne, ["u1"]),
		).toEqual({ u1: { state: "idle" } });
	});

	test("a pane without a status falls back to the matching agent record", () => {
		// The carrier an adopted pane populates is not settled, so both are read
		// from the same response rather than betting on one.
		const states = statesFromSnapshot(
			snapshot([{ pane_id: "p1", workspace_id: "w1" }], [agent("p1", "working")]),
			resolveOne,
			["u1"],
		);
		expect(states).toEqual({ u1: { state: "working" } });
	});

	test("`unknown` yields no key at all — a missing state is not idle", () => {
		const states = statesFromSnapshot(
			snapshot([{ pane_id: "p1", workspace_id: "w1", agent_status: "unknown" }]),
			resolveOne,
			["u1"],
		);
		expect(states).toEqual({});
	});

	test("a live uuid with no pane mapping is omitted rather than guessed", () => {
		const states = statesFromSnapshot(
			snapshot([{ pane_id: "p1", workspace_id: "w1", agent_status: "working" }]),
			() => undefined,
			["u2"],
		);
		expect(states).toEqual({});
		expect(Object.hasOwn(states, "u2")).toBe(false);
	});
});
