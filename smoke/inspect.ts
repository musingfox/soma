// Inspect smoke on a database a real soma wrote: run src/main.ts with no Anthropic key, type one line, wait for
// its 「[失敗]」 line and kill -9 it; then this script reopens the database with the faux model standing in for one
// that calls inspect, in a conversation of its own, and prints the tool's result.
//   SOMA_DB=/tmp/x/soma.sqlite SOMA_MCP_CONFIG=/tmp/x/none.json node src/main.ts
//   node smoke/inspect.ts /tmp/x/soma.sqlite '{"what":"failures"}'
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject } from "@earendil-works/pi-durable";
import { inspectExtension } from "../src/core/extensions/inspect/index.ts";
import { openHarness, openStorage } from "../src/core/harness.ts";

const [db, args = '{"what":"failures"}'] = process.argv.slice(2);
if (db === undefined) throw new Error("usage: inspect.ts <soma.sqlite> [inspect arguments as JSON]");
const context = BACKGROUND_CONTEXT;
const faux = fauxProvider();
let result: string | undefined;
faux.setResponses([
	() => fauxAssistantMessage([fauxToolCall("inspect", JSON.parse(args) as JsonObject)], { stopReason: "toolUse" }),
	(request) => {
		const last = request.messages.at(-1);
		if (last?.role === "toolResult")
			result = last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
		return fauxAssistantMessage("好。");
	},
]);
const models = createModels();
models.setProvider(faux.provider);
const storage = await openStorage(db);
const harness = await openHarness(storage, [inspectExtension(storage)], context, { models });
const probe = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
await probe.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
harness.resume();
const submission = await probe.submit({ type: "input", content: "自我檢視" }, context);
const settled = await submission.wait(context);
await harness.close(context);
if (settled.status !== "done" || result === undefined)
	throw new Error(`the probe round ended ${JSON.stringify(settled)}`);
console.log(JSON.stringify(JSON.parse(result), null, 2));
