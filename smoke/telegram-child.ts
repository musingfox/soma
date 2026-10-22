// main.ts's startup with the Telegram and terminal clients, the faux model standing in for one that calls
// `dispatch` on 「派 <card> <repo>」 and writes the digest's report (no API key on this machine), and a stub card
// asking for a result line. Talks to the herdr session at $SOMA_HERDR_SOCKET and the Bot API at $TELEGRAM_API_BASE.
//   node smoke/telegram-child.ts <db> <digestPeriodMs>
// stdin lines go to the terminal client; what it prints comes out as {event: "terminal"} lines. A report line
// each second carries this process's model calls, the Telegram inputs and the finished jobs.
// SOMA_SMOKE_KILL_IN_DISPATCH=1 kills the process with SIGKILL when the model is asked to dispatch.
import { homedir } from "node:os";
import { PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHerdrAgentPort } from "../src/adapters/herdr/agent-port.ts";
import { createHerdrClient } from "../src/adapters/herdr/client.ts";
import { runTelegram } from "../src/adapters/telegram/index.ts";
import { runTerminal } from "../src/adapters/terminal/index.ts";
import { resolveConfig } from "../src/config.ts";
import { digest } from "../src/core/extensions/digest/index.ts";
import { eventBridge, JOB_DONE, reconcileDispatches } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";

const context = BACKGROUND_CONTEXT;
const [db, period] = process.argv.slice(2);
if (db === undefined || period === undefined) throw new Error("usage: telegram-child.ts <db> <digestPeriodMs>");
const { telegram } = resolveConfig(undefined, process.env, homedir());
if (telegram === undefined) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set");
const emit = (record: object) => console.log(JSON.stringify(record));

const faux = fauxProvider();
faux.setResponses(
	Array.from({ length: 50 }, () => (transcript: { messages: { role: string; content: unknown }[] }) => {
		const last = transcript.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage("已派工。");
		const text = JSON.stringify(last?.content ?? "");
		if (text.includes("[digest ")) {
			const jobs = [...text.matchAll(/卡片 (\S+?)（agent \S+?）結果：(\S+?)\\n/g)].map(
				([, card, outcome]) => `${card} ${outcome}`,
			);
			return fauxAssistantMessage([fauxText(`報告：${jobs.join("；")}`)]);
		}
		const [, card, repo] = /派 ([a-z0-9-]+) (\S+?)"/.exec(text) ?? [];
		if (card === undefined || repo === undefined) return fauxAssistantMessage(`回答：${text.slice(0, 40)}`);
		if (process.env.SOMA_SMOKE_KILL_IN_DISPATCH === "1") process.kill(process.pid, "SIGKILL");
		return fauxAssistantMessage([fauxToolCall("dispatch", { card, repo })], {
			stopReason: "toolUse",
		}) as AssistantMessage;
	}),
);
const models = createModels();
models.setProvider(faux.provider);
const stubCard = async (_repo: string, card: string) =>
	`# ${card}\n\n第一行寫「結果：完成」，第二行只寫 ok 兩個字，不要使用任何工具。`;

const agents = createHerdrAgentPort({ client: createHerdrClient({ socketPath: process.env.SOMA_HERDR_SOCKET }) });
const digests = digest(agents);
const harness = await openHarness(db, [dispatchExtension(agents, stubCard), digests.extension], context, { models });
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
harness.resume();
await digests.startDigest(root, Number(period), context);
await reconcileDispatches(root, agents, context);
eventBridge(root, agents, context).listen((error) => emit({ event: "bridge_error", error: String(error) }));

const human = await openHumanPort(harness, root, agents, context);
void runTelegram({ ...telegram, human, signal: new AbortController().signal, retryMs: 500 });
const screen = new PassThrough();
screen.setEncoding("utf8").on("data", (chunk: string) => {
	for (const line of chunk.split("\n").filter(Boolean)) emit({ event: "terminal", line });
});
void runTerminal({ human, input: process.stdin, output: screen, programStatus: false });
emit({ event: "started", pid: process.pid });

for (;;) {
	const entries = (await root.entries({}, 1000, undefined, context)).items;
	emit({
		event: "report",
		calls: faux.state.callCount,
		telegramInputs: entries.filter((entry) => entry.kind === "chat.telegram").length,
		done: entries.filter((entry) => entry.kind === JOB_DONE).map((entry) => entry.data),
		jobs: ((await harness.snapshot(Dispatches, root.id, context))?.jobs ?? []).map((job) => job.card),
	});
	await new Promise((resolve) => setTimeout(resolve, 1_000));
}
