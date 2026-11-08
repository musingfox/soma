// One soma, as the ACP defer smoke runs it: main.ts's startup with the ACP adapter on <dir>/acp-sessions.json, the defer
// extension and its socket on <dir>/defer.sock, soma's bin first on the agent's PATH, the real core on <dir>/soma.sqlite,
// and a faux model standing in for soma's, which calls `dispatch` at 「派工」 and answers a permission request with
// option 1. Each step is printed as one JSON line.
//   dispatch <dir> <card> <repo> <word>  start up, dispatch the card, whose brief plants the word and has the agent run
//                                        `soma defer` in its Bash, print "deferred" once the deferral is pending and
//                                        "reclaimed" once the job is stopped, then serve until killed
//   reopen <dir> <card>                  start up, print "started", print "settled" when the deferral ends and "answered"
//                                        when its turn is recorded, and 5 s later "report", then stop the agent and exit
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { TaskId } from "@earendil-works/pi-durable";
import { createAcpAgentPort } from "../src/adapters/acp/agent-port.ts";
import { serveDefer } from "../src/adapters/defer-socket/index.ts";
import { Deferrals, deferExtension } from "../src/core/extensions/defer/index.ts";
import { eventBridge, JOB_DONE, reconcileDispatches } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { reclaimer } from "../src/core/extensions/dispatch/reclaim.ts";
import { openHarness } from "../src/core/harness.ts";
import { NOTICE } from "../src/core/notice.ts";
import { delay } from "./driver.ts";

const context = BACKGROUND_CONTEXT;
const [mode, dir, card, repo, word] = process.argv.slice(2);
if (dir === undefined || card === undefined) {
	throw new Error("usage: acp-defer-child.ts dispatch <dir> <card> <repo> <word> | reopen <dir> <card>");
}
const emit = (event: string, value: object = {}) => console.log(JSON.stringify({ event, ...value }));

// The word is in the brief alone: the instruction asks for it, so only the session's context can answer it.
const instruction =
	"What was the word I asked you to remember in my first message? Use no tool. " +
	"Reply with exactly two lines: 結果：完成, then that word alone.";
const brief =
	`Remember this word for later: ${word}. Then run exactly this one Bash command, once, and no other tool: ` +
	`soma defer --at PT2M "${instruction}"\n` +
	"Then end your turn with exactly two lines: 結果：完成, then the single word DEFERRED.";

const socket = join(dir, "defer.sock");
const agents = createAcpAgentPort({
	env: process.env,
	// ANTHROPIC_MODEL picks the session's model; the rest is what main.ts gives an agent for `soma defer`.
	vars: { ANTHROPIC_MODEL: "haiku", SOMA_SOCKET: socket, SOMA_NODE: process.execPath },
	path: join(dirname(dirname(fileURLToPath(import.meta.url))), "bin"),
	sessionsFile: join(dir, "acp-sessions.json"),
	onError: (error) => console.error(`[soma] acp: ${error.message}`),
});
agents.onStatus((event) => emit("status", { agent: event.agent, state: event.status.state, msg: event.status.msg }));

const faux = fauxProvider();
faux.setResponses(
	Array.from({ length: 12 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
		const last = request.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage("好。");
		const text = JSON.stringify(last?.content ?? "");
		const call = (name: string, args: Record<string, string>) =>
			fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
		const fingerprint = /fingerprint=([0-9a-f]{16})/.exec(text)?.[1];
		if (fingerprint !== undefined) {
			return call("respond", { card, option: "1", fingerprint, reason: "the smoke approves its own soma defer" });
		}
		if (text.includes("派工")) return call("dispatch", { card, repo: repo ?? "" });
		return fauxAssistantMessage("好。");
	}),
);
const models = createModels();
models.setProvider(faux.provider);
let reconciled: () => void = () => {};
const ready = new Promise<void>((resolve) => {
	reconciled = resolve;
});
const defers = deferExtension(agents, {
	reclaim: (agent) => ready.then(() => reclaimer(root, agents, context)(agent)),
});
const harness = await openHarness(
	join(dir, "soma.sqlite"),
	[dispatchExtension(agents, async () => `# ${card}\n\n${brief}`), defers.extension],
	context,
	{ models },
);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
harness.resume();
await reconcileDispatches(root, agents, context, await agents.dormant());
reconciled();
const off = eventBridge(root, agents, context).listen((error) => console.error("[soma] event bridge:", error));
const server = await serveDefer({ path: socket, defer: (request) => defers.defer(root, request, context) });

const job = async () => (await harness.snapshot(Dispatches, root.id, context))?.jobs.find((each) => each.card === card);
const items = async () => (await harness.snapshot(Deferrals, root.id, context))?.items ?? {};
const entries = async (kind: string) =>
	(await root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter((entry) => entry.kind === kind);
const held = async () => ({
	job: await job(),
	listed: await agents.list(),
	dormant: await agents.dormant(),
	done: (await entries(JOB_DONE)).map((entry) => entry.data),
	notices: (await entries(NOTICE)).map((entry) => (entry.data as { content: string }).content),
	modelCalls: faux.state.callCount,
});

if (mode === "dispatch") {
	const submission = await root.submit({ type: "input", content: "派工", requestId: `smoke:${card}` }, context);
	if ((await submission.wait(context)).status !== "done") throw new Error("the dispatch did not finish");
	emit("dispatched", { job: await job() });
	let deferred = false;
	for (;;) {
		const pending = await items();
		if (!deferred && Object.keys(pending).length > 0) {
			deferred = true;
			emit("deferred", { pending });
		}
		if ((await job())?.reclaim?.phase === "stopped") break;
		await delay(100);
	}
	await root.waitForIdle(context);
	emit("reclaimed", { ...(await held()), pending: await items() });
	// Serves until the smoke kills it; a pending promise alone lets node exit.
	setInterval(() => {}, 60_000);
} else if (mode === "reopen") {
	const pending = Object.keys(await items());
	const before = (await entries(JOB_DONE)).length;
	emit("started", { ...(await held()), pending, result: await agents.readResult(card) });
	for (const id of pending) {
		void harness.waitForTask(Number(id) as TaskId, context).then((settled) => {
			emit("settled", { id, outcome: settled.state.outcome, at: Date.now() });
		});
	}
	while ((await entries(JOB_DONE)).length <= before) await delay(250);
	await root.waitForIdle(context);
	emit("answered", { result: await agents.readResult(card) });
	// Long enough for a second prompt or notice, had one been written, to show up.
	await delay(5_000);
	emit("report", await held());
	await agents.stop(card);
	off();
	await server.close();
	await harness.close(context);
	process.exit(0);
} else {
	throw new Error(`unknown mode: ${mode}`);
}
