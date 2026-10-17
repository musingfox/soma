import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { Harness } from "@earendil-works/pi-durable";
import { createHerdrAgentPort } from "./adapters/herdr/agent-port.ts";
import { createHerdrClient } from "./adapters/herdr/client.ts";
import { dispatchExtension, reconcileDispatches } from "./core/extensions/dispatch/index.ts";
import { memory } from "./core/extensions/memory/index.ts";
import { schedule } from "./core/extensions/schedule/index.ts";
import { sleeper } from "./core/extensions/sleeper/index.ts";
import { openHarness } from "./core/harness.ts";

const context = BACKGROUND_CONTEXT;
const models = createModels();
models.setProvider(anthropicProvider());
// The hangar session, never $HERDR_SOCKET_PATH: that names whichever session soma itself runs in.
const socketPath = process.env.SOMA_HERDR_SOCKET ?? join(homedir(), ".config/herdr/sessions/fleet/herdr.sock");
const agents = createHerdrAgentPort({ client: createHerdrClient({ socketPath }) });
const extensions = [sleeper, memory, schedule((id, c) => harness.abortTask(id, c)), dispatchExtension(agents)];
const harness: Harness = await openHarness(process.env.SOMA_DB ?? "soma.sqlite", extensions, context, { models });
const root = await harness.root(context, {
	agent: { model: { provider: "anthropic", modelId: process.env.SOMA_MODEL ?? "claude-opus-5-5" } },
});
harness.resume();
await reconcileDispatches(root, agents, context);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => void harness.close(context).then(() => process.exit(0)));
}
