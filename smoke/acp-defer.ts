// ACP defer smoke, against the real claude-agent-acp and real claude on haiku, the counterpart of smoke/rex-defer.ts. Two
// soma processes in turn on one db and one sessions file (smoke/acp-defer-child.ts), as a soma and the soma that restarts
// after it:
//   1. a throwaway git repo whose committed .claude/settings.json sets permissions.defaultMode "default", so the agent
//      asks before its Bash call whatever the user's own mode is, and the faux model answers option 1;
//   2. the first soma dispatches a card whose brief plants a word and has the agent run `soma defer --at PT2M` in its
//      own Bash, asking for the word back; the transcript must hold that Bash call, and the instruction not the word;
//   3. the turn over, the core stops the agent: its job ends reclaim `stopped` with the turn recorded once, its entry is
//      marked stopped, it is not listed, and no process that ran under the soma for it is left;
//   4. the first soma is killed with SIGKILL during the wait, and the second starts up: the agent is not dormant, no
//      agent process runs under it, its job is unchanged, and nothing says it is gone;
//   5. at fire time the second soma starts the agent again with session/load: the deferral ends `sent`, the mark is off,
//      and the reply to the instruction holds the planted word;
//   6. the brief and the instruction each reached the session's transcript once, and the instruction no other, the
//      second turn is the only one recorded since, no notice was written, and the second soma's model was never called.
// Two prompts run on haiku. It kills what is left of its children, and removes its repo, what claude keeps for the repo
// and its worktree under ~/.claude/projects and its db at the end, also on failure.
//   node smoke/acp-defer.ts
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { projectDirNameFor, resolveTranscriptPath } from "../src/agent-cli/transcript.ts";
import { runGit } from "../src/agent-cli/worktree.ts";
import type { Job } from "../src/core/domain/dispatch.ts";
import { type Child, delay, run } from "./driver.ts";

const CHILD = fileURLToPath(new URL("./acp-defer-child.ts", import.meta.url));
const tag = Date.now().toString(36);
const card = `smoke-${tag}`;
const word = `KUMQUAT-${tag}`;
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

/** The next line of `event` the soma prints, or a failure showing the statuses it reported so far. */
function next(child: Child, event: string, ms: number) {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const statuses = child.lines.filter((line) => line.event === "status");
			reject(new Error(`timed out waiting for "${event}"; the statuses were ${JSON.stringify(statuses)}`));
		}, ms);
	});
	return Promise.race([child.next(event), late]).finally(() => clearTimeout(timer));
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
	// ps shows a process that has exited, and waits to be reaped, as <defunct> or by its name in parentheses.
	return rows
		.filter((row) => row.pid !== pid && under.has(row.pid) && !/^(<defunct>|\(.*\))$/.test(row.command))
		.map(({ pid, command }) => ({ pid, command }));
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Notes every process seen under `pid` until `stop` is called, which returns them by pid. */
function watch(pid: number) {
	const seen = new Map<number, string>();
	const look = () => {
		for (const each of descendants(pid)) seen.set(each.pid, each.command);
	};
	look();
	const timer = setInterval(look, 250);
	return () => {
		clearInterval(timer);
		look();
		return seen;
	};
}

/** The user records of the transcript that carry `text`: what the agent was prompted with. */
const promptedWith = async (transcript: string, text: string) =>
	(await readFile(transcript, "utf8"))
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as { type?: string; message?: { content?: unknown } })
		.filter((record) => record.type === "user" && JSON.stringify(record.message?.content ?? "").includes(text)).length;

/** The commands of the transcript's Bash calls: what the agent itself ran. */
const bashCalls = async (transcript: string) =>
	(await readFile(transcript, "utf8"))
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as { type?: string; message?: { content?: unknown } })
		.filter((record) => record.type === "assistant" && Array.isArray(record.message?.content))
		.flatMap((record) => record.message?.content as { type?: string; name?: string; input?: { command?: string } }[])
		.filter((block) => block.type === "tool_use" && block.name === "Bash")
		.map((block) => block.input?.command ?? "");

const directory = await realpath(await mkdtemp(join(tmpdir(), "soma-acp-defer-")));
const repo = join(directory, "repo");
const projects = join(homedir(), ".claude", "projects");
const children: Child[] = [];
// The first soma's agent processes: killed at the end if the check that they are gone failed.
let orphans: number[] = [];
const git = (...args: string[]) => runGit(repo, args);
const worktree = join(repo, ".claude", "worktrees", card);
const sessionsFile = join(directory, "acp-sessions.json");
const sessions = async () =>
	JSON.parse(await readFile(sessionsFile, "utf8")) as Record<
		string,
		{ acpSessionId: string; cwd: string; stopped?: true }
	>;

await runGit(directory, ["init", "-q", "-b", "main", repo]);
await writeFile(join(repo, "README.md"), `# acp defer smoke ${tag}\n`);
await mkdir(join(repo, ".claude"));
await writeFile(
	join(repo, ".claude", "settings.json"),
	`${JSON.stringify({ permissions: { defaultMode: "default" } })}\n`,
);
await git("add", "README.md", ".claude/settings.json");
const identity = ["-c", "user.name=soma smoke", "-c", "user.email=smoke@example.com", "-c", "commit.gpgsign=false"];
await git(...identity, "commit", "-q", "--no-verify", "-m", "chore: init");
log("repo", { repo, word, bin: join(dirname(dirname(fileURLToPath(import.meta.url))), "bin") });

try {
	const first = run(["dispatch", directory, card, repo, word], CHILD);
	children.push(first);
	const firstWatch = watch(first.process.pid as number);
	const deferred = await next(first, "deferred", 240_000);
	const [[deferral, item] = ["", {}]] = Object.entries(deferred.pending as Record<string, object>);
	const { at, instruction } = item as { at: number; instruction: string };
	log("deferred", { deferral, at: new Date(at).toISOString(), instruction });
	check(!instruction.includes(word), "the instruction holds the word, so answering it proves nothing");

	const reclaimed = await next(first, "reclaimed", 120_000);
	const seen = firstWatch();
	const job = reclaimed.job as Job;
	log("reclaimed", { job, listed: reclaimed.listed, done: reclaimed.done, notices: reclaimed.notices });
	check(job.reclaim?.phase === "stopped", `the job's reclaim is ${JSON.stringify(job.reclaim)}`);
	check(job.status.state === "done", `the stopped job is ${JSON.stringify(job.status)}`);
	check((reclaimed.listed as unknown[]).length === 0, "the stopped agent is still listed");
	check((reclaimed.done as unknown[]).length === 1, `${(reclaimed.done as unknown[]).length} turns recorded`);
	check((reclaimed.notices as unknown[]).length === 0, `notices: ${JSON.stringify(reclaimed.notices)}`);
	const entry = (await sessions())[card];
	check(entry?.stopped === true, `the entry is ${JSON.stringify(entry)}`);
	const { acpSessionId, cwd } = entry as { acpSessionId: string; cwd: string };
	log("session", entry);

	// The agent's own Bash ran it, with the environment and the PATH soma gave it.
	const transcript = await resolveTranscriptPath(acpSessionId, cwd);
	check(transcript !== undefined, "the session has no transcript");
	const calls = await bashCalls(transcript as string);
	log("bash", calls);
	check(
		calls.some((command) => command.includes("soma defer")),
		"the agent's transcript holds no `soma defer` Bash call",
	);

	// Every process that ran for it under the soma, the CLI and its MCP servers too, ends with the stop.
	const processes = [...seen].map(([pid, command]) => ({ pid, command }));
	log(
		"processes",
		processes.map(({ pid, command }) => ({ pid, command: command.slice(-80) })),
	);
	check(
		processes.some(({ command }) => command.includes("claude-agent-acp")),
		"no claude-agent-acp process was seen under the first soma",
	);
	orphans = processes.map(({ pid }) => pid);
	for (const deadline = Date.now() + 15_000; orphans.some(alive) && Date.now() < deadline; ) await delay(250);
	const left = processes.filter(({ pid }) => alive(pid));
	log("left", left);
	check(left.length === 0, `${left.length} of the agent's processes are still alive after its stop`);
	orphans = [];
	check(descendants(first.process.pid as number).length === 0, "something still runs under the first soma");

	await delay(3_000);
	first.process.kill("SIGKILL");
	await first.exited;
	check(first.process.signalCode === "SIGKILL", `the first soma ended by ${first.process.signalCode}`);
	check(Date.now() < at, "killed after the deferral fell due; the wait was not exercised");
	check(
		(await promptedWith(transcript as string, `[soma deferred instruction ${deferral}]`)) === 0,
		"the instruction reached the agent before it fell due",
	);
	log("killed", { signal: "SIGKILL", at: new Date().toISOString(), due: new Date(at).toISOString() });

	const second = run(["reopen", directory, card], CHILD);
	children.push(second);
	const started = await next(second, "started", 60_000);
	const after = started.job as Job;
	log("started", { job: after, listed: started.listed, dormant: started.dormant, result: started.result });
	check(isDeepStrictEqual(started.pending, [deferral]), `pending: ${started.pending}`);
	check((started.dormant as unknown[]).length === 0, "the stopped agent is dormant on the second soma");
	check((started.listed as unknown[]).length === 0, "the stopped agent is listed on the second soma");
	check(isDeepStrictEqual(after, job), "the restart changed the job");
	check((started.done as unknown[]).length === 1, "the restart recorded a turn");
	check((started.notices as unknown[]).length === 0, `notices: ${JSON.stringify(started.notices)}`);
	await delay(2_000);
	check(Date.now() < at, "the second soma came up after the deferral fell due; the wait was not exercised");
	const asleep = descendants(second.process.pid as number);
	check(asleep.length === 0, `under the second soma before the fire: ${JSON.stringify(asleep)}`);

	const secondWatch = watch(second.process.pid as number);
	const settled = await next(second, "settled", at - Date.now() + 120_000);
	log("fired", { outcome: settled.outcome, late: Number(settled.at) - at });
	check(
		isDeepStrictEqual(settled.outcome, { status: "completed", result: "sent" }),
		`the deferral ended ${JSON.stringify(settled.outcome)}`,
	);
	check(Number(settled.at) >= at, "the deferral fired early");
	check((await sessions())[card]?.stopped === undefined, "the stopped mark is still on the entry");

	const answered = await next(second, "answered", 180_000);
	const reply = (answered.result as { text?: string } | undefined)?.text ?? "";
	log("answered", { reply });
	check(reply.includes(word), "the reply to the instruction does not hold the planted word");
	const report = await next(second, "report", 30_000);
	const woken = [...secondWatch()].filter(([, command]) => command.includes("claude-agent-acp"));
	log("woken", woken.length);
	check(woken.length > 0, "no claude-agent-acp process ran under the second soma");

	log(
		"statuses",
		second.lines.filter((line) => line.event === "status").map(({ state, msg }) => ({ state, msg })),
	);
	const final = report.job as Job;
	const done = report.done as { outcome: string }[];
	log("report", { job: final, done, notices: report.notices, modelCalls: report.modelCalls });
	check(final.reclaim === undefined, `the job's reclaim is ${JSON.stringify(final.reclaim)}`);
	check(final.sessionId === job.sessionId, `the job's session is now ${final.sessionId}`);
	check(done.length === 2, `${done.length} turns recorded in all`);
	check((report.notices as unknown[]).length === 0, `notices: ${JSON.stringify(report.notices)}`);
	check(report.modelCalls === 0, `the second soma called the model ${report.modelCalls} times`);

	// Both prompts in the one transcript: the brief as the first soma sent it, the instruction once, nothing again.
	const prompts = {
		brief: await promptedWith(transcript as string, `Remember this word for later: ${word}`),
		instruction: await promptedWith(transcript as string, `[soma deferred instruction ${deferral}]`),
	};
	// A hook of the user's may run a claude of its own in the worktree, so only the instruction tells a fork.
	const folder = dirname(transcript as string);
	const files = (await readdir(folder)).filter((name) => name.endsWith(".jsonl"));
	const holding = [];
	for (const file of files) {
		if ((await promptedWith(join(folder, file), `[soma deferred instruction ${deferral}]`)) > 0) holding.push(file);
	}
	log("transcript", { prompts, files, holding });
	check(prompts.brief === 1, `the brief reached the agent ${prompts.brief} times`);
	check(prompts.instruction === 1, `the instruction reached the agent ${prompts.instruction} times`);
	check(isDeepStrictEqual(holding, [`${acpSessionId}.jsonl`]), `the instruction is in ${holding}`);
	check((await second.exited) === 0, "the second soma failed");
	console.log("PASS");
} finally {
	for (const child of children)
		if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill("SIGKILL");
	for (const pid of orphans) if (alive(pid)) process.kill(pid, "SIGKILL");
	const real = await realpath(worktree).catch(() => worktree);
	for (const path of [real, repo]) await rm(join(projects, projectDirNameFor(path)), { recursive: true, force: true });
	await rm(directory, { recursive: true, force: true });
}
