// Telegram client smoke against a local fake Bot API (no bot token on this machine) and a real herdr test session:
//   1. a phone message 「派 <card> <repo>」 is admitted, and the core is killed with SIGKILL while the model answers;
//   2. Telegram delivers the same update again to a reopened core: the interrupted round finishes and the chat
//      gets one confirmation, with one Telegram input, one job and one herdr agent;
//   3. a question typed in the terminal is answered there and never reaches the chat;
//   4. the agent is walked past its folder trust prompt and finishes; the digest's report reaches the chat once,
//      within one digest period of the finished turn, and nothing else (the herdr wake's answer) does.
// It runs in a throwaway git repo, so claude shows its trust prompt; the repo, worktree and agent go at the end.
//   node smoke/telegram.ts <herdr socket of a test session> [digestPeriodSeconds=8]
// See smoke/terminal.ts for starting and removing a herdr test session from inside a herdr pane.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeBotApi } from "../src/adapters/fake-telegram/index.ts";
import { createHerdrClient } from "../src/adapters/herdr/client.ts";
import { type Child, delay, run } from "./driver.ts";

const [socket, seconds] = process.argv.slice(2);
if (socket === undefined) throw new Error("usage: telegram.ts <herdr socket> [digestPeriodSeconds]");
const periodMs = Number(seconds ?? 8) * 1_000;
const CHILD = fileURLToPath(new URL("./telegram-child.ts", import.meta.url));
const TOKEN = "123456:smoke";
const CHAT = 4242;
const card = `smoke-${Date.now().toString(36)}`;
const herdr = createHerdrClient({ socketPath: socket });
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

type Report = { calls: number; telegramInputs: number; done: unknown[]; jobs: string[] };

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

const named = async () => (await herdr.agentList()).filter((agent) => agent.name === card);

async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, ms: number): Promise<T> {
	for (const deadline = Date.now() + ms; ; await delay(250)) {
		const value = await probe();
		if (value !== undefined) return value;
		check(Date.now() < deadline, `timed out waiting for ${what}`);
	}
}

const lastReport = (child: Child) => {
	const errors = child.lines.filter((line) => line.event === "bridge_error");
	check(errors.length === 0, `bridge error: ${JSON.stringify(errors)}`);
	return child.lines.findLast((line) => line.event === "report") as unknown as Report | undefined;
};

const api = new FakeBotApi(TOKEN);
const directory = await mkdtemp(join(tmpdir(), "soma-telegram-"));
const children: Child[] = [];
try {
	const apiBase = await api.listen();
	const db = join(directory, "soma.sqlite");
	const repo = join(directory, "repo");
	spawnSync("git", ["init", "-q", repo]);
	spawnSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "chore: init"]);
	const env = {
		...process.env,
		SOMA_HERDR_SOCKET: socket,
		TELEGRAM_BOT_TOKEN: TOKEN,
		TELEGRAM_CHAT_ID: String(CHAT),
		TELEGRAM_API_BASE: apiBase,
	};
	const args = [db, String(periodMs)];
	log("card", card);

	const first = run(args, CHILD, { ...env, SOMA_SMOKE_KILL_IN_DISPATCH: "1" });
	children.push(first);
	await first.next("started");
	const update = api.deliver(`派 ${card} ${repo}`, CHAT);
	await first.exited;
	check(first.process.signalCode === "SIGKILL", `the first core ended by ${first.process.signalCode}`);
	check(api.sent.length === 0, `sent before the kill: ${JSON.stringify(api.sent)}`);
	check((await named()).length === 0, "an agent started before the kill");
	log("killed", { during: "the dispatch round", requestId: `telegram:${update.message.message_id}` });

	api.redeliver(update);
	const second = run(args, CHILD, env);
	children.push(second);
	await second.next("started");
	await until("the confirmation", () => (api.sent.length > 0 ? true : undefined), 30_000);
	await delay(3_000);
	const confirmed = lastReport(second) as Report;
	check(
		JSON.stringify(api.sent) === JSON.stringify([{ chat_id: CHAT, text: "已派工。", parse_mode: "HTML" }]),
		"wrong confirmation",
	);
	check(confirmed.telegramInputs === 1, `${confirmed.telegramInputs} Telegram inputs after the redelivery`);
	check(JSON.stringify(confirmed.jobs) === JSON.stringify([card]), `jobs ${JSON.stringify(confirmed.jobs)}`);
	check((await named()).length === 1, `herdr holds ${(await named()).length} agents named ${card}`);
	log("redeliver", { sent: api.sent, telegramInputs: confirmed.telegramInputs, jobs: confirmed.jobs });

	second.process.stdin?.write("今天天氣如何\n");
	const answered = await until(
		"the terminal answer",
		() => second.lines.find((line) => line.event === "terminal" && String(line.line).startsWith("回答：")),
		15_000,
	);
	await delay(2_000);
	check(
		api.sent.every((message) => !message.text.includes("今天天氣")),
		`the terminal answer reached the chat: ${JSON.stringify(api.sent)}`,
	);
	log("terminal", { printed: answered.line, sentToChat: api.sent.length });

	await until(
		"the trust prompt",
		async () => ((await herdr.agentGet(card)).agent_status === "blocked" ? true : undefined),
		30_000,
	);
	const pane = (await herdr.agentGet(card)).pane_id;
	// Claude Code's folder trust prompt: the cursor starts on "No, exit".
	await herdr.paneSendKeys(pane, ["Down"]);
	await delay(300);
	await herdr.paneSendKeys(pane, ["Enter"]);
	await until("the finished turn", () => (lastReport(second)?.done.length ? true : undefined), 180_000);
	const doneAt = Date.now();
	const report = `[通知] 報告：${card} 完成`;
	await until(
		"the report",
		() => (api.sent.some((message) => message.text === report) ? true : undefined),
		periodMs * 2,
	);
	const reportAfterMs = Date.now() - doneAt;
	await delay(periodMs * 2);
	check(reportAfterMs <= periodMs + 2_000, `the report came ${reportAfterMs} ms after the turn finished`);
	check(
		JSON.stringify(api.sent.map((message) => message.text)) === JSON.stringify(["已派工。", report]),
		`the chat got ${JSON.stringify(api.sent)}`,
	);
	log("report", { reportAfterMs, periodMs, sent: api.sent.map((message) => message.text) });
	console.log("PASS");
} finally {
	for (const child of children) child.process.kill("SIGKILL");
	await api.close();
	const agent = (await named())[0];
	if (agent !== undefined) await herdr.call("worktree.remove", { workspace_id: agent.workspace_id, force: true });
	await rm(directory, { recursive: true, force: true });
}
