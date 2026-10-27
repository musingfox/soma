// Push-target smoke: two interfaces on one core, the terminal on the child's stdin and Telegram on a local fake
// Bot API, with the presence and escalation windows cut to a few seconds:
//   1. after the human typed on the terminal, a report rings there and reaches Telegram without a sound;
//   2. once the window passed, a report reaches Telegram with a sound;
//   3. a blocked agent's question goes to the terminal and, unheeded, reaches Telegram once more with a sound;
//      answered on the terminal, its buttons on Telegram give way to 「已在別處處理」;
//   4. a question the human typed after, anywhere, is not pushed again;
//   5. a core killed while a question waits is reopened twice, and the question reaches Telegram once.
//   node smoke/push.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeBotApi, type SentMessage } from "../src/adapters/fake-telegram/index.ts";
import { type Child, delay, run } from "./driver.ts";

const CHILD = fileURLToPath(new URL("./push-child.ts", import.meta.url));
const TOKEN = "123456:smoke";
const CHAT = 4242;
const WINDOW_MS = 3_000;
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
const directory = await mkdtemp(join(tmpdir(), "soma-push-"));
const children: Child[] = [];
const sent = (match: string) => bot.sent.filter((message) => message.text.includes(match));
const loud = (messages: SentMessage[]) => messages.filter((message) => message.disable_notification === undefined);
try {
	const db = join(directory, "soma.sqlite");
	const start = async (blocked?: string) => {
		const child = run([db], CHILD, {
			...process.env,
			TELEGRAM_BOT_TOKEN: TOKEN,
			TELEGRAM_CHAT_ID: String(CHAT),
			TELEGRAM_API_BASE: apiBase,
			SOMA_SMOKE_WINDOW_MS: String(WINDOW_MS),
			...(blocked && { SOMA_SMOKE_BLOCKED: blocked }),
		});
		children.push(child);
		await child.next("started");
		return child;
	};
	const send = (child: Child, line: string) => child.process.stdin?.write(`${line}\n`);
	const screen = (child: Child) => child.lines.flatMap((line) => (line.event === "terminal" ? [line.line] : []));

	const first = await start();
	send(first, "在嗎");
	await until(first, "the answer", () => screen(first).find((line) => String(line).includes("好。")));
	const rootBefore = screen(first).length;
	send(first, "!report r1 報告");
	const [r1] = await until(first, "r1 on Telegram", () => (sent("r1 報告").length > 0 ? sent("r1 報告") : undefined));
	check(r1?.disable_notification === true, "r1 rang on Telegram while the human was on the terminal");
	await until(first, "the terminal to ring for r1", () =>
		screen(first)
			.slice(rootBefore)
			.find((line) => String(line).includes("\x1b]7501;state=done:app=soma")),
	);
	log("1 report", { telegram: r1 });

	await delay(WINDOW_MS + 500);
	send(first, "!report r2 報告");
	const [r2] = await until(first, "r2 on Telegram", () => (sent("r2 報告").length > 0 ? sent("r2 報告") : undefined));
	check(r2?.disable_notification === undefined, "r2 was silent though the human typed nowhere lately");
	log("2 report", { telegram: r2 });

	send(first, "派 c1 /repo");
	await until(first, "c1 dispatched", () =>
		screen(first).some((line) => String(line).includes("好。")) ? 1 : undefined,
	);
	send(first, "!block c1 fp1 100");
	const silent = await until(first, "c1's question", () => sent("卡片 c1").at(0));
	check(silent.disable_notification === true, "c1's question rang on Telegram while the human was on the terminal");
	const escalated = await until(first, "c1's escalation", () => loud(sent("卡片 c1")).at(0), WINDOW_MS + 5_000);
	check(escalated.reply_markup !== undefined, "the escalated question has no buttons");
	await delay(WINDOW_MS);
	check(loud(sent("卡片 c1")).length === 1, `c1 escalated ${loud(sent("卡片 c1")).length} times`);
	send(first, "選 1");
	const edits = await until(first, "c1's buttons removed", () => {
		const done = bot.calls.filter(
			(call) => call.method === "editMessageReplyMarkup" && JSON.stringify(call.params).includes("已在別處處理"),
		);
		return done.length >= 2 ? done : undefined;
	});
	log("3 question", { silent, escalated, edits: edits.length });

	send(first, "派 c2 /repo");
	await delay(500);
	send(first, "!block c2 fp2 101");
	await until(first, "c2's question", () => sent("卡片 c2").at(0));
	send(first, "我看到了");
	await delay(WINDOW_MS + 2_000);
	check(loud(sent("卡片 c2")).length === 0, "c2 escalated though the human typed after it");
	log("4 typed", { c2: sent("卡片 c2").length });

	send(first, "派 c3 /repo");
	await delay(500);
	send(first, "!block c3 fp3 102");
	await until(first, "c3's question", () => sent("卡片 c3").at(0));
	first.process.kill("SIGKILL");
	await first.exited;
	for (const round of [1, 2]) {
		const again = await start("c3 fp3 102");
		if (round === 1) await until(again, "c3's escalation", () => loud(sent("卡片 c3")).at(0), WINDOW_MS + 5_000);
		else await delay(WINDOW_MS + 2_000);
		again.process.kill("SIGKILL");
		await again.exited;
	}
	check(loud(sent("卡片 c3")).length === 1, `c3 escalated ${loud(sent("卡片 c3")).length} times across restarts`);
	log("5 restart", { c3: sent("卡片 c3").length });
	console.log("PASS");
} finally {
	for (const child of children) child.process.kill("SIGKILL");
	await bot.close();
	await rm(directory, { recursive: true, force: true });
}
