import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { Harness } from "@earendil-works/pi-durable";
import { createHerdrAgentPort } from "./adapters/herdr/agent-port.ts";
import { createHerdrClient } from "./adapters/herdr/client.ts";
import { readCard } from "./adapters/obsidian/card.ts";
import { runTerminal } from "./adapters/terminal/index.ts";
import { DIGEST_PERIOD_MS, digest } from "./core/extensions/digest/index.ts";
import { eventBridge, reconcileDispatches } from "./core/extensions/dispatch/bridge.ts";
import { dispatchExtension } from "./core/extensions/dispatch/index.ts";
import { memory } from "./core/extensions/memory/index.ts";
import { schedule } from "./core/extensions/schedule/index.ts";
import { sleeper } from "./core/extensions/sleeper/index.ts";
import { openHarness } from "./core/harness.ts";
import { openHumanPort } from "./core/human-port.ts";

const context = BACKGROUND_CONTEXT;
const models = createModels();
models.setProvider(anthropicProvider());
// The hangar session, never $HERDR_SOCKET_PATH: that names whichever session soma itself runs in.
const socketPath = process.env.SOMA_HERDR_SOCKET ?? join(homedir(), ".config/herdr/sessions/fleet/herdr.sock");
const agents = createHerdrAgentPort({ client: createHerdrClient({ socketPath }) });
const digests = digest(agents);
const extensions = [
	sleeper,
	memory,
	schedule((id, c) => harness.abortTask(id, c)),
	dispatchExtension(agents, readCard),
	digests.extension,
];
const harness: Harness = await openHarness(process.env.SOMA_DB ?? "soma.sqlite", extensions, context, { models });
const root = await harness.root(context, {
	agent: { model: { provider: "anthropic", modelId: process.env.SOMA_MODEL ?? "claude-opus-5-5" } },
});
harness.resume();
await digests.startDigest(root, DIGEST_PERIOD_MS, context);
await reconcileDispatches(root, agents, context);
const unlisten = eventBridge(root, agents, context).listen((error) => console.error("[soma] event bridge:", error));

const human = await openHumanPort(harness, root, context);
const shutdown = () => {
	unlisten();
	void human.close().then(() => harness.close(context).then(() => process.exit(0)));
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, shutdown);
await runTerminal({ human, input: process.stdin, output: process.stdout, env: process.env });
shutdown();
