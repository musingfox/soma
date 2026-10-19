// One side of the reflection smoke test; smoke/reflection.ts runs it three times over one SQLite file.
//   start <db> <periodMs>   record one signal, start the reflection, stay alive
//   resume <db>             reopen and resume; with SOMA_SMOKE_KILL_IN_REFLECTION=1 the model kills the process
//   finish <db> <periodMs>  reopen and resume, then report once the reflection's notice and a quiet period are in
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { SIGNAL } from "../src/core/domain/signal.ts";
import { memory, recordFact } from "../src/core/extensions/memory/index.ts";
import { REFLECTION, Reflections, reflection } from "../src/core/extensions/reflection/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { NOTICE } from "../src/core/notice.ts";

const context = BACKGROUND_CONTEXT;
const [mode, db, period] = process.argv.slice(2);
if (db === undefined) throw new Error("usage: reflection-child.ts start|resume|finish <db> [periodMs]");
const emit = (record: object) => console.log(JSON.stringify(record));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const faux = fauxProvider();
faux.setResponses(
	Array.from({ length: 20 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
		const input = JSON.stringify(request.messages.findLast((message) => message.role === "user")?.content ?? "");
		if (!input.includes("[reflection ")) return fauxAssistantMessage("?");
		emit({ event: "reflecting", at: Date.now() });
		if (process.env.SOMA_SMOKE_KILL_IN_REFLECTION === "1") process.kill(process.pid, "SIGKILL");
		return fauxAssistantMessage("觀察：card-x 失敗。\n證據 id：entry:1\n改動：不改");
	}),
);
const models = createModels();
models.setProvider(faux.provider);
const reflections = reflection({
	repo: "/soma",
	createCard: async () => {
		throw new Error("no card in this smoke");
	},
	readCard: async () => "",
});
const harness: Harness = await openHarness(db, [memory, reflections.extension], context, { models });
const root = await harness.root(context, { agent: { model: { provider: faux.provider.id, modelId: "faux-1" } } });
const task = async () => {
	const taskId = (await harness.snapshot(Reflections, root.id, context))?.taskId as TaskId;
	return (await harness.getTask(taskId, context))?.state as unknown as { checkpoint: { next: number; upto?: number } };
};

if (mode === "start") {
	await root.commit(async (tx) => {
		await recordFact(tx, {
			at: Date.now(),
			kind: SIGNAL.dispatchFailed,
			text: "agent card-x（卡片 card-x）結束時回報「結果：失敗」。",
			key: "dispatch:card-x:1",
			refs: { entry: 1, card: "card-x", agent: "card-x", seq: 1 },
		});
	}, context);
	await reflections.startReflection(root, Number(period), context);
	harness.resume();
	emit({ event: "armed", next: (await task()).checkpoint.next, calls: faux.state.callCount });
} else if (mode === "resume") {
	emit({ event: "reopened", at: Date.now() });
	harness.resume();
} else if (mode === "finish") {
	emit({ event: "reopened", at: Date.now(), checkpoint: (await task()).checkpoint });
	harness.resume();
	const entries = async () => (await root.entries({ order: "ascending" }, 1000, undefined, context)).items;
	while (!(await entries()).some((entry) => entry.kind === NOTICE)) await delay(100);
	const reflected = faux.state.callCount;
	await delay(2.5 * Number(period));
	const items = await entries();
	emit({
		event: "done",
		callsAtNotice: reflected,
		calls: faux.state.callCount,
		notices: items.flatMap((entry) => (entry.kind === NOTICE ? [(entry.data as { content: string }).content] : [])),
		reflections: items.filter((entry) => entry.kind === REFLECTION).map((entry) => entry.data),
	});
	await harness.close(context);
} else {
	throw new Error(`unknown mode: ${mode}`);
}
