// Summary smoke: Telegram at summary on a local fake Bot API and the terminal at instant on the child's stdin, one
// core, with the idle time cut to IDLE_MINUTES through `push.summary.idleMinutes`:
//   1. three jobs end 失敗 and a blocked fourth is escalated by the model: the terminal shows all four at once and
//      Telegram gets none of them;
//   2. the core is killed while they are held and reopened: once the human has typed nowhere for the idle time,
//      Telegram gets one summary with a sound, then the question with its buttons and no sound;
//   3. killed and reopened once more, past the idle time again: Telegram gets nothing more.
//   node smoke/push-summary.ts [payloads.json]   (the run's Bot API payloads and terminal lines are written there)
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeBotApi } from "../src/adapters/fake-telegram/index.ts";
import { type Child, delay, run } from "./driver.ts";

const CHILD = fileURLToPath(new URL("./push-child.ts", import.meta.url));
const TOKEN = "123456:smoke";
const CHAT = 4242;
const IDLE_MINUTES = 1 / 3;
const IDLE_MS = IDLE_MINUTES * 60_000;
const PUSH = { telegram: "summary", terminal: "instant", summary: { idleMinutes: IDLE_MINUTES } };
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

async function until<T>(child: Child, what: string, probe: () => T | undefined, ms = 10_000): Promise<T> {
	for (const deadline = Date.now() + ms; ; await delay(100)) {
		const errors = child.lines.filter((line) => line.event === "bridge_error");
		check(errors.length === 0, `error: ${JSON.stringify(errors)}`);
		const value = probe();
		if (value !== undefined) return value;
		check(Date.now() < deadline, `timed out waiting for ${what}`);
	}
}

const bot = new FakeBotApi(TOKEN);
const apiBase = await bot.listen();
const directory = await mkdtemp(join(tmpdir(), "soma-push-summary-"));
const children: Child[] = [];
const terminal: { core: number; line: string }[] = [];
try {
	const db = join(directory, "soma.sqlite");
	const start = async (blocked?: string) => {
		const child = run([db], CHILD, {
			...process.env,
			TELEGRAM_BOT_TOKEN: TOKEN,
			TELEGRAM_CHAT_ID: String(CHAT),
			TELEGRAM_API_BASE: apiBase,
			SOMA_SMOKE_PUSH: JSON.stringify(PUSH),
			...(blocked && { SOMA_SMOKE_BLOCKED: blocked }),
		});
		children.push(child);
		await child.next("started");
		return child;
	};
	const send = (child: Child, line: string) => child.process.stdin?.write(`${line}\n`);
	const screen = (child: Child) =>
		child.lines.flatMap((line) => (line.event === "terminal" ? [String(line.line)] : []));
	const kill = async (child: Child) => {
		terminal.push(...screen(child).map((line) => ({ core: children.indexOf(child) + 1, line })));
		child.process.kill("SIGKILL");
		await child.exited;
	};

	const first = await start();
	for (const card of ["c1", "c2", "c3", "c4"]) {
		send(first, `派 ${card} /repo`);
		await until(first, `${card} dispatched`, () =>
			screen(first).filter((line) => line.includes("好。")).length >= Number(card.slice(1)) ? 1 : undefined,
		);
	}
	const typedAt = Date.now();
	for (const card of ["c1", "c2", "c3"]) send(first, `!finish ${card} 結果：失敗\\n${card} 的測試沒過。`);
	send(first, "!block c4 fp4 200");
	await until(first, "the four pushes on the terminal", () => {
		const shown = screen(first);
		const results = ["c1", "c2", "c3"].every((card) =>
			shown.some((line) => line.includes(`（卡片 ${card}）這一輪結束了`)),
		);
		return results && shown.some((line) => line.includes("卡片 c4")) ? 1 : undefined;
	});
	await delay(1_000);
	check(
		bot.sent.length === 0,
		`Telegram got ${bot.sent.length} messages while all was held: ${JSON.stringify(bot.sent)}`,
	);
	check(Date.now() - typedAt < IDLE_MS, "the pushes took longer than the idle time; the kill would not be while held");
	log("1 held", { telegram: bot.sent.length, terminal: screen(first).filter((line) => line.startsWith("[")) });
	await kill(first);

	const second = await start("c4 fp4 200");
	const [summary, question] = await until(
		second,
		"the summary and the question on Telegram",
		() => (bot.sent.length >= 2 ? bot.sent : undefined),
		IDLE_MS + 10_000,
	);
	check(summary?.text.includes("摘要：") === true, `the first message is not the summary: ${summary?.text}`);
	check(summary?.disable_notification === undefined, "the summary did not ring");
	for (const card of ["c1", "c2", "c3", "c4"])
		check(summary?.text.includes(card) === true, `the summary lacks ${card}`);
	check(question?.text.includes("卡片 c4") === true, `the second message is not c4's question: ${question?.text}`);
	check(question?.reply_markup !== undefined, "the question came without its buttons");
	check(question?.disable_notification === true, "the question rang");
	log("2 summary", { sinceTyped: Date.now() - typedAt, summary, question });
	await delay(2_000);
	await kill(second);

	const third = await start("c4 fp4 200");
	await delay(IDLE_MS + 3_000);
	check(bot.sent.length === 2, `Telegram got ${bot.sent.length} messages across the restarts, not 2`);
	log("3 restart", { telegram: bot.sent.length });
	await kill(third);

	const saveTo = process.argv[2];
	if (saveTo !== undefined) {
		const payloads = { push: PUSH, sendMessage: bot.sent, otherBotApiCalls: bot.calls, terminal };
		await writeFile(saveTo, `${JSON.stringify(payloads, null, 2)}\n`);
	}
	console.log("PASS");
} finally {
	for (const child of children) child.process.kill("SIGKILL");
	await bot.close();
	await rm(directory, { recursive: true, force: true });
}
