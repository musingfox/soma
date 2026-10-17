// One side of the schedule smoke test; smoke/schedule.ts runs it twice and kills the first.
//   start <db> <at> <words>   say <words> to the root conversation, report the reminder, and stay alive
//   resume <db> <taskId>      reopen, resume, wait for the reminder and its reply, report the transcript
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { Schedules, schedule } from "../src/core/extensions/schedule/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { fauxModels } from "./faux.ts";

const context = BACKGROUND_CONTEXT;
const [mode, db, arg, words] = process.argv.slice(2);
if (db === undefined || arg === undefined) throw new Error("usage: schedule-child.ts start|resume <db> <at|taskId>");
const emit = (record: object) => console.log(JSON.stringify(record));
const { models, model } = fauxModels(mode === "start" ? arg : "PT0S");
const extensions = [schedule((id, c) => harness.abortTask(id, c))];
const harness: Harness = await openHarness(db, extensions, context, { models });
const root = await harness.root(context, { agent: { model } });
harness.resume();

if (mode === "start") {
	await (await root.submit({ type: "input", content: words ?? "", requestId: "terminal:1" }, context)).wait(context);
	const items = (await harness.snapshot(Schedules, root.id, context))?.items ?? {};
	const [taskId, item] = Object.entries(items)[0] ?? [];
	emit({ event: "armed", taskId, at: item?.at, pid: process.pid });
} else if (mode === "resume") {
	emit({ event: "reopened", at: Date.now() });
	const settled = await harness.waitForTask(Number(arg) as TaskId, context);
	await root.waitForIdle(context);
	const { items } = await root.entries({ order: "ascending" }, 1000, undefined, context);
	const textOf = (index: number) => {
		const content = items[index]?.model?.[0]?.content ?? "";
		if (typeof content === "string") return content;
		return content.map((part) => (part.type === "text" ? part.text : "")).join("");
	};
	const fires = items.flatMap((entry, index) => (entry.kind === "schedule" ? [index] : []));
	const firedAt = fires.map((index) => items[index]?.model?.[0]?.timestamp);
	const replies = fires.map((index) => textOf(items.findIndex((e, i) => i > index && e.kind === "pi.assistant")));
	emit({ event: "done", outcome: settled.state.outcome, fires: fires.map(textOf), firedAt, replies });
	await harness.close(context);
} else {
	throw new Error(`unknown mode: ${mode}`);
}
