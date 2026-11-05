// main.ts's human side with two interfaces, Telegram at $TELEGRAM_API_BASE and the terminal on stdin, a push target
// whose windows are $SOMA_SMOKE_WINDOW_MS, the fake agent side, and the faux model standing in for one that calls
// `dispatch` on 「派 <card> <repo>」, hands every blocked agent to the human with `escalate`, and answers the last
// prompt with option 1 when the human says 「選 1」.
//   node smoke/push-child.ts <db>
// A stdin line starting with "!" drives the core instead of the terminal: "!report <text>" pushes an ambient report
// and "!question <text>" an action, "!block <card> <fingerprint> <seq>" blocks the card's agent on a two-option
// prompt, and "!finish <card> <reply>" ends its turn with that reply, "\n" for a line break. What the terminal prints,
// OSC 7501 included, comes out as {event: "terminal"} lines. $SOMA_SMOKE_BLOCKED, the arguments of one "!block",
// stands for an agent that outlived a killed core: it is blocked before the startup reconcile. $SOMA_SMOKE_PUSH is the
// config file's `push` setting as JSON, read as main.ts reads it; unset, every interface is instant.
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { runTelegram, ENTRY_KIND as TELEGRAM_KIND } from "../src/adapters/telegram/index.ts";
import { runTerminal, ENTRY_KIND as TERMINAL_KIND } from "../src/adapters/terminal/index.ts";
import { ENTRY_KIND as WEB_KIND } from "../src/adapters/web/index.ts";
import { resolveConfig } from "../src/config.ts";
import { eventBridge, reconcileDispatches } from "../src/core/extensions/dispatch/bridge.ts";
import { dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";

const context = BACKGROUND_CONTEXT;
const [db] = process.argv.slice(2);
if (db === undefined) throw new Error("usage: push-child.ts <db>");
const file = process.env.SOMA_SMOKE_PUSH ? { push: JSON.parse(process.env.SOMA_SMOKE_PUSH) as unknown } : undefined;
const { telegram, push } = resolveConfig(file, process.env, homedir());
if (telegram === undefined) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set");
const windowMs = Number(process.env.SOMA_SMOKE_WINDOW_MS ?? 4_000);
const emit = (record: object) => console.log(JSON.stringify(record));

const faux = fauxProvider();
faux.setResponses(
	Array.from({ length: 100 }, () => (transcript: { messages: { role: string; content: unknown }[] }) => {
		const last = transcript.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage("好。");
		const text = JSON.stringify(last?.content ?? "");
		const call = (name: string, args: Record<string, string>) =>
			fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }) as AssistantMessage;
		const [, blocked] = /\[bridge\] agent \S+?（卡片 (\S+?)）卡住了/.exec(text) ?? [];
		if (blocked !== undefined) {
			return call("escalate", { card: blocked, question: "要讓它執行嗎？", reason: "smoke 一律轉給人" });
		}
		if (text.includes("選 1")) {
			const wakes = transcript.messages.map((message) => JSON.stringify(message.content));
			const wake = wakes.findLast((each) => each.includes("fingerprint="));
			const [, card] = /card=([a-z0-9-]+)/.exec(wake ?? "") ?? [];
			const [, fingerprint] = /fingerprint=([0-9a-z]+)/.exec(wake ?? "") ?? [];
			if (card !== undefined && fingerprint !== undefined) {
				return call("respond", { card, option: "1", fingerprint, reason: "人在終端機說選 1" });
			}
		}
		const [, card, repo] = /派 ([a-z0-9-]+) (\S+?)"/.exec(text) ?? [];
		if (card !== undefined && repo !== undefined) return call("dispatch", { card, repo });
		return fauxAssistantMessage("好。");
	}),
);
const models = createModels();
models.setProvider(faux.provider);

const agents = new FakeAgentPort();
const options = [
	{ id: "1", label: "Yes" },
	{ id: "2", label: "No" },
];
const block = (card = "", fingerprint = "", seq = "") =>
	agents.emit(card, { state: "blocked", kind: "permission", msg: "Run it?", fingerprint, options }, Number(seq));
if (process.env.SOMA_SMOKE_BLOCKED) block(...process.env.SOMA_SMOKE_BLOCKED.split(" "));
const harness = await openHarness(db, [dispatchExtension(agents, async (_repo, card) => `# ${card}`)], context, {
	models,
});
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
harness.resume();
const human = await openHumanPort(harness, root, agents, context, {
	defaultTarget: TELEGRAM_KIND,
	policies: { [TELEGRAM_KIND]: push.telegram, [TERMINAL_KIND]: push.terminal, [WEB_KIND]: push.web },
	presenceMs: windowMs,
	escalateMs: windowMs,
	checkMs: 200,
});
await reconcileDispatches(root, agents, context);
eventBridge(root, agents, context).listen((error) => emit({ event: "bridge_error", error: String(error) }));
void runTelegram({ ...telegram, human, signal: new AbortController().signal, retryMs: 500 });

const typed = new PassThrough();
const screen = new PassThrough();
screen.setEncoding("utf8").on("data", (chunk: string) => {
	for (const line of chunk.split("\n").filter(Boolean)) emit({ event: "terminal", line });
});
void runTerminal({ human, input: typed, output: screen, programStatus: true });
emit({ event: "started" });
for await (const line of createInterface({ input: process.stdin })) {
	const [command, ...rest] = line.split(" ");
	if (command === "!report" || command === "!question") {
		await (command === "!report"
			? human.notify(rest.join(" "), "report", "ambient")
			: human.notify(rest.join(" "), "question", "action"));
	} else if (command === "!block") block(...rest);
	else if (command === "!finish") {
		const [card = "", ...reply] = rest;
		agents.emit(card, { state: "working" });
		agents.finish(card, reply.join(" ").replaceAll("\\n", "\n"));
	} else typed.write(`${line}\n`);
	emit({ event: "done", line });
}
