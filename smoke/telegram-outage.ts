// Telegram outage smoke: the Telegram client against a local fake Bot API whose getUpdates fails, with the real macOS
// notification and the alert's 10 minutes cut to a few seconds:
//   1. an outage shorter than that ends with a message from the chat and tells nothing on either channel;
//   2. an outage that lasts it shows one notification on this Mac, and no second one while it lasts twice as long;
//   3. the first poll that succeeds sends the chat one message with the outage's start and end, and the next none.
// It shows one real notification titled soma.
//   node smoke/telegram-outage.ts [alertSeconds=6]

import { FakeHumanPort } from "../src/adapters/fake-human/index.ts";
import { FakeBotApi } from "../src/adapters/fake-telegram/index.ts";
import { macNotifier } from "../src/adapters/macos-notification/index.ts";
import { runTelegram } from "../src/adapters/telegram/index.ts";
import { delay } from "./driver.ts";

const alertMs = Number(process.argv[2] ?? 6) * 1_000;
const TOKEN = "123456:smoke";
const CHAT = 4242;
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

const api = new FakeBotApi(TOKEN);
const apiBase = await api.listen();
const human = new FakeHumanPort();
const notify = macNotifier();
const alerts: string[] = [];
let failures = 0;
const controller = new AbortController();
const running = runTelegram({
	human,
	token: TOKEN,
	chatId: CHAT,
	apiBase,
	signal: controller.signal,
	pollTimeoutSeconds: 1,
	retryMs: 500,
	outageAlertMs: alertMs,
	onError: () => {
		failures += 1;
	},
	alert: async (text) => {
		alerts.push(text);
		await notify(text);
		log("notified", text);
	},
});

async function delivered(text: string): Promise<void> {
	api.deliver(text, CHAT);
	for (const deadline = Date.now() + 10_000; !human.inputs.some((input) => input.content === text); await delay(100))
		check(Date.now() < deadline, `timed out waiting for ${text}`);
}

try {
	// Cut connections, as ConnectTimeoutError looked on 2026-11-23.
	api.dropping.add("getUpdates");
	await delay(alertMs / 2);
	api.dropping.delete("getUpdates");
	await delivered("短的");
	await delay(alertMs);
	log("1 short", { failures, alerts: alerts.length, sent: api.sent.length });
	check(failures > 0 && alerts.length === 0 && api.sent.length === 0, "a short outage told something");

	failures = 0;
	api.dropping.add("getUpdates");
	await delay(alertMs * 3);
	log("2 long", { failures, alerts: alerts.length, sent: api.sent.length });
	check(alerts.length === 1 && api.sent.length === 0, "the outage did not alert exactly once");

	api.dropping.delete("getUpdates");
	await delivered("回來了嗎");
	await delivered("再一則");
	log("3 back", { sent: api.sent.map((message) => message.text) });
	check(api.sent.length === 1, "the end of the outage was not told exactly once");
	check(alerts.length === 1, "an alert came after the outage ended");
	console.log("ok");
} finally {
	controller.abort();
	await running;
	await api.close();
}
