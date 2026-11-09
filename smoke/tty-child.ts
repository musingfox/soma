// main.ts's startup with the native tty adapter and the Telegram client, the faux model standing in for one that
// calls `dispatch` on 「派 <card> <repo>」 and hands every blocked agent to the human with `escalate` (no API key on
// this machine), and a stub card whose Bash command stops at a permission prompt. Talks to the Bot API at
// $TELEGRAM_API_BASE.
//   node smoke/tty-child.ts <db> <file each card's agent creates>
// A report line each second carries this process's model calls, the jobs, the notices, the finished turns and each
// running agent's screen. Its claude runs with $CLAUDE_CONFIG_DIR, where its transcripts go too.
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { runTelegram } from "../src/adapters/telegram/index.ts";
import { createTtyAgentPort } from "../src/adapters/tty/agent-port.ts";
import { spawnPty } from "../src/adapters/tty/pty.ts";
import { resolveConfig } from "../src/config.ts";
import { eventBridge, JOB_DONE, reconcileDispatches } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";
import { NOTICE } from "../src/core/notice.ts";

const context = BACKGROUND_CONTEXT;
const [db, canary] = process.argv.slice(2);
if (db === undefined || canary === undefined) throw new Error("usage: tty-child.ts <db> <canary file>");
const config = process.env.CLAUDE_CONFIG_DIR;
if (config === undefined) throw new Error("CLAUDE_CONFIG_DIR must be set");
const { telegram } = resolveConfig(undefined, process.env, homedir());
if (telegram === undefined) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set");
const emit = (record: object) => console.log(JSON.stringify(record));

const faux = fauxProvider();
faux.setResponses(
	Array.from({ length: 50 }, () => (transcript: { messages: { role: string; content: unknown }[] }) => {
		const last = transcript.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage("好。");
		const text = JSON.stringify(last?.content ?? "");
		const [, blocked] = /\[bridge\] agent \S+?（卡片 (\S+?)）卡住了/.exec(text) ?? [];
		if (blocked !== undefined) {
			return fauxAssistantMessage(
				[fauxToolCall("escalate", { card: blocked, question: "要讓它執行這個指令嗎？", reason: "smoke 一律轉給人" })],
				{ stopReason: "toolUse" },
			) as AssistantMessage;
		}
		const [, card, repo] = /派 ([a-z0-9-]+) (\S+?)"/.exec(text) ?? [];
		if (card === undefined || repo === undefined) return fauxAssistantMessage("好。");
		return fauxAssistantMessage([fauxToolCall("dispatch", { card, repo })], {
			stopReason: "toolUse",
		}) as AssistantMessage;
	}),
);
const models = createModels();
models.setProvider(faux.provider);
const stubCard = async (_repo: string, card: string) =>
	`# ${card}\n\n用 Bash 工具執行這一個指令：touch ${canary}-${card}\n` +
	"做完後回覆兩行：第一行寫「結果：完成」，第二行只寫 ok 兩個字。";

const agents = createTtyAgentPort({
	spawn: spawnPty,
	env: process.env,
	projectsDir: join(config, "projects"),
	onError: (error) => emit({ event: "tty_error", error: error.message }),
});
const harness = await openHarness(db, [dispatchExtension(agents, stubCard)], context, { models });
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
harness.resume();
// In main.ts's order: the HumanPort opens before the reconcile, whose notices it must pass on.
const human = await openHumanPort(harness, root, agents, context);
await reconcileDispatches(root, agents, context);
eventBridge(root, agents, context).listen((error) => emit({ event: "bridge_error", error: String(error) }));
void runTelegram({ ...telegram, human, signal: new AbortController().signal, retryMs: 500 });
emit({ event: "started", pid: process.pid });

for (;;) {
	const entries = (await root.entries({}, 1000, undefined, context)).items;
	const listed = await agents.list();
	const screens = await Promise.all(
		listed.map(async ({ name }) => [name, await agents.readScreen(name).catch(() => "")] as const),
	);
	emit({
		event: "report",
		calls: faux.state.callCount,
		jobs: ((await harness.snapshot(Dispatches, root.id, context))?.jobs ?? []).map((job) => ({
			card: job.card,
			sessionId: job.sessionId,
			status: job.status,
			outcome: job.outcome,
		})),
		notices: entries.filter((entry) => entry.kind === NOTICE).map((entry) => entry.data),
		done: entries.filter((entry) => entry.kind === JOB_DONE).map((entry) => entry.data),
		screens: Object.fromEntries(screens),
	});
	await new Promise((resolve) => setTimeout(resolve, 1_000));
}
