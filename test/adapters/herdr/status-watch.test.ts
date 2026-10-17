import { expect, test } from "vitest";
import type { SessionSnapshot } from "../../../src/adapters/herdr/schema.ts";
import { createStatusWatch, pollEvery } from "../../../src/adapters/herdr/status-watch.ts";
import type { SubscribeEventsOptions } from "../../../src/adapters/herdr/subscribe.ts";
import type { AgentStatusEvent } from "../../../src/ports/agent.ts";

type Row = { name?: string; agent_status: string; state_change_seq?: number };

function harness(listening = () => true) {
	let rows: Row[] = [];
	let tick: () => void = () => {};
	let subscription: SubscribeEventsOptions | undefined;
	let snapshots = 0;
	const events: AgentStatusEvent[] = [];
	const watch = createStatusWatch({
		subscribe: async (options) => {
			subscription = options;
			return { stop() {} };
		},
		snapshot: async () => {
			snapshots += 1;
			return { agents: rows.map((row) => ({ pane_id: "p", ...row })) } as unknown as Pick<SessionSnapshot, "agents">;
		},
		onStatus: (event) => events.push(event),
		listening,
		setIntervalFn: (fn) => {
			tick = fn;
			return 1;
		},
		clearIntervalFn: () => {},
	});
	return {
		watch,
		events,
		snapshots: () => snapshots,
		set: (next: Row[]) => {
			rows = next;
		},
		tick: async (times = 1) => {
			for (let i = 0; i < times; i++) {
				tick();
				await new Promise((resolve) => setImmediate(resolve));
			}
		},
		streamEvent: () => subscription?.onEvent({ event: "pane_updated", data: {} } as never),
	};
}

test("a status is reported once per state_change_seq, however many snapshots repeat it", async () => {
	const h = harness();
	await h.watch.start();
	h.set([{ name: "a", agent_status: "blocked", state_change_seq: 1 }]);
	await h.tick(5);
	h.set([{ name: "a", agent_status: "idle", state_change_seq: 2 }]);
	await h.tick(3);
	h.set([{ name: "a", agent_status: "idle", state_change_seq: 4 }]);
	await h.tick();

	expect(h.events).toEqual([
		{ agent: "a", status: { state: "blocked", kind: "permission" }, seq: 1 },
		{ agent: "a", status: { state: "idle" }, seq: 2 },
		{ agent: "a", status: { state: "idle" }, seq: 4 },
	]);
});

test("unnamed agents, unknown statuses and rows without a counter are no claim", async () => {
	const h = harness();
	await h.watch.start();
	h.set([
		{ agent_status: "working", state_change_seq: 1 },
		{ name: "b", agent_status: "unknown", state_change_seq: 0 },
		{ name: "c", agent_status: "working" },
	]);
	await h.tick(2);
	expect(h.events).toEqual([]);
});

test("with nobody listening the poll backs off to 30 ticks, and a stream event does not shortcut it", async () => {
	const h = harness(() => false);
	await h.watch.start();
	h.streamEvent();
	await h.tick(29);
	expect(h.snapshots()).toBe(0);
	await h.tick();
	expect(h.snapshots()).toBe(1);
});

test("a listener with no agent running polls every 5 ticks, and a stream event takes the next one", async () => {
	const h = harness();
	await h.watch.start();
	await h.tick(); // the arrival look
	expect(h.snapshots()).toBe(1);
	await h.tick(4);
	expect(h.snapshots()).toBe(1);
	h.streamEvent();
	await h.tick();
	expect(h.snapshots()).toBe(2);
});

test.each([
	[true, false, true, 1],
	[true, false, false, 5],
	[false, true, true, 3],
	[false, false, true, 30],
])("pollEvery(listening=%s, pushing=%s, running=%s) is %i ticks", (listening, pushing, running, ticks) => {
	expect(pollEvery(listening, pushing, running)).toBe(ticks);
});

test("a blocked agent is reported as read off its screen, and a slow read is not overtaken", async () => {
	let rows: Row[] = [{ name: "a", agent_status: "blocked", state_change_seq: 1 }];
	let release: () => void = () => {};
	const events: AgentStatusEvent[] = [];
	let resync: ((snapshot: Pick<SessionSnapshot, "agents">) => void) | undefined;
	const watch = createStatusWatch({
		subscribe: async (options) => {
			resync = options.onResync as typeof resync;
			return { stop() {} };
		},
		snapshot: async () => ({ agents: rows.map((row) => ({ pane_id: "p", ...row })) }) as never,
		onStatus: (event) => events.push(event),
		blocked: (agent) =>
			new Promise((resolve) => {
				release = () => resolve({ state: "blocked", kind: "auth", msg: `${agent.pane_id} wants a key` });
			}),
		setIntervalFn: () => 1,
		clearIntervalFn: () => {},
	});
	await watch.start();
	resync?.({ agents: rows.map((row) => ({ pane_id: "p", ...row })) } as never);
	rows = [{ name: "a", agent_status: "idle", state_change_seq: 2 }];
	resync?.({ agents: rows.map((row) => ({ pane_id: "p", ...row })) } as never);
	await new Promise((resolve) => setImmediate(resolve));
	expect(events).toEqual([]);

	release();
	await new Promise((resolve) => setImmediate(resolve));
	expect(events).toEqual([
		{ agent: "a", status: { state: "blocked", kind: "auth", msg: "p wants a key" }, seq: 1 },
		{ agent: "a", status: { state: "idle" }, seq: 2 },
	]);
});
