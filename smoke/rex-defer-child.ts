// The core as the rex defer smoke runs it: main.ts's startup with the rex adapter, the defer extension and its socket,
// and the faux model standing in for one that calls `dispatch`. Dispatches into the rex session $SOMA_REX_SESSION_ID
// on the server at $SOMA_REX_SOCKET, and serves `soma defer` on <db>.defer.sock.
//   dispatch <db> <card> <repo>   start up, submit 「派 <card> <repo>」, then serve until killed
//   reopen <db>                   start up and serve; on SIGTERM print what the root conversation and the dispatch list
//                                 hold and exit
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { TaskId } from "@earendil-works/pi-durable";
import { serveDefer } from "../src/adapters/defer-socket/index.ts";
import { createRexAgentPort } from "../src/adapters/rex/agent-port.ts";
import { createRexClient, defaultRexSocket } from "../src/adapters/rex/client.ts";
import { Deferrals, deferExtension } from "../src/core/extensions/defer/index.ts";
import { eventBridge, reconcileDispatches } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { NOTICE } from "../src/core/notice.ts";

const context = BACKGROUND_CONTEXT;
const [mode, db, card, repo] = process.argv.slice(2);
if (db === undefined) throw new Error("usage: rex-defer-child.ts dispatch <db> <card> <repo> | reopen <db>");
const hangar = process.env.SOMA_REX_SESSION_ID;
if (hangar === undefined) throw new Error("SOMA_REX_SESSION_ID names the smoke's rex session");
const label = process.env.SOMA_REX_LABEL;
// Unset, a hangar the port makes in place of the smoke's, once the smoke destroys it, would take prod's label.
if (label === undefined) throw new Error("SOMA_REX_LABEL labels a hangar made in place of the smoke's rex session");
const emit = (record: object) => console.log(JSON.stringify(record));
const socket = `${db}.defer.sock`;

const client = createRexClient({ socketPath: process.env.SOMA_REX_SOCKET ?? defaultRexSocket(homedir()) });
// As main.ts starts agents: soma's bin first on PATH, the socket, and the node this core runs on.
const agents = createRexAgentPort({
	client,
	sessionId: hangar,
	label,
	env: { SOMA_SOCKET: socket, SOMA_NODE: process.execPath },
	path: join(dirname(dirname(fileURLToPath(import.meta.url))), "bin"),
});

// Calls dispatch once per user input, and answers in text once the tool result is in.
const faux = fauxProvider();
faux.setResponses(
	Array.from({ length: 8 }, () => (transcript: { messages: { role: string; content: unknown }[] }) => {
		const last = transcript.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage("已派工。");
		const text = JSON.stringify(last?.content ?? "");
		const [, card, repo] = /派 ([a-z0-9-]+) (\S+?)"/.exec(text) ?? [];
		if (card === undefined || repo === undefined) return fauxAssistantMessage("沒有要派的卡。");
		return fauxAssistantMessage([fauxToolCall("dispatch", { card, repo })], {
			stopReason: "toolUse",
		}) as AssistantMessage;
	}),
);
const models = createModels();
models.setProvider(faux.provider);

const defers = deferExtension(agents);
const harness = await openHarness(
	db,
	[
		dispatchExtension(agents, async (_repo, card) => `# ${card}\n\n只回覆 ok 兩個字，不要使用任何工具。`),
		defers.extension,
	],
	context,
	{ models },
);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
harness.resume();
await reconcileDispatches(root, agents, context);
const unlisten = eventBridge(root, agents, context).listen((error) => console.error("[smoke] event bridge:", error));
const server = await serveDefer({ path: socket, defer: (request) => defers.defer(root, request, context) });
const pending = Object.keys((await harness.snapshot(Deferrals, root.id, context))?.items ?? {});
emit({
	event: "started",
	pid: process.pid,
	socket,
	pending,
	jobs: (await harness.snapshot(Dispatches, root.id, context))?.jobs ?? [],
});

if (mode === "dispatch") {
	if (card === undefined || repo === undefined) throw new Error("dispatch needs <card> <repo>");
	const submission = await root.submit(
		{ type: "input", content: `派 ${card} ${repo}`, requestId: `terminal:${card}` },
		context,
	);
	await submission.wait(context);
	emit({ event: "dispatched", jobs: (await harness.snapshot(Dispatches, root.id, context))?.jobs ?? [] });
	// Serves until the driver kills it; a pending promise alone lets node exit.
	setInterval(() => {}, 60_000);
} else if (mode === "reopen") {
	for (const id of pending) {
		void harness.waitForTask(Number(id) as TaskId, context).then((settled) => {
			emit({ event: "settled", id, outcome: settled.state.outcome, at: Date.now() });
		});
	}
	process.once("SIGTERM", async () => {
		const entries = (await root.entries({ order: "ascending" }, 1000, undefined, context)).items;
		emit({
			event: "report",
			modelCalls: faux.state.callCount,
			entries: entries.map((entry) => ({
				id: entry.id,
				kind: entry.kind,
				roles: (entry.model ?? []).map((message) => message.role),
			})),
			notices: entries
				.filter((entry) => entry.kind === NOTICE)
				.map((entry) => (entry.data as { content: string }).content),
			jobs: (await harness.snapshot(Dispatches, root.id, context))?.jobs ?? [],
		});
		unlisten();
		await server.close();
		await harness.close(context);
		client.close();
		process.exit(0);
	});
	setInterval(() => {}, 60_000);
} else {
	throw new Error(`unknown mode: ${mode}`);
}
