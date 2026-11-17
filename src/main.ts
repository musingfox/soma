import { homedir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { Harness } from "@earendil-works/pi-durable";
import { serveDefer } from "./adapters/defer-socket/index.ts";
import { createCard, readCard } from "./adapters/obsidian/card.ts";
import {
	runTelegram,
	ABILITIES as TELEGRAM_ABILITIES,
	ENTRY_KIND as TELEGRAM_KIND,
} from "./adapters/telegram/index.ts";
import {
	runTerminal,
	ABILITIES as TERMINAL_ABILITIES,
	ENTRY_KIND as TERMINAL_KIND,
} from "./adapters/terminal/index.ts";
import { SERVE_HOST, startWeb, ABILITIES as WEB_ABILITIES, ENTRY_KIND as WEB_KIND } from "./adapters/web/index.ts";
import { dispatchOver, openAgentPort } from "./agent-side.ts";
import { anthropicAuthContext, type Config, ConfigError, configPath, loadConfig } from "./config.ts";
import { clock } from "./core/extensions/clock/index.ts";
import { deferExtension } from "./core/extensions/defer/index.ts";
import { DIGEST_PERIOD_MS, digest } from "./core/extensions/digest/index.ts";
import { eventBridge, handoverBridge, reconcileDispatches } from "./core/extensions/dispatch/bridge.ts";
import { foreignBridge } from "./core/extensions/dispatch/foreign.ts";
import { reclaimer } from "./core/extensions/dispatch/reclaim.ts";
import { inspectExtension } from "./core/extensions/inspect/index.ts";
import { interfaces } from "./core/extensions/interfaces/index.ts";
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
import { skillsExtensions } from "./skills.ts";
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
const side = openAgentPort(config);
const { agents, dormant } = side;
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
// The entry kinds of the interfaces serving the human now: a round no interface started is told what each can show.
// Telegram is on from the start when configured, so a round the resumed tasks or the reconcile start before it polls
// is told of it; the section never goes away, which would make the prompt planner re-add every section.
const on = new Set<string>(config.telegram ? [TELEGRAM_KIND] : []);
const extensions = [
	clock(),
	language(config.language),
	sleeper,
	memory,
	schedule((id, c) => harness.abortTask(id, c)),
	dispatchOver(side, readCard),
	digests.extension,
	defers.extension,
	...(config.reflection ? [reflections.extension] : []),
	inspectExtension(storage),
	web({ exaApiKey: config.exaApiKey }),
	...vaultExtensions(config.vault),
	...(await skillsExtensions(config.skillsDir)),
	...(await Promise.all(mcpClients.map(({ name, client }) => mcpExtension(name, client)))),
	// Last: a section new to the transcript costs one patch at the end, where in the middle the prompt planner would
	// remove and re-add every section shown before it, on the first request after the release that added it.
	interfaces(storage, {
		texts: { [TELEGRAM_KIND]: TELEGRAM_ABILITIES, [TERMINAL_KIND]: TERMINAL_ABILITIES, [WEB_KIND]: WEB_ABILITIES },
		on: () => on,
	}),
];
const harness: Harness = await openHarness(storage, extensions, context, { models });
const root = await harness.root(context, {
	agent: { model: { provider: "anthropic", modelId: config.model } },
});
// Opened before the tasks resume and before the reconcile, either of which may tell the human of an agent gone while
// soma was down: the HumanPort passes on only the notices appended after it began to watch. Telegram polls after the
// reconcile, so no message queued while soma was down dispatches a job the reconcile's listing has not seen.
// Telegram is the default channel a push goes to when the human typed nowhere lately; without it, there is no push
// target and each client follows its own policy. The policies are by the entry kind each client tags its inputs with.
const policies = {
	[TELEGRAM_KIND]: config.push.telegram,
	[TERMINAL_KIND]: config.push.terminal,
	[WEB_KIND]: config.push.web,
};
const human = await startCore(
	harness,
	() =>
		openHumanPort(harness, root, agents, context, {
			policies,
			...(config.telegram && { defaultTarget: TELEGRAM_KIND }),
			summaryIdleMs: config.summaryIdleMs,
			storage,
		}),
	[
		() => digests.startDigest(root, DIGEST_PERIOD_MS, context),
		...(config.reflection ? [() => reflections.startReflection(root, REFLECTION_PERIOD_MS, context)] : []),
	],
);
// Before the reconcile, so that it finds a move a crash left unrecorded recorded, and tells what it tells of the rest.
const unlistenSettled =
	side.settling &&
	handoverBridge(root, side.settling, context).listen((error) => console.error("[soma] handover bridge:", error));
await side.settling?.heard();
await reconcileDispatches(root, agents, context, await dormant());
reconciled();
const unlisten = eventBridge(root, agents, context).listen((error) => console.error("[soma] event bridge:", error));
// Its first look at the foreign agents is at once, so a prompt that appeared while soma was down is pushed now.
const unlistenForeign = foreignBridge(root, agents, context).listen((error) =>
	console.error("[soma] foreign bridge:", error),
);
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
			on.add(WEB_KIND);
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
	unlistenSettled?.();
	unlistenForeign();
	stopTelegram.abort();
	void Promise.all([telegramDone, webPage?.close(), deferServer?.close()])
		.then(() => human.close())
		.then(() => harness.close(context))
		.then(() => Promise.all(mcpClients.map(({ client }) => client.close())))
		.then(releaseDbLock)
		.then(() => process.exit(0));
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, shutdown);
// Under launchd stdin is at EOF, so the terminal is on only while it reads.
on.add(TERMINAL_KIND);
await runTerminal({ human, input: process.stdin, output: process.stdout, programStatus: config.programStatus });
on.delete(TERMINAL_KIND);
// With Telegram or the web on, soma also runs without a terminal (stdin at EOF under launchd) until a signal stops it.
if (telegram === undefined && webPage === undefined) shutdown();
