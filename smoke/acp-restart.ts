// ACP restart smoke, against the real claude-agent-acp and real claude on haiku. Two soma processes in turn on one db
// and one sessions file (smoke/acp-restart-child.ts), as a soma and the soma that restarts after it:
//   1. the first dispatches a card into a throwaway git repo over ACP, whose brief plants a word; once the turn is
//      recorded, the smoke notes every process under it, then ends it with SIGTERM, which ends it as main.ts's shutdown
//      does, and checks that none of those processes is left;
//   2. the second starts up: its port lists the agent dormant, with no process under the soma, and the startup
//      reconcile leaves its job done, recording no turn and telling the human nothing, since nothing of it was cut; the
//      faux model replies asking for the word, which starts the agent again with session/load of its session, and
//      readResult reads the word back.
// Two prompts run on haiku. It kills what is left of its children, and removes its repo, what claude keeps for the
// repo and its worktree under ~/.claude/projects and its db at the end, also on failure.
//   node smoke/acp-restart.ts
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { projectDirNameFor } from "../src/agent-cli/transcript.ts";
import { runGit } from "../src/agent-cli/worktree.ts";
import { delay } from "./driver.ts";

const CHILD = fileURLToPath(new URL("./acp-restart-child.ts", import.meta.url));
const tag = Date.now().toString(36);
const card = `smoke-${tag}`;
const word = `KUMQUAT-${tag}`;
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

type Line = { step: string } & Record<string, unknown>;

/** A soma of the smoke's, with every JSON line it printed so far; its stderr goes to the smoke's. */
function soma(args: string[]): {
	process: ChildProcess;
	lines: Line[];
	next: (step: string, ms: number) => Promise<Line>;
} {
	const child = spawn(process.execPath, [CHILD, ...args], { stdio: ["pipe", "pipe", "inherit"] });
	const lines: Line[] = [];
	createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
		try {
			const parsed = JSON.parse(line) as Line;
			lines.push(parsed);
			if (parsed.step === "status") log("status", { agent: parsed.agent, state: parsed.state, msg: parsed.msg });
		} catch {
			console.log(line);
		}
	});
	const next = async (step: string, ms: number) => {
		for (const deadline = Date.now() + ms; ; await delay(250)) {
			const found = lines.find((line) => line.step === step);
			if (found !== undefined) return found;
			check(child.exitCode === null && child.signalCode === null, `the soma exited before "${step}"`);
			check(Date.now() < deadline, `timed out waiting for "${step}"`);
		}
	};
	return { process: child, lines, next };
}

/** Every process under `pid`, with its command, as ps lists them now. */
function descendants(pid: number): { pid: number; command: string }[] {
	const rows = spawnSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
		.stdout.trim()
		.split("\n")
		.map((row) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row))
		.filter((match) => match !== null)
		.map(([, child, parent, command]) => ({ pid: Number(child), ppid: Number(parent), command: command ?? "" }));
	const under = new Set([pid]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const row of rows) {
			if (!under.has(row.pid) && under.has(row.ppid)) {
				under.add(row.pid);
				grew = true;
			}
		}
	}
	return rows.filter((row) => row.pid !== pid && under.has(row.pid)).map(({ pid, command }) => ({ pid, command }));
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const directory = await realpath(await mkdtemp(join(tmpdir(), "soma-acp-restart-")));
const repo = join(directory, "repo");
const projects = join(homedir(), ".claude", "projects");
const children: ChildProcess[] = [];
// The first soma's agent processes: killed at the end if the check that they are gone failed.
let orphans: number[] = [];
const git = (...args: string[]) => runGit(repo, args);
const worktree = join(repo, ".claude", "worktrees", card);

await runGit(directory, ["init", "-q", "-b", "main", repo]);
await writeFile(join(repo, "README.md"), `# acp restart smoke ${tag}\n`);
await git("add", "README.md");
const identity = ["-c", "user.name=soma smoke", "-c", "user.email=smoke@example.com", "-c", "commit.gpgsign=false"];
await git(...identity, "commit", "-q", "--no-verify", "-m", "chore: init");
log("repo", { repo, word });

try {
	const first = soma(["dispatch", directory, card, repo, word]);
	children.push(first.process);
	const recorded = await first.next("recorded", 240_000);
	log("recorded", { done: recorded.done, result: recorded.result });
	const sessions = JSON.parse(await readFile(join(directory, "acp-sessions.json"), "utf8"));
	log("session", sessions[card]);
	const tree = descendants(first.process.pid as number);
	log(
		"processes",
		tree.map(({ pid, command }) => ({ pid, command: command.slice(0, 120) })),
	);
	check(
		tree.some(({ command }) => command.includes("claude-agent-acp")),
		"no claude-agent-acp process runs under the first soma",
	);

	first.process.kill("SIGTERM");
	const [code, signal] = (await new Promise((resolve) => first.process.once("exit", (...exit) => resolve(exit)))) as [
		number | null,
		string | null,
	];
	log("exit", { code, signal });
	check(code === 0, `the first soma exited with ${signal ?? `code ${code}`}`);
	orphans = tree.map(({ pid }) => pid);
	for (const deadline = Date.now() + 15_000; orphans.some(alive) && Date.now() < deadline; ) await delay(250);
	const left = tree.filter(({ pid }) => alive(pid));
	log("left", left);
	check(left.length === 0, `${left.length} of the first soma's processes are still alive`);
	orphans = [];

	const second = soma(["reopen", directory, card]);
	children.push(second.process);
	const reconciled = await second.next("reconciled", 120_000);
	log("reconciled", reconciled);
	check(
		JSON.stringify(reconciled.dormant) === JSON.stringify([card]),
		"the second soma does not list the agent dormant",
	);
	const notices = (reconciled.notices as { content: string }[]).filter(({ content }) =>
		content.startsWith("soma 重新啟動後"),
	);
	check(notices.length === 0, `${notices.length} notices of the restart of a job that was done`);
	check((reconciled.job as { status?: { state?: string } }).status?.state === "done", "the job is no longer done");
	check((reconciled.done as unknown[]).length === 1, "the restart recorded a turn");
	// The second soma waits for the smoke before it replies.
	await delay(2_000);
	const asleep = descendants(second.process.pid as number);
	log("dormant", asleep);
	check(
		!asleep.some(({ command }) => command.includes("claude-agent-acp")),
		"a claude-agent-acp process runs under the second soma before any prompt",
	);
	second.process.stdin?.write("go\n");
	// The agent the reply wakes, seen while its turn runs: the soma stops it once the turn is read.
	let woken: { pid: number; command: string }[] = [];
	const watch = setInterval(() => {
		if (woken.length > 0) return;
		woken = descendants(second.process.pid as number).filter(({ command }) => command.includes("claude-agent-acp"));
	}, 250);
	const replied = await second.next("replied", 180_000).finally(() => clearInterval(watch));
	log("woken", woken);
	check(woken.length > 0, "no claude-agent-acp process ran under the second soma for the reply");
	log("replied", { done: replied.done, result: replied.result });
	const text = (replied.result as { text?: string } | undefined)?.text ?? "";
	check(text.includes(word), "the reply after the restart does not hold the planted word");
	await second.next("end", 30_000);
	const transcripts = spawnSync("ls", [join(projects, projectDirNameFor(await realpath(worktree)))], {
		encoding: "utf8",
	}).stdout;
	log("transcripts", transcripts.trim().split("\n"));
	console.log("PASS");
} finally {
	for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	for (const pid of orphans) if (alive(pid)) process.kill(pid, "SIGKILL");
	const real = await realpath(worktree).catch(() => worktree);
	for (const path of [real, repo]) await rm(join(projects, projectDirNameFor(path)), { recursive: true, force: true });
	await rm(directory, { recursive: true, force: true });
}
