// The core as the signals smoke runs it: the memory and dispatch extensions, the dispatch reconcile, the human port
// and a faux model (no API key on this machine). The agent side is a stub whose listing always reports card-x
// finished at seq 5 with 「結果：失敗」, the way herdr keeps listing a finished agent across a core restart.
//   run <db> [first]   start up; with `first`, submit a round that fails, an answer and its denial; report each second
// Each report line carries the outcome signals in the fact layer. SOMA_SMOKE_HANG_AFTER_DENIED=1 freezes the process
// once mark_denied's commit has landed, before its result is committed, so the driver can kill -9 it in that window.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension } from "@earendil-works/pi-durable";
import { reconcileDispatches } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { Facts, memory } from "../src/core/extensions/memory/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";
import type { AgentPort } from "../src/ports/agent.ts";

const context = BACKGROUND_CONTEXT;
const [mode, db, first] = process.argv.slice(2);
if (mode !== "run" || db === undefined) throw new Error("usage: signals-child.ts run <db> [first]");
const emit = (record: object) => console.log(JSON.stringify(record));

const agents: AgentPort = {
	start: async () => {},
	list: async () => [{ name: "card-x", status: { state: "done" }, seq: 5 }],
	prompt: async () => {},
	onStatus: () => () => {},
	readResult: async () => "結果：失敗\n測試沒過。",
	respond: async () => ({ sent: false, refusal: "not_blocked" }),
	stop: async () => {},
};

const faux = fauxProvider();
faux.setResponses(
	Array.from({ length: 20 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
		const last = request.messages.at(-1);
		const said = JSON.stringify(last?.content ?? "");
		if (last?.role === "toolResult") return fauxAssistantMessage("抱歉，我記下了。");
		if (said.includes("壞掉")) throw new Error("401 invalid x-api-key");
		if (said.includes("不對"))
			return fauxAssistantMessage([fauxToolCall("mark_denied", {})], { stopReason: "toolUse" });
		return fauxAssistantMessage("台北今天晴天。");
	}),
);
const models = createModels();
models.setProvider(faux.provider);

const hang = process.env.SOMA_SMOKE_HANG_AFTER_DENIED === "1";
const watched = defineExtension({
	...memory,
	tools: memory.tools?.map((tool) =>
		tool.name !== "mark_denied"
			? tool
			: {
					...tool,
					execute: async (...args: Parameters<typeof tool.execute>) => {
						const result = await tool.execute(...args);
						emit({ event: "denied_exec", pid: process.pid });
						if (!hang) return result;
						emit({ event: "hung" });
						// A pending promise alone lets node exit; the timer keeps it alive until the kill.
						return new Promise<never>(() => setInterval(() => {}, 60_000));
					},
				},
	),
});

const harness = await openHarness(db, [watched, dispatchExtension(agents, async () => "# card-x")], context, {
	models,
});
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
harness.resume();
await root.commit(async (tx) => {
	const doc = await tx.doc(Dispatches, root.id);
	if (doc.jobs.length > 0) return;
	doc.jobs.push({
		card: "card-x",
		agent: "card-x",
		sessionId: "s",
		status: { state: "working" },
		seq: 4,
		decisions: [],
	});
}, context);
await reconcileDispatches(root, agents, context);
const human = await openHumanPort(harness, root, agents, context);
emit({ event: "started", pid: process.pid });

const report = async () =>
	emit({
		event: "report",
		calls: faux.state.callCount,
		signals: ((await harness.snapshot(Facts, context))?.rows ?? []).map(({ kind, key, refs }) => ({ kind, key, refs })),
	});
const reporting = setInterval(() => void report(), 1_000);
reporting.unref();

if (first === "first") {
	for (const [content, requestId] of [
		["壞掉", "terminal:1"],
		["台北天氣如何", "terminal:2"],
		["不對，外面在下雨", "terminal:3"],
	] as const) {
		await human.submit({ content, entry: { kind: "chat.terminal" }, requestId });
		await root.waitForIdle(context);
		await report();
	}
}
setInterval(() => {}, 60_000);
