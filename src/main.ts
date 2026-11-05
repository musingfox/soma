import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { Harness } from "@earendil-works/pi-durable";
import { serveDefer } from "./adapters/defer-socket/index.ts";
import { createHerdrAgentPort } from "./adapters/herdr/agent-port.ts";
import { createHerdrClient } from "./adapters/herdr/client.ts";
import { createCard, readCard } from "./adapters/obsidian/card.ts";
import { createRexAgentPort } from "./adapters/rex/agent-port.ts";
import { createRexClient } from "./adapters/rex/client.ts";
import { runTelegram } from "./adapters/telegram/index.ts";
import { runTerminal } from "./adapters/terminal/index.ts";
import { createTtyAgentPort } from "./adapters/tty/agent-port.ts";
import { spawnPty } from "./adapters/tty/pty.ts";
import { SERVE_HOST, startWeb } from "./adapters/web/index.ts";
import { anthropicAuthContext, type Config, ConfigError, configPath, loadConfig } from "./config.ts";
import { clock } from "./core/extensions/clock/index.ts";
import { deferExtension } from "./core/extensions/defer/index.ts";
import { DIGEST_PERIOD_MS, digest } from "./core/extensions/digest/index.ts";
import { eventBridge, reconcileDispatches } from "./core/extensions/dispatch/bridge.ts";
import { dispatchExtension } from "./core/extensions/dispatch/index.ts";
import { reclaimer } from "./core/extensions/dispatch/reclaim.ts";
import { inspectExtension } from "./core/extensions/inspect/index.ts";
import { language } from "./core/extensions/language/index.ts";
import { connectStdio, loadMcpConfig, mcpExtension } from "./core/extensions/mcp/index.ts";
import { memory } from "./core/extensions/memory/index.ts";
import { REFLECTION_PERIOD_MS, reflection } from "./core/extensions/reflection/index.ts";
import { schedule } from "./core/extensions/schedule/index.ts";
import { sleeper } from "./core/extensions/sleeper/index.ts";
import { web } from "./core/extensions/web/index.ts";
import { acquireDbLock, DbLockedError, openHarness, openStorage } from "./core/harness.ts";
import { openHumanPort } from "./core/human-port.ts";
import { startCore } from "./core/startup.ts";
import type { AgentPort } from "./ports/agent.ts";
import { vaultExtensions } from "./vault.ts";

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
/** The one place the agent-side adapter is chosen, by the config's `agentAdapter`. */
function openAgentPort({ agentAdapter, herdrSocket, rex, hangarCap, deferSocket }: Config): AgentPort {
	const cap = hangarCap === undefined ? {} : { cap: hangarCap };
	if (agentAdapter === "rex") {
		// resolveConfig sets rex exactly when it is selected.
		if (rex === undefined) throw new Error("agentAdapter is rex but the config holds no rex settings");
		const onError = (error: Error) => console.error("[soma] rex:", error.message);
		const client = createRexClient({ socketPath: rex.socket, onError });
		// What `soma defer` needs in an agent's shell: this release's bin/soma on PATH, the socket, and the node soma
		// runs on, since the agent's own may be one its project pins.
		const env = { SOMA_SOCKET: deferSocket, SOMA_NODE: process.execPath };
		const path = join(dirname(dirname(fileURLToPath(import.meta.url))), "bin");
		return createRexAgentPort({ client, sessionId: rex.sessionId, onError, env, path, ...cap });
	}
	if (agentAdapter === "tty") {
		const onError = (error: Error) => console.error("[soma] tty:", error.message);
		return createTtyAgentPort({ spawn: spawnPty, env: process.env, onError, ...cap });
	}
	return createHerdrAgentPort({ client: createHerdrClient({ socketPath: herdrSocket }), ...cap });
}
const agents = openAgentPort(config);
const digests = digest(agents);
// A job a deferral's rerun makes due again is reclaimed after the reconcile, which may otherwise skip it while the
// rerun still has it `sending`, or take that reclaim's `stopping` for one a crash cut short and stop the agent twice.
let reconciled: () => void = () => {};
const ready = new Promise<void>((resolve) => {
	reconciled = resolve;
});
const defers = deferExtension(agents, {
	reclaim: (agent) => ready.then(() => reclaimer(root, agents, context)(agent)),
});
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
	defers.extension,
	...(config.reflection ? [reflections.extension] : []),
	inspectExtension(storage),
	web({ exaApiKey: config.exaApiKey }),
	...vaultExtensions(config.vault),
	...(await Promise.all(mcpClients.map(({ name, client }) => mcpExtension(name, client)))),
];
const harness: Harness = await openHarness(storage, extensions, context, { models });
const root = await harness.root(context, {
	agent: { model: { provider: "anthropic", modelId: config.model } },
});
// Opened before the tasks resume and before the reconcile, either of which may tell the human of an agent gone while
// soma was down: the HumanPort passes on only the notices appended after it began to watch. Telegram polls after the
// reconcile, so no message queued while soma was down dispatches a job the reconcile's listing has not seen.
// Telegram is the default channel a push goes to when the human typed nowhere lately; without it, every client rings.
const human = await startCore(
	harness,
	() => openHumanPort(harness, root, agents, context, config.telegram && { defaultTarget: "chat.telegram" }),
	[
		() => digests.startDigest(root, DIGEST_PERIOD_MS, context),
		...(config.reflection ? [() => reflections.startReflection(root, REFLECTION_PERIOD_MS, context)] : []),
	],
);
await reconcileDispatches(root, agents, context);
reconciled();
const unlisten = eventBridge(root, agents, context).listen((error) => console.error("[soma] event bridge:", error));
// Served after the reconcile, so a defer is checked against a dispatch list caught up with the hangar. A socket that
// cannot be served leaves soma running without `soma defer`, as the web page does.
const deferServer = await serveDefer({
	path: config.deferSocket,
	defer: (request) => defers.defer(root, request, context),
}).catch((error: unknown) => {
	console.error("[soma] soma defer not served:", error);
	return undefined;
});

const { telegram } = config;
const stopTelegram = new AbortController();
const telegramDone = telegram && runTelegram({ ...telegram, human, signal: stopTelegram.signal });
// Each open page subscribes on its own, so the web takes none of the notices held for the first subscriber. A page
// that cannot listen (the tailnet address is down, the port taken) leaves soma running without it, as Telegram stays.
const webPage =
	config.web &&
	(await startWeb({ ...config.web, human }).then(
		(server) => {
			const { serve, host } = config.web ?? {};
			console.error(
				serve
					? `[soma] web page on ${SERVE_HOST}:${server.port}, for ${serve.origin} (tailscale serve is not managed by soma)`
					: `[soma] web page on http://${host}:${server.port}/`,
			);
			return server;
		},
		(error: unknown) => {
			console.error("[soma] web page not served:", error);
			return undefined;
		},
	));
const shutdown = () => {
	unlisten();
	stopTelegram.abort();
	void Promise.all([telegramDone, webPage?.close(), deferServer?.close()])
		.then(() => human.close())
		.then(() => harness.close(context))
		.then(() => Promise.all(mcpClients.map(({ client }) => client.close())))
		.then(releaseDbLock)
		.then(() => process.exit(0));
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, shutdown);
await runTerminal({ human, input: process.stdin, output: process.stdout, programStatus: config.programStatus });
// With Telegram or the web on, soma also runs without a terminal (stdin at EOF under launchd) until a signal stops it.
if (telegram === undefined && webPage === undefined) shutdown();
