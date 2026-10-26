import { homedir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { Harness } from "@earendil-works/pi-durable";
import { createHerdrAgentPort } from "./adapters/herdr/agent-port.ts";
import { createHerdrClient } from "./adapters/herdr/client.ts";
import { createCard, readCard } from "./adapters/obsidian/card.ts";
import { runTelegram } from "./adapters/telegram/index.ts";
import { runTerminal } from "./adapters/terminal/index.ts";
import { anthropicAuthContext, type Config, ConfigError, configPath, loadConfig } from "./config.ts";
import { clock } from "./core/extensions/clock/index.ts";
import { DIGEST_PERIOD_MS, digest } from "./core/extensions/digest/index.ts";
import { eventBridge, reconcileDispatches } from "./core/extensions/dispatch/bridge.ts";
import { dispatchExtension } from "./core/extensions/dispatch/index.ts";
import { inspectExtension } from "./core/extensions/inspect/index.ts";
import { language } from "./core/extensions/language/index.ts";
import { connectStdio, loadMcpConfig, mcpExtension } from "./core/extensions/mcp/index.ts";
import { memory } from "./core/extensions/memory/index.ts";
import { REFLECTION_PERIOD_MS, reflection } from "./core/extensions/reflection/index.ts";
import { schedule } from "./core/extensions/schedule/index.ts";
import { sleeper } from "./core/extensions/sleeper/index.ts";
import { acquireDbLock, DbLockedError, openHarness, openStorage } from "./core/harness.ts";
import { openHumanPort } from "./core/human-port.ts";

let config: Config;
try {
	config = loadConfig(configPath(process.env, homedir()), process.env, homedir());
} catch (error) {
	if (!(error instanceof ConfigError)) throw error;
	console.error(`[soma] ${error.message}`);
	process.exit(1);
}
let releaseDbLock: () => Promise<void>;
try {
	releaseDbLock = await acquireDbLock(config.db);
} catch (error) {
	if (!(error instanceof DbLockedError)) throw error;
	console.error(`[soma] ${error.message}`);
	process.exit(1);
}
const context = BACKGROUND_CONTEXT;
const models = createModels({ authContext: anthropicAuthContext(config.anthropicApiKey) });
models.setProvider(anthropicProvider());
const agents = createHerdrAgentPort({
	client: createHerdrClient({ socketPath: config.herdrSocket }),
	...(config.hangarCap !== undefined && { cap: config.hangarCap }),
});
const digests = digest(agents);
const reflections = reflection({
	repo: config.repo,
	createCard,
	readCard,
	agents,
});
const mcpServers = loadMcpConfig(config.mcpConfig);
// One server that fails to start (say, an expired token) leaves soma running without its tools.
const mcpClients = (
	await Promise.all(
		Object.entries(mcpServers).map(([name, server]) =>
			connectStdio(server).then(
				(client) => [{ name, client }],
				(error: unknown) => {
					console.error(`[soma] MCP server ${name}:`, error);
					return [];
				},
			),
		),
	)
).flat();
const storage = await openStorage(config.db);
const extensions = [
	clock(),
	language(config.language),
	sleeper,
	memory,
	schedule((id, c) => harness.abortTask(id, c)),
	dispatchExtension(agents, readCard),
	digests.extension,
	...(config.reflection ? [reflections.extension] : []),
	inspectExtension(storage),
	...(await Promise.all(mcpClients.map(({ name, client }) => mcpExtension(name, client)))),
];
const harness: Harness = await openHarness(storage, extensions, context, { models });
const root = await harness.root(context, {
	agent: { model: { provider: "anthropic", modelId: config.model } },
});
harness.resume();
await digests.startDigest(root, DIGEST_PERIOD_MS, context);
if (config.reflection) await reflections.startReflection(root, REFLECTION_PERIOD_MS, context);
await reconcileDispatches(root, agents, context);
const unlisten = eventBridge(root, agents, context).listen((error) => console.error("[soma] event bridge:", error));

const human = await openHumanPort(harness, root, agents, context);
const { telegram } = config;
const stopTelegram = new AbortController();
const telegramDone = telegram && runTelegram({ ...telegram, human, signal: stopTelegram.signal });
const shutdown = () => {
	unlisten();
	stopTelegram.abort();
	void Promise.resolve(telegramDone)
		.then(() => human.close())
		.then(() => harness.close(context))
		.then(() => Promise.all(mcpClients.map(({ client }) => client.close())))
		.then(releaseDbLock)
		.then(() => process.exit(0));
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, shutdown);
await runTerminal({ human, input: process.stdin, output: process.stdout, programStatus: config.programStatus });
// With Telegram on, soma also runs without a terminal (stdin at EOF under launchd) until a signal stops it.
if (telegram === undefined) shutdown();
