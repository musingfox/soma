// Live check of the herdr adapter against the daemon at $HERDR_SOCKET_PATH: protocol handshake,
// agent.list, session.snapshot, and one pane.updated off events.subscribe.
import { createHerdrClient } from "../src/adapters/herdr/client.ts";
import type { EventEnvelope } from "../src/adapters/herdr/schema.ts";

const client = createHerdrClient({ socketPath: process.env.HERDR_SOCKET_PATH });

const pong = await client.assertCompatible();
console.log(`ping: herdr ${pong.version}, protocol ${pong.protocol}`);

const agents = await client.agentList();
console.log(`agent.list: ${agents.length} agents`);
for (const agent of agents) console.log(`  ${agent.pane_id} ${agent.agent ?? "?"} ${agent.agent_status}`);

const snapshot = await client.sessionSnapshot();
console.log(`session.snapshot: ${snapshot.panes.length} panes, ${snapshot.agents.length} agents`);
for (const agent of snapshot.agents) console.log(`  ${agent.pane_id} state_change_seq=${agent.state_change_seq}`);

const pane = snapshot.panes[0];
if (!pane) throw new Error("session.snapshot has no pane to update");

let resolve: (event: EventEnvelope) => void = () => {};
const updated = new Promise<EventEnvelope>((settle) => {
	resolve = settle;
});
const subscription = await client.subscribeEvents({
	subscriptions: [{ type: "pane.updated" }],
	onEvent: resolve,
});
// Display-only metadata with a short ttl: the least intrusive write that makes herdr emit pane.updated.
await client.call("pane.report_metadata", {
	pane_id: pane.pane_id,
	source: "soma-smoke",
	tokens: { soma_smoke: String(Date.now()) },
	ttl_ms: 2_000,
});
const timeout = setTimeout(() => {
	throw new Error("no pane.updated within 5s");
}, 5_000);
const event = await updated;
clearTimeout(timeout);
subscription.stop();
console.log(`events.subscribe: ${event.event} for ${(event.data as { pane?: { pane_id?: string } }).pane?.pane_id}`);
