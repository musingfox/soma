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
// own mode cannot skip the prompt. claude runs with its own CLAUDE_CONFIG_DIR beside the repo, so the dialog is asked
// and its answer lands there: a run that gains a trust entry in ~/.claude.json for a path of its own fails. Repo,
// worktrees and config go at the end.
//   node smoke/tty.ts
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeBotApi } from "../src/adapters/fake-telegram/index.ts";
import { readLastRecord, readSessionModel, resolveTranscriptPath } from "../src/agent-cli/transcript.ts";
import { type Child, delay, run } from "./driver.ts";

const CHILD = fileURLToPath(new URL("./tty-child.ts", import.meta.url));
const TOKEN = "123456:smoke";
const CHAT = 4242;
const tag = Date.now().toString(36);
const card = `tty-${tag}`;
const gone = `tty-gone-${tag}`;
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

type Job = { card: string; sessionId: string; status: { state: string; msg?: string }; outcome?: string };
type Report = {
	calls: number;
	jobs: Job[];
	notices: { kind: string; content: string }[];
	done: unknown[];
	screens: Record<string, string>;
};

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

const reports = (child: Child) => child.lines.filter((line) => line.event === "report") as unknown as Report[];

async function until<T>(child: Child, what: string, probe: (report: Report) => T | undefined, ms: number): Promise<T> {
	for (const deadline = Date.now() + ms; ; await delay(250)) {
		const errors = child.lines.filter((line) => line.event === "bridge_error" || line.event === "tty_error");
		check(errors.length === 0, `error: ${JSON.stringify(errors)}`);
		const last = reports(child).at(-1);
		// A throwaway config may hold no login, and then nothing else on this screen changes until the deadline.
		for (const [agent, screen] of Object.entries(last?.screens ?? {})) {
			check(!/Select login method|Not logged in/.test(screen), `claude has no login in ${agent}:\n${screen}`);
		}
		const value = last && probe(last);
		if (value !== undefined) return value;
		check(Date.now() < deadline, `timed out waiting for ${what}; last report ${JSON.stringify(last)}`);
	}
}

/** The project paths the `.claude.json` in `directory` marks as trusted; nothing else is read out of it. */
async function trusted(directory: string): Promise<Set<string>> {
	const text = await readFile(join(directory, ".claude.json"), "utf8");
	const { projects } = JSON.parse(text) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
	return new Set(
		Object.entries(projects ?? {}).flatMap(([path, entry]) => (entry.hasTrustDialogAccepted ? [path] : [])),
	);
}

/** The claude processes started with `sessionId`, by pid. */
const claudesOf = (sessionId: string) =>
	spawnSync("pgrep", ["-f", `claude --session-id ${sessionId}`], { encoding: "utf8" }).stdout.trim();

const bot = new FakeBotApi(TOKEN);
const apiBase = await bot.listen();
const directory = await realpath(await mkdtemp(join(tmpdir(), "soma-tty-")));
const repo = join(directory, "repo");
const canary = join(directory, "canary");
const config = join(directory, "claude-config");
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
	// Past the first-run screens, which come before the dialog; there is nothing else in this config to start with.
	await mkdir(config);
	await writeFile(join(config, ".claude.json"), `${JSON.stringify({ hasCompletedOnboarding: true })}\n`);
	const trustedBefore = await trusted(homedir());
	const db = join(directory, "soma.sqlite");
	const env = {
		...process.env,
		TELEGRAM_BOT_TOKEN: TOKEN,
		TELEGRAM_CHAT_ID: String(CHAT),
		TELEGRAM_API_BASE: apiBase,
		CLAUDE_CONFIG_DIR: config,
		// claude names its login's Keychain item after a CLAUDE_CONFIG_DIR, which would leave this config with no login.
		// Empty, this keeps the usual name; the smoke handles no credential. Without it the run stops at "no login".
		CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
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
				if (/trust this folder/i.test(yes.text)) log("dialog", report.screens[card]?.split("\n"));
				bot.press(yes.callback_data, CHAT);
			}
			return report.jobs.find((job) => job.card === card && job.outcome !== undefined);
		},
		240_000,
	);
	const pressed = [...answered].map((index) => bot.sent[index]?.reply_markup?.inline_keyboard.flat() ?? []);
	check(
		pressed.some((buttons) => buttons.some((button) => /^Yes, I trust this folder/.test(button.text))),
		"the trust dialog never reached the chat",
	);
	check(
		pressed.some((buttons) => buttons.some((button) => button.text === "Yes")),
		"the Bash permission prompt never reached the chat",
	);
	check(finished.outcome === "完成", `the job's outcome is ${finished.outcome}`);
	check(existsSync(`${canary}-${card}`), "the agent did not run the command it was allowed");
	const transcript = await resolveTranscriptPath(
		finished.sessionId,
		join(repo, ".claude/worktrees", card),
		join(config, "projects"),
	);
	check(transcript !== undefined, "no transcript for the session");
	const reply = await readLastRecord(transcript as string);
	check(reply?.text?.includes("ok") === true, `the agent replied ${JSON.stringify(reply?.text)}`);
	log("done", { job: finished, reply: reply?.text, model: await readSessionModel(transcript as string) });
	check((await trusted(config)).has(repo), "the answer to the dialog did not land in the smoke's own config");

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
	const gained = [...(await trusted(homedir()))].filter((path) => !trustedBefore.has(path));
	// Other claudes of the human's may gain theirs meanwhile.
	const ours = gained.filter((path) => path.startsWith(directory));
	log("trust", { gained, ours, inOwnConfig: [...(await trusted(config))] });
	check(ours.length === 0, `~/.claude.json gained trust for ${JSON.stringify(ours)}`);
	console.log("ok");
} finally {
	for (const child of children) child.process.kill("SIGKILL");
	await bot.close();
	// A claude that outlives its core by a moment writes its config back, after a removal that came too soon.
	const sessions = children.flatMap((child) => reports(child).flatMap(({ jobs }) => jobs.map((job) => job.sessionId)));
	for (const deadline = Date.now() + 10_000; Date.now() < deadline && new Set(sessions).size > 0; await delay(250)) {
		if ([...new Set(sessions)].every((sessionId) => claudesOf(sessionId) === "")) break;
	}
	spawnSync("git", ["-C", repo, "worktree", "prune"]);
	await rm(directory, { recursive: true, force: true });
	log("cleanup", { directoryLeft: existsSync(directory) });
}
