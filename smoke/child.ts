// One side of the durable smoke test; smoke/driver.ts runs it twice and kills the first.
//   start <db> <untilMs>   create a background sleeper, resume, and stay alive
//   resume <db> <taskId>   reopen, resume, wait for the sleeper, print what it recorded
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import { Sleeper, sleeper, Wakeups } from "../src/core/extensions/sleeper/index.ts";
import { openHarness } from "../src/core/harness.ts";

const context = BACKGROUND_CONTEXT;
const [mode, db, arg] = process.argv.slice(2);
if (db === undefined || arg === undefined) throw new Error("usage: child.ts start|resume <db> <untilMs|taskId>");
const emit = (record: object) => console.log(JSON.stringify(record));
const harness = await openHarness(db, [sleeper], context);
const root = await harness.root(context);

if (mode === "start") {
	const until = Number(arg);
	const taskId = await root.commit(
		(tx) => tx.createTask(Sleeper, { until }, { ownership: { kind: "conversation" }, background: true }),
		context,
	);
	emit({ event: "armed", taskId, until, pid: process.pid });
	harness.resume();
} else if (mode === "resume") {
	emit({ event: "reopened", at: Date.now() });
	harness.resume();
	const settled = await harness.waitForTask(Number(arg) as TaskId<{ firedAt: number }>, context);
	const wakeups = (await harness.snapshot(Wakeups, root.id, context))?.log ?? [];
	emit({ event: "done", outcome: settled.state.outcome, wakeups });
	await harness.close(context);
} else {
	throw new Error(`unknown mode: ${mode}`);
}
