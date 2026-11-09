// One soma, as the ACP handover crash smoke runs it: the two-sided port as main.ts wires it, the ACP side on
// <dir>/acp-sessions.json and the rex side on the smoke's own hangar, the real core on <dir>/soma.sqlite, and a faux model
// standing in for soma's, which calls `dispatch` at 「派工」, `show_job` at 「給我看」, `reply` at 「回覆」 and `respond` when the
// bridge wakes it for a dialog. Each step is printed as one JSON line.
//   first <scenario> <dir> <hangar> <card> <repo> <word>  start up, dispatch the card, whose brief plants the word, print
//                                                         "recorded" once the turn is recorded, wait for a line on stdin,
//                                                         then call show_job, and die by SIGKILL at the scenario's point
//   second <scenario> <dir> <hangar> <card> <repo> <word> start up, print what the reconcile found, wait for a line on
//                                                         stdin, in `before` reply once too soon and wait for the notice of
//                                                         the job's return, reply asking for the word, print the turn and
//                                                         readResult, wait for a line, and exit
// The scenario `before` dies as `take` is called, past the mark and the end of the ACP process, with no window; `after`
// dies as the reply to session.new_window comes, with the window open, before anything else of `take` runs and before
// the final mark, so its claude is met by a trust dialog nobody has answered. Only the first soma is wrapped to die. The
// second soma of `after` prints what the dialog's answer took: "woken" for the model's wake, and "dialog" with the screen
// the first key was pressed on and "key" for each key. Every claude runs with <dir>/claude-config as its CLAUDE_CONFIG_DIR.
import { once } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAcpAgentPort } from "../src/adapters/acp/agent-port.ts";
import { createHandoverAgentPort } from "../src/adapters/handover/agent-port.ts";
import { createRexAgentPort } from "../src/adapters/rex/agent-port.ts";
import { createRexClient, defaultRexSocket } from "../src/adapters/rex/client.ts";
import { FormatResultSchema, TERMINAL } from "../src/adapters/rex/schema.ts";
import { eventBridge, handoverBridge, JOB_DONE, reconcileDispatches } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { NOTICE } from "../src/core/notice.ts";
import type { AgentState } from "../src/ports/agent.ts";
import { delay } from "./driver.ts";

const context = BACKGROUND_CONTEXT;
const [mode, scenario, dir, hangar, card, repo, word] = process.argv.slice(2);
if (dir === undefined || hangar === undefined || card === undefined || repo === undefined || word === undefined) {
	throw new Error("usage: acp-handover-crash-child.ts first|second before|after <dir> <hangar> <card> <repo> <word>");
}
const emit = (step: string, value: object) => console.log(JSON.stringify({ step, ...value }));
const onError = (error: Error) => console.error(`[soma] ${error.message}`);

const die = (): never => {
	emit("dying", { at: scenario });
	process.kill(process.pid, "SIGKILL");
	throw new Error("SIGKILL did not end the process");
};

const client = createRexClient({ socketPath: process.env.SOMA_REX_SOCKET ?? defaultRexSocket(homedir()), onError });
if (mode === "first" && scenario === "after") {
	const { call } = client;
	client.call = async (method, payload, schema) => {
		const reply = await call(method, payload, schema);
		if (method === "session.new_window") die();
		return reply;
	};
}
if (mode === "second" && scenario === "after") {
	const { call } = client;
	let pressed = false;
	client.call = async (method, payload, schema) => {
		const { event, session_id, block_id } = payload as {
			event?: { type: string; payload: { key: string; action: string } };
			session_id?: string;
			block_id?: string;
		};
		if (method === "block.event" && event?.type === "key" && event.payload.action === "press") {
			// Read just before the first key: once the answer lands, the dialog is gone.
			if (!pressed) {
				pressed = true;
				const args = { format: "text", trim: true, max_bytes: 65_536 };
				const screen = await call(`${TERMINAL}.format`, { session_id, block_id, args }, FormatResultSchema);
				emit("dialog", { screen: screen.content.split("\n") });
			}
			emit("key", { key: event.payload.key });
		}
		return call(method, payload, schema);
	};
}
const bin = join(fileURLToPath(new URL("..", import.meta.url)), "bin");
const config = join(dir, "claude-config");
const projectsDir = join(config, "projects");
const env = {
	SOMA_SOCKET: join(dir, "defer.sock"),
	SOMA_NODE: process.execPath,
	CLAUDE_CONFIG_DIR: config,
	// claude names its login's Keychain item after a CLAUDE_CONFIG_DIR, which would leave this config with no login.
	// Empty, this keeps the usual name; the smoke handles no credential.
	CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
};
const acp = createAcpAgentPort({
	env: process.env,
	// ANTHROPIC_MODEL picks the ACP session's model; the window is told by the --model the handover reads off its reply.
	vars: { ...env, ANTHROPIC_MODEL: "haiku" },
	path: bin,
	sessionsFile: join(dir, "acp-sessions.json"),
	projectsDir,
	onError,
});
const rex = createRexAgentPort({
	client,
	sessionId: hangar,
	onError,
	env,
	path: bin,
	projectsDir,
	sessionsDir: join(config, "sessions"),
	takeMs: 60_000,
});
const agents = createHandoverAgentPort({
	from: acp,
	to: mode === "first" && scenario === "before" ? { ...rex, take: async () => die() } : rex,
	onError,
});

let blocked: Extract<AgentState, { state: "blocked" }> | undefined;
agents.onStatus(({ agent, status }) => {
	if (status.state === "blocked") blocked = status;
	emit("status", { agent, state: status.state, kind: status.state === "blocked" ? status.kind : undefined });
});

const brief =
	`Remember this word for later: ${word}. Use no tool. ` +
	"End your turn with exactly two lines: 結果：完成, then the single word NOTED.";
const ask =
	"What was the word I asked you to remember in my first message? Use no tool. " +
	"Reply with exactly two lines: 結果：完成, then that word alone.";

const results: unknown[] = [];
const faux = fauxProvider();
faux.setResponses(
	Array.from({ length: 20 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
		const last = request.messages.at(-1);
		if (last?.role === "toolResult") {
			results.push((last.content as { text?: string }[])[0]?.text);
			emit("tool", { result: results.at(-1) });
			return fauxAssistantMessage("好。");
		}
		const text = JSON.stringify(last?.content ?? "");
		const call = (name: string, args: Record<string, string>) =>
			fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
		const fingerprint = /fingerprint=([0-9a-f]{16})/.exec(text)?.[1];
		if (fingerprint !== undefined) {
			// The fixture's order, should the wake have come from the listing and not from a status this process heard.
			const option =
				blocked?.state === "blocked" ? (blocked.options?.find((each) => /^yes\b/i.test(each.label))?.id ?? "1") : "2";
			emit("woken", { wake: text, option, fingerprint });
			return call("respond", { card, option, fingerprint, reason: "the smoke trusts its own repo" });
		}
		if (text.includes("派工")) return call("dispatch", { card, repo });
		if (text.includes("給我看")) return call("show_job", { card });
		if (text.includes("回覆")) return call("reply", { card, text: ask, reason: "the smoke asks for the word" });
		return fauxAssistantMessage("好。");
	}),
);
const models = createModels();
models.setProvider(faux.provider);
const harness = await openHarness(
	join(dir, "soma.sqlite"),
	[dispatchExtension(agents, async () => `# ${card}\n\n${brief}`, agents)],
	context,
	{ models },
);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
harness.resume();
const offSettled = handoverBridge(root, agents, context).listen((error) => console.error("[soma] handover:", error));
await agents.heard();
await reconcileDispatches(root, agents, context, await agents.dormant());
const offEvents = eventBridge(root, agents, context).listen((error) => console.error("[soma] event bridge:", error));

const job = async () => (await harness.snapshot(Dispatches, root.id, context))?.jobs.find((each) => each.card === card);
const entries = async (kind: string) =>
	(await root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter((entry) => entry.kind === kind);
const notices = async () => (await entries(NOTICE)).map((entry) => entry.data as { content: string });
const say = async (content: string) => {
	const submission = await root.submit({ type: "input", content, requestId: `smoke:${mode}:${content}` }, context);
	if ((await submission.wait(context)).status !== "done") throw new Error(`the turn of "${content}" did not finish`);
	await root.waitForIdle(context);
};
async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
	for (const deadline = Date.now() + ms; ; await delay(250)) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
	}
}
process.stdin.resume();
const go = () => once(process.stdin, "data");

if (mode === "first") {
	await say("派工");
	const done = await until("the brief's turn", 180_000, async () => {
		const found = await entries(JOB_DONE);
		return found.length > 0 ? found : undefined;
	});
	await root.waitForIdle(context);
	emit("recorded", { done: done.map((entry) => entry.data), job: await job(), result: await agents.readResult(card) });
	await go();
	await say("給我看");
	throw new Error(`show_job returned, so this soma did not die: ${JSON.stringify(results.at(-1))}`);
}

// The handover bridge told of the window the startup's look found before the reconcile.
if (scenario === "after" && (await notices()).length === 0) throw new Error("no notice of the move at startup");
emit("reconciled", {
	dormant: await agents.dormant(),
	listed: await agents.list(),
	job: await job(),
	notices: await notices(),
	done: (await entries(JOB_DONE)).map((entry) => entry.data),
});
await go();
if (scenario === "before") {
	await say("回覆 太早");
	emit("too soon", { result: results.at(-1) });
	const told = await until("the notice of the return", 90_000, async () => {
		const all = await notices();
		return all.some(({ content }) => content.includes("is back on ACP")) ? all : undefined;
	});
	emit("back", { notices: told });
}
const up = await until("the job to be at rest on its side", 120_000, async () => {
	const listed = (await agents.list()).find((each) => each.name === card);
	if (listed?.status === undefined) return scenario === "before" ? listed : undefined;
	return listed.status.state === "idle" || listed.status.state === "done" ? listed : undefined;
});
emit("at rest", { listed: up });
await say("回覆");
emit("said", { result: results.at(-1) });
const result = await until("the word to come back", 180_000, async () => {
	const read = await agents.readResult(card);
	return read?.text?.includes(word) ? read : undefined;
});
await root.waitForIdle(context);
emit("replied", {
	result,
	job: await job(),
	done: (await entries(JOB_DONE)).at(-1)?.data,
	listed: await agents.list(),
	notices: await notices(),
});
await go();
if (scenario === "before") await agents.stop(card);
offEvents();
offSettled();
await harness.close(context);
client.close();
emit("end", {});
process.exit(0);
