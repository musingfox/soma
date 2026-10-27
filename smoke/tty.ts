// Native tty smoke against real claude and a local fake Bot API (one bot cannot be polled by two processes, and
// prod polls the real one), with no multiplexer:
//   1. a phone message 「派 <card> <repo>」 dispatches the card; claude stops at its folder-trust dialog, then at
//      the permission prompt of its Bash command; the model hands each to the human, and the chat gets a question
//      with a button per option;
//   2. the human presses "Yes" on each; the agent runs the command, finishes, and the turn is recorded 完成 with the
//      reply claude's transcript ends on;
//   3. a second card, whose repo is trusted now, is dispatched and blocks at its prompt; the core is killed with
//      SIGKILL, which takes its claude down too;
//   4. a reopened core records that job as failed with "agent is gone" and tells the chat once; a core reopened
//      once more tells it no more.
// The repo is a throwaway one under $TMPDIR whose .claude/settings.json sets defaultMode "default", so the user's
// own mode cannot skip the prompt. Repo and worktrees go at the end; the trust claude recorded for the repo stays in
// ~/.claude.json, one stale entry per run.
//   node smoke/tty.ts
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeBotApi } from "../src/adapters/fake-telegram/index.ts";
import { readLastRecord, resolveTranscriptPath } from "../src/agent-cli/transcript.ts";
import { type Child, delay, run } from "./driver.ts";

const CHILD = fileURLToPath(new URL("./tty-child.ts", import.meta.url));
const TOKEN = "123456:smoke";
const CHAT = 4242;
const tag = Date.now().toString(36);
const card = `tty-${tag}`;
const gone = `tty-gone-${tag}`;
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

type Job = { card: string; sessionId: string; status: { state: string; msg?: string }; outcome?: string };
type Report = { calls: number; jobs: Job[]; notices: { kind: string; content: string }[]; done: unknown[] };

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

const reports = (child: Child) => child.lines.filter((line) => line.event === "report") as unknown as Report[];

async function until<T>(child: Child, what: string, probe: (report: Report) => T | undefined, ms: number): Promise<T> {
	for (const deadline = Date.now() + ms; ; await delay(250)) {
		const errors = child.lines.filter((line) => line.event === "bridge_error" || line.event === "tty_error");
		check(errors.length === 0, `error: ${JSON.stringify(errors)}`);
		const last = reports(child).at(-1);
		const value = last && probe(last);
		if (value !== undefined) return value;
		check(Date.now() < deadline, `timed out waiting for ${what}; last report ${JSON.stringify(last)}`);
	}
}

/** The claude processes started with `sessionId`, by pid. */
const claudesOf = (sessionId: string) =>
	spawnSync("pgrep", ["-f", `claude --session-id ${sessionId}`], { encoding: "utf8" }).stdout.trim();

const bot = new FakeBotApi(TOKEN);
const apiBase = await bot.listen();
const directory = await realpath(await mkdtemp(join(tmpdir(), "soma-tty-")));
const repo = join(directory, "repo");
const canary = join(directory, "canary");
const children: Child[] = [];
try {
	spawnSync("git", ["init", "-q", repo]);
	await mkdir(join(repo, ".claude"));
	await writeFile(
		join(repo, ".claude/settings.json"),
		`${JSON.stringify({ permissions: { defaultMode: "default" } })}\n`,
	);
	spawnSync("git", ["-C", repo, "add", "."]);
	spawnSync("git", ["-C", repo, "commit", "-q", "-m", "chore: init"]);
	const db = join(directory, "soma.sqlite");
	const env = {
		...process.env,
		TELEGRAM_BOT_TOKEN: TOKEN,
		TELEGRAM_CHAT_ID: String(CHAT),
		TELEGRAM_API_BASE: apiBase,
	};
	const start = () => {
		const child = run([db, canary], CHILD, env);
		children.push(child);
		return child;
	};
	log("repo", { repo, card, gone });

	const first = start();
	await first.next("started");
	bot.deliver(`派 ${card} ${repo}`, CHAT);
	// Each question answered Yes as it reaches the chat, until the turn is recorded.
	const answered = new Set<number>();
	const finished = await until(
		first,
		"the finished turn",
		(report) => {
			for (const [index, message] of bot.sent.entries()) {
				const yes = message.reply_markup?.inline_keyboard.flat().find((button) => /^Yes\b/.test(button.text));
				if (answered.has(index) || yes?.callback_data === undefined) continue;
				answered.add(index);
				log("question", { text: message.text, pressed: yes.text });
				bot.press(yes.callback_data, CHAT);
			}
			return report.jobs.find((job) => job.card === card && job.outcome !== undefined);
		},
		240_000,
	);
	const pressed = [...answered].map((index) => bot.sent[index]?.reply_markup?.inline_keyboard.flat() ?? []);
	check(
		pressed.some((buttons) => buttons.some((button) => button.text === "Yes")),
		"the Bash permission prompt never reached the chat",
	);
	check(finished.outcome === "完成", `the job's outcome is ${finished.outcome}`);
	check(existsSync(`${canary}-${card}`), "the agent did not run the command it was allowed");
	const transcript = await resolveTranscriptPath(finished.sessionId, join(repo, ".claude/worktrees", card));
	check(transcript !== undefined, "no transcript for the session");
	const reply = await readLastRecord(transcript as string);
	check(reply?.text?.includes("ok") === true, `the agent replied ${JSON.stringify(reply?.text)}`);
	log("done", { job: finished, reply: reply?.text });

	bot.deliver(`派 ${gone} ${repo}`, CHAT);
	const blocked = await until(
		first,
		"the second card's block",
		(report) => report.jobs.find((job) => job.card === gone && job.status.state === "blocked"),
		120_000,
	);
	check(claudesOf(blocked.sessionId) !== "", "the second card's claude is not running");
	first.process.kill("SIGKILL");
	await first.exited;
	check(first.process.signalCode === "SIGKILL", `first core ended by ${first.process.signalCode}`);
	await delay(2_000);
	const orphans = claudesOf(blocked.sessionId);
	log("killed", { signal: "SIGKILL", orphans });
	check(orphans === "", `claude outlived the core: pids ${orphans}`);

	const told = (message: { text: string }) => message.text.includes(gone) && message.text.includes("不見了");
	for (const round of ["reopened", "again"]) {
		const core = start();
		const failed = await until(
			core,
			"the gone job",
			(report) => report.jobs.find((job) => job.card === gone && job.status.state === "error"),
			20_000,
		);
		check(failed.status.msg === "agent is gone", `the job failed with ${failed.status.msg}`);
		// Telegram's sends follow the notice; a few seconds lets a second one show.
		await delay(5_000);
		const tellings = bot.sent.filter(told);
		check(tellings.length === 1, `the chat was told ${tellings.length} times after the ${round} core`);
		check(reports(core).at(-1)?.calls === 0, "the reopened core called the model");
		log(round, { job: failed, chat: tellings.map((message) => message.text) });
		core.process.kill("SIGKILL");
		await core.exited;
	}
	console.log("ok");
} finally {
	for (const child of children) child.process.kill("SIGKILL");
	await bot.close();
	spawnSync("git", ["-C", repo, "worktree", "prune"]);
	await rm(directory, { recursive: true, force: true });
}
