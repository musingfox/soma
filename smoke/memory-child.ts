// One side of the memory smoke test; smoke/memory.ts runs it twice and kills the first.
//   start <db>    seed a line, have the model revise it, report once the revision is committed, then hang mid-turn
//   resume <db>   reopen, resume, finish the interrupted turn, ask once more, report the layer and the prompt
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { MODEL_LINE_PREFIX } from "../src/core/domain/memory.ts";
import { Curated, memory } from "../src/core/extensions/memory/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { NOTICE } from "../src/core/notice.ts";

const context = BACKGROUND_CONTEXT;
const [mode, db] = process.argv.slice(2);
if (db === undefined) throw new Error("usage: memory-child.ts start|resume <db>");
const emit = (record: object) => console.log(JSON.stringify(record));

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.provider.id, modelId: faux.getModel().id };
const harness: Harness = await openHarness(db, [memory], context, { models });
const root = await harness.root(context, { agent: { model } });
harness.resume();

async function layer() {
	const curated = await harness.snapshot(Curated, context);
	const { items } = await root.entries({ order: "ascending" }, 1000, undefined, context);
	return { lines: curated?.lines, history: curated?.history, notices: items.filter((e) => e.kind === NOTICE).length };
}

let prompt = "";
const route: FauxResponseStep = async (request: TranscriptContext) => {
	const last = request.messages.findLast((message) => message.role !== "system");
	for (const message of [...request.messages].reverse()) {
		if (message.role === "system" && message.sections?.memory !== undefined) {
			prompt = message.sections.memory ?? "";
			break;
		}
	}
	if (last?.role === "toolResult" && mode === "start") {
		emit({ event: "revised", pid: process.pid, ...(await layer()) });
		return new Promise(() => {});
	}
	if (last?.role === "user" && mode === "start") {
		return fauxAssistantMessage(
			[
				fauxToolCall("revise_memory", {
					line: 1,
					text: "使用者喜歡早上十點開會",
					reason: "使用者說改到十點了",
					evidence: ["submission:1"],
				}),
			],
			{ stopReason: "toolUse" },
		);
	}
	return fauxAssistantMessage([fauxText("好。")]);
};
faux.setResponses(Array.from({ length: 20 }, () => route));

if (mode === "start") {
	await root.commit(async (tx) => {
		const curated = await tx.doc(Curated);
		curated.lines = [
			{ id: 1, by: "model", text: `${MODEL_LINE_PREFIX}2026-10-17T00:00:00.000Z：使用者喜歡早上九點開會` },
		];
		curated.next = 2;
	}, context);
	await root.submit({ type: "input", content: "我現在都改十點開會了。", requestId: "terminal:1" }, context);
	// A timer keeps the process alive: the hung model call alone holds no handle, and Node would exit.
	setInterval(() => {}, 60_000);
} else if (mode === "resume") {
	emit({ event: "reopened", at: Date.now() });
	await root.waitForIdle(context);
	const settled = await (
		await root.submit({ type: "input", content: "我喜歡幾點開會？", requestId: "terminal:2" }, context)
	).wait(context);
	emit({ event: "done", status: settled.status, prompt, ...(await layer()) });
	await harness.close(context);
} else {
	throw new Error(`unknown mode: ${mode}`);
}
