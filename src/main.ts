import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { Harness } from "@earendil-works/pi-durable";
import { memory } from "./core/extensions/memory/index.ts";
import { schedule } from "./core/extensions/schedule/index.ts";
import { sleeper } from "./core/extensions/sleeper/index.ts";
import { openHarness } from "./core/harness.ts";

const context = BACKGROUND_CONTEXT;
const models = createModels();
models.setProvider(anthropicProvider());
const extensions = [sleeper, memory, schedule((id, c) => harness.abortTask(id, c))];
const harness: Harness = await openHarness(process.env.SOMA_DB ?? "soma.sqlite", extensions, context, { models });
await harness.root(context, {
	agent: { model: { provider: "anthropic", modelId: process.env.SOMA_MODEL ?? "claude-opus-5-5" } },
});
harness.resume();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => void harness.close(context).then(() => process.exit(0)));
}
