// One soma, as the ACP restart smoke runs it: main.ts's startup with the ACP adapter on <dir>/acp-sessions.json (the
// startup reconcile told which agents the port lists dormant, then the event bridge), the real core on <dir>/soma.sqlite, and
// a faux model standing in for soma's, which calls `dispatch` at 「派工」 and `reply` at 「回覆」. Each step is printed as
// one JSON line.
//   dispatch <dir> <card> <repo> <word>  start up, dispatch the card, whose brief plants the word, print "recorded" once
//                                        the turn is recorded, then serve until SIGTERM, which ends it as main.ts's
//                                        shutdown does: the bridge stops, the db closes, process.exit, and nothing
//                                        stops the agent
//   reopen <dir> <card>                  start up, print what the reconcile found, wait for a line on stdin, reply
//                                        asking for the word, which wakes the agent, print the reply's turn and
//                                        readResult, then stop the agent and exit
import { once } from "node:events";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAcpAgentPort } from "../src/adapters/acp/agent-port.ts";
import { eventBridge, JOB_DONE, reconcileDispatches } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { NOTICE } from "../src/core/notice.ts";
import { delay } from "./driver.ts";

const context = BACKGROUND_CONTEXT;
const [mode, dir, card, repo, word] = process.argv.slice(2);
if (dir === undefined || card === undefined) {
	throw new Error("usage: acp-restart-child.ts dispatch <dir> <card> <repo> <word> | reopen <dir> <card>");
}
const emit = (step: string, value: object) => console.log(JSON.stringify({ step, ...value }));

const brief =
	`Remember this word for later: ${word}. Use no tool. ` +
	"End your turn with exactly two lines: 結果：完成, then the single word NOTED.";
const ask =
	"What was the word I asked you to remember in my first message? Use no tool. " +
	"Reply with exactly two lines: 結果：完成, then that word alone.";

const agents = createAcpAgentPort({
	env: process.env,
	// ANTHROPIC_MODEL picks the session's model; the rest is what main.ts gives an agent for `soma defer`.
	vars: { ANTHROPIC_MODEL: "haiku", SOMA_SOCKET: join(dir, "defer.sock"), SOMA_NODE: process.execPath },
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
		if (text.includes("派工")) return call("dispatch", { card, repo: repo ?? "" });
		if (text.includes("回覆")) return call("reply", { card, text: ask, reason: "the smoke asks for the word" });
		return fauxAssistantMessage("好。");
	}),
);
const models = createModels();
models.setProvider(faux.provider);
const harness = await openHarness(
	join(dir, "soma.sqlite"),
	[dispatchExtension(agents, async () => `# ${card}\n\n${brief}`)],
	context,
	{ models },
);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
harness.resume();
await reconcileDispatches(root, agents, context, await agents.dormant());
const off = eventBridge(root, agents, context).listen((error) => console.error("[soma] event bridge:", error));

const job = async () => (await harness.snapshot(Dispatches, root.id, context))?.jobs.find((each) => each.card === card);
const entries = async (kind: string) =>
	(await root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter((entry) => entry.kind === kind);
const say = async (content: string) => {
	const submission = await root.submit({ type: "input", content, requestId: `smoke:${mode}:${content}` }, context);
	if ((await submission.wait(context)).status !== "done") throw new Error(`the turn of "${content}" did not finish`);
};
async function turns(count: number, ms: number) {
	for (const deadline = Date.now() + ms; ; await delay(250)) {
		const done = await entries(JOB_DONE);
		if (done.length >= count) return done;
		if (Date.now() > deadline) throw new Error(`timed out waiting for turn ${count}`);
	}
}

if (mode === "dispatch") {
	await say("派工");
	const done = await turns(1, 180_000);
	await root.waitForIdle(context);
	emit("recorded", { done: done.map((entry) => entry.data), job: await job(), result: await agents.readResult(card) });
	process.once("SIGTERM", () => {
		off();
		void harness.close(context).then(() => process.exit(0));
	});
} else {
	emit("reconciled", {
		dormant: await agents.dormant(),
		listed: await agents.list(),
		job: await job(),
		notices: (await entries(NOTICE)).map((entry) => entry.data),
		done: (await entries(JOB_DONE)).map((entry) => entry.data),
	});
	const before = (await entries(JOB_DONE)).length;
	// The smoke looks at the processes under this soma first.
	process.stdin.resume();
	await once(process.stdin, "data");
	await say("回覆");
	const done = await turns(before + 1, 120_000);
	await root.waitForIdle(context);
	emit("replied", { done: done.at(-1)?.data, result: await agents.readResult(card), job: await job() });
	await agents.stop(card);
	off();
	await harness.close(context);
	emit("end", {});
	process.exit(0);
}
