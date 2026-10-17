// One side of the digest smoke test; smoke/digest.ts runs it three times over one SQLite file.
//   start <db> <periodMs>   start the digest, finish jobs a and b through the event bridge, report, stay alive
//   resume <db>             reopen and resume; with SOMA_SMOKE_KILL_IN_DIGEST=1 the model kills the process
//   finish <db> <periodMs>  finish job c before resuming, then report once the reports and a quiet period are in
// The jobs' agents are FakeAgentPort's: the herdr side of a finished turn is covered by smoke/bridge.ts.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { DIGEST, Digests, digest, NOTICE } from "../src/core/extensions/digest/index.ts";
import { eventBridge } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { digestModels } from "./digest-faux.ts";

const context = BACKGROUND_CONTEXT;
const [mode, db, period] = process.argv.slice(2);
if (db === undefined) throw new Error("usage: digest-child.ts start|resume|finish <db> [periodMs]");
const emit = (record: object) => console.log(JSON.stringify(record));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const agents = new FakeAgentPort();
const { models, model, calls } = digestModels();
const { extension, startDigest } = digest(agents);
const harness: Harness = await openHarness(db, [dispatchExtension(agents, async () => ""), extension], context, {
	models,
});
const root = await harness.root(context, { agent: { model } });
const bridge = eventBridge(root, agents, context);
bridge.listen((error) => emit({ event: "bridge_error", error: String(error) }));
const task = async () => {
	const taskId = (await harness.snapshot(Digests, root.id, context))?.taskId as TaskId;
	return (await harness.getTask(taskId, context))?.state as { checkpoint?: { next: number; upto?: number } };
};

if (mode === "start") {
	await root.commit(async (tx) => {
		(await tx.doc(Dispatches, root.id)).jobs = ["a", "b", "c"].map((card) => ({
			card,
			agent: card,
			sessionId: card,
			status: { state: "working" },
			decisions: [],
		}));
	}, context);
	await startDigest(root, Number(period), context);
	harness.resume();
	agents.finish("a", "結果：完成\n三項都過。");
	agents.finish("b", "做完了，但沒寫結果行。");
	await delay(200);
	emit({ event: "armed", next: (await task()).checkpoint?.next, calls: calls(), pid: process.pid });
} else if (mode === "resume") {
	emit({ event: "reopened", at: Date.now() });
	harness.resume();
} else if (mode === "finish") {
	agents.finish("c", "結果：完成");
	await delay(200);
	emit({ event: "reopened", at: Date.now(), checkpoint: (await task()).checkpoint });
	harness.resume();
	const notices = async () =>
		(await root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter(
			(entry) => entry.kind === NOTICE,
		);
	while ((await notices()).length < 2) await delay(100);
	const reported = calls();
	await delay(2.5 * Number(period));
	const { items } = await root.entries({ order: "ascending" }, 1000, undefined, context);
	emit({
		event: "done",
		callsAtReports: reported,
		calls: calls(),
		notices: (await notices()).map((entry) => (entry.data as { content: string }).content),
		digests: items.filter((entry) => entry.kind === DIGEST).map((entry) => entry.data),
	});
	await harness.close(context);
} else {
	throw new Error(`unknown mode: ${mode}`);
}
