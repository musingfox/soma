// Event-bridge smoke through the rex adapter, against the real rex server and real claude, with no key pressed by the
// smoke:
//   1. a dedicated rex session, labelled soma-smoke-<random>, is the hangar, and a fresh git repo under ~/.cache (not
//      $TMPDIR, which claude trusts on its own) is the card's repo, so claude stops on its folder-trust dialog, for
//      which it reports no status record;
//   2. a core dispatches the card; the adapter's trust-dialog check emits blocked under the seq of claude's start plus
//      3 s, and the model is woken exactly once; it asks the human whether to trust the folder;
//   3. the core is killed with SIGKILL after the wake's run finished, before the job's seq was committed;
//   4. a reopened core sees the block again: its requestId makes the submit a no-op, with no model call, and the
//      dialog re-detected every 3 s under new seqs wakes nobody;
//   5. the human says to trust it; the faux model answers with `respond`, the wake's fingerprint and the option
//      "Yes, I trust this folder"; the held launch prompt goes out, the agent finishes, and the dispatch list and
//      transcript record one finished turn, with no further model call;
//   6. the answer landed for the smoke's repo, which the wake named as what a yes trusts, in the CLAUDE_CONFIG_DIR its
//      claude runs with beside the repo, and ~/.claude.json gained no trust entry for a path of its own (read, never
//      written).
// It destroys its rex session, waits for the pane's claude to end, and removes the repo and config at the end, also on
// failure.
//   node smoke/rex-bridge.ts
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createRexClient, defaultRexSocket } from "../src/adapters/rex/client.ts";
import { readProcessStart } from "../src/adapters/rex/process-start.ts";
import {
	AttachAllResultSchema,
	EmptyResultSchema,
	ProcessResultSchema,
	TERMINAL,
	ViewSchema,
} from "../src/adapters/rex/schema.ts";
import { readLastRecord, readSessionModel, resolveTranscriptPath } from "../src/agent-cli/transcript.ts";
import { type Child, delay, run } from "./driver.ts";

const CHILD = fileURLToPath(new URL("./rex-bridge-child.ts", import.meta.url));
const tag = Date.now().toString(36);
const card = `smoke-${tag}`;
const socketPath = process.env.SOMA_REX_SOCKET ?? defaultRexSocket(homedir());
const client = createRexClient({ socketPath, onError: () => {} });
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

type Decision = { action: string; option?: string; fingerprint?: string };
type Job = {
	agent: string;
	seq?: number;
	sessionId: string;
	status: { state: string; fingerprint?: string; msg?: string };
	outcome?: string;
	resultId?: string;
	launchHeld: boolean;
	wake?: string;
	decisions: Decision[];
};
type Report = { calls: number; blocked: unknown[]; done: unknown[]; jobs: Job[] };

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

const reports = (child: Child) => child.lines.filter((line) => line.event === "report") as unknown as Report[];
const jobOf = (report: Report) => report.jobs.find((job) => job.agent === card);

async function until(child: Child, what: string, ok: (report: Report) => boolean, ms: number): Promise<Report> {
	for (const deadline = Date.now() + ms; ; await delay(250)) {
		const errors = child.lines.filter((line) => line.event === "bridge_error");
		check(errors.length === 0, `bridge error: ${JSON.stringify(errors)}`);
		const last = reports(child).at(-1);
		if (last !== undefined && ok(last)) return last;
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

/** The pids of the claudes in the foreground of the session's blocks, which outlive the destroy by a moment. */
async function claudesIn(session: string): Promise<number[]> {
	const { windows } = await client.call("session.view", { session_id: session }, ViewSchema);
	const blocks = (windows ?? []).flatMap((window) =>
		(window.layers ?? []).flatMap((layer) => (layer.blocks ?? []).flatMap((block) => block.block_id ?? [])),
	);
	const processes = await Promise.all(
		blocks.map((blockId) =>
			client.call(`${TERMINAL}.process`, { session_id: session, block_id: blockId, args: {} }, ProcessResultSchema),
		),
	);
	return processes.flatMap(({ foreground }) => (foreground?.argv0 === "claude" ? [foreground.pid as number] : []));
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function ended(pids: number[], ms: number): Promise<boolean> {
	for (const deadline = Date.now() + ms; pids.some(alive) && Date.now() < deadline; ) await delay(200);
	return !pids.some(alive);
}

const created = await client.call(
	"session.create",
	{ label: `soma-smoke-${tag}` },
	z.object({ session_id: z.string() }).passthrough(),
);
const hangar = created.session_id;
// Under ~/.cache, which claude does not trust on its own; realpath, as claude keys its trust by the real path.
const directory = await realpath(await mkdtemp(join(homedir(), ".cache", "soma-rex-bridge-")));
const repo = join(directory, "repo");
const config = join(directory, "claude-config");
const worktree = join(repo, ".claude/worktrees", card);
const children: Child[] = [];
try {
	await client.attach(hangar);
	const trustedBefore = await trusted(homedir());
	check(![...trustedBefore].some((path) => path.startsWith(directory)), "the fresh repo is trusted already");
	const db = join(directory, "soma.sqlite");
	spawnSync("git", ["init", "-q", repo]);
	spawnSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "chore: init"]);
	// Past the first-run screens, which come before the dialog; there is nothing else in this config to start with.
	await mkdir(config);
	await writeFile(join(config, ".claude.json"), `${JSON.stringify({ hasCompletedOnboarding: true })}\n`);
	const env = {
		...process.env,
		CLAUDE_CONFIG_DIR: config,
		SOMA_REX_SESSION_ID: hangar,
		SOMA_REX_LABEL: `soma-smoke-${tag}`,
		SOMA_REX_SOCKET: socketPath,
		SOMA_SMOKE_TRUST_PATH: worktree,
	};
	log("hangar", { session: hangar, label: `soma-smoke-${tag}`, card, repo });

	const first = run(["run", db, card, repo], CHILD, { ...env, SOMA_SMOKE_HANG_AFTER_WAKE: "1" });
	children.push(first);
	const woke = await first.next("woke");
	const view = await client.call("session.view", { session_id: hangar }, ViewSchema);
	const blockId = view.windows?.find((window) => window.label === card)?.layers?.[0]?.blocks?.[0]?.block_id;
	check(typeof blockId === "string", "no window for the card");
	const { foreground } = await client.call(
		`${TERMINAL}.process`,
		{ session_id: hangar, block_id: blockId, args: {} },
		ProcessResultSchema,
	);
	check(foreground?.argv0 === "claude", `foreground is ${foreground?.argv0}`);
	const started = await readProcessStart(foreground?.pid as number);
	check(started !== undefined, "ps cannot tell when claude started");
	const anchored = ((started as number) + 3_000) * 1000;
	check(woke.requestId === `agent:${card}:${anchored}`, `requestId ${woke.requestId}, not claude's start plus 3 s`);
	// Dispatch is two requests (the tool call, then the answer); the wake is the third.
	check(woke.calls === 3, `expected 3 model calls by the wake, got ${woke.calls}`);
	const settled = reports(first).length;
	await delay(7_000);
	const later = reports(first).slice(settled);
	check(later.length >= 5, `only ${later.length} reports in 7 s`);
	check(
		later.every((report) => report.calls === 3 && report.blocked.length === 1),
		`the model was woken again: ${JSON.stringify(later.at(-1))}`,
	);
	log("blocked", { requestId: woke.requestId, calls: later.at(-1)?.calls, wakes: later.at(-1)?.blocked });

	first.process.kill("SIGKILL");
	await first.exited;
	check(first.process.signalCode === "SIGKILL", `first core ended by ${first.process.signalCode}`);
	check(jobOf(later.at(-1) as Report)?.seq === undefined, "the job's seq was committed before the kill");
	log("killed", { signal: "SIGKILL", jobSeq: jobOf(later.at(-1) as Report)?.seq ?? null });

	const second = run(["run", db], CHILD, env);
	children.push(second);
	const resent = await until(second, "the resent block", (report) => jobOf(report)?.seq !== undefined, 15_000);
	check(jobOf(resent)?.seq === anchored, `the reopened core saw the block under seq ${jobOf(resent)?.seq}`);
	// The dialog stays up; the adapter reports it again every 3 s, each time under a new seq.
	const redetected = await until(
		second,
		"a re-detection",
		(report) => (jobOf(report)?.seq ?? 0) > anchored && (jobOf(report)?.seq ?? 0) !== jobOf(resent)?.seq,
		15_000,
	);
	await delay(4_000);
	const quiet = reports(second).at(-1) as Report;
	check(quiet.calls === 0, `the resent block cost ${quiet.calls} model calls`);
	check(quiet.blocked.length === 1, `${quiet.blocked.length} wake entries after the resend`);
	// claude records the trust for the worktree's main checkout, so the wake says that is what a yes trusts.
	const rootLine = jobOf(resent)?.status.msg?.split("\n").at(-1);
	check(rootLine?.includes(`repository root ${repo},`) === true, `the wake's last line is ${JSON.stringify(rootLine)}`);
	const firstWake = jobOf(resent)?.wake;
	check(firstWake === "done", `the wake submission is ${firstWake}`);
	check(jobOf(quiet)?.status.state === "blocked", `the job is ${jobOf(quiet)?.status.state}`);
	log("dialog", { screen: jobOf(resent)?.status.msg?.split("\n"), fingerprint: jobOf(resent)?.status.fingerprint });
	log("resent", {
		calls: quiet.calls,
		wakes: quiet.blocked.length,
		seqs: { first: anchored, redetected: jobOf(redetected)?.seq, now: jobOf(quiet)?.seq },
		wake: firstWake,
		rootLine,
	});

	second.process.stdin?.write(`trust ${card}\n`);
	const answered = await second.next("trusted");
	// The human's go-ahead is one request (the respond call), and the answer after its result another.
	check(answered.calls === 2, `the trust answer took ${answered.calls} model calls`);
	const finished = await until(
		second,
		"the finished turn",
		(report) => report.done.length > 0 && jobOf(report)?.launchHeld === false,
		180_000,
	);
	const decision = jobOf(finished)?.decisions.find((each) => each.action === "answered");
	check(decision?.option === "2", `the answer chose ${JSON.stringify(decision)}`);
	check(decision?.fingerprint === jobOf(resent)?.status.fingerprint, "the answer carried another fingerprint");
	await delay(3_000);
	const after = reports(second).at(-1) as Report;
	check(after.calls === 2, `the finished turn cost ${after.calls - 2} more model calls`);
	check(after.done.length === 1, `${after.done.length} done records`);
	const transcript = await resolveTranscriptPath(jobOf(after)?.sessionId as string, worktree, join(config, "projects"));
	check(transcript !== undefined, "no transcript for the session");
	const reply = await readLastRecord(transcript as string);
	log("done", { calls: after.calls, decision, done: after.done, job: jobOf(after) });
	log("agent", {
		reply: reply?.text,
		model: await readSessionModel(transcript as string),
		rexErrors: second.lines.filter((line) => line.event === "rex_error"),
	});
	check(reply?.text?.includes("ok") === true, `the agent replied ${JSON.stringify(reply?.text)}`);
	check(jobOf(after)?.outcome === "完成", `the job's outcome is ${jobOf(after)?.outcome}`);
	check(
		jobOf(after)?.resultId === reply?.id,
		`the job recorded reply ${jobOf(after)?.resultId}, transcript ${reply?.id}`,
	);

	// claude keys the trust by the worktree's main checkout, the smoke's fresh repo, as the worktree inherits it. It may
	// not have written the answer when it first reports itself up, so this is read after the turn.
	let inOwnConfig = await trusted(config);
	for (const deadline = Date.now() + 30_000; !inOwnConfig.has(repo) && Date.now() < deadline; await delay(250)) {
		inOwnConfig = await trusted(config);
	}
	check(inOwnConfig.has(repo), `the answer to the dialog did not land in the smoke's own config: ${[...inOwnConfig]}`);
	const gained = [...(await trusted(homedir()))].filter((path) => !trustedBefore.has(path));
	// Other claudes of the human's may gain theirs meanwhile.
	const ours = gained.filter((path) => path.startsWith(directory));
	log("trust", { gained, ours, inOwnConfig: [...inOwnConfig] });
	check(ours.length === 0, `~/.claude.json gained trust for ${JSON.stringify(ours)}`);
	console.log("PASS");
} finally {
	// Each core stops calling the hangar first: one that still did would find it destroyed, as a hangar lost, and make
	// one in its place that nothing removes. A kill is only sent, so its port is gone once the core has exited.
	for (const child of children) child.process.kill("SIGKILL");
	await Promise.all(children.map((child) => child.exited));
	const claudes = await claudesIn(hangar).catch((error: Error) => {
		console.error(`claudes of ${hangar}: ${error.message}`);
		return [];
	});
	await client
		.call("session.destroy", { session_id: hangar }, EmptyResultSchema)
		.catch((error: Error) => console.error(`destroy ${hangar}: ${error.message}`));
	const { sessions } = await client
		.call("session.attach_all", { event_scope: "session" }, AttachAllResultSchema)
		.catch(() => ({ sessions: null }));
	// The tag is this run's alone, so every session of this label is its own: the hangar, or one a port made in its place.
	const ours = (sessions ?? []).filter((session) => session.label === `soma-smoke-${tag}`);
	for (const { session_id: each } of ours) {
		await client
			.call("session.destroy", { session_id: each }, EmptyResultSchema)
			.catch((error: Error) => console.error(`destroy ${each}: ${error.message}`));
	}
	const made = ours.map((session) => session.session_id).filter((each) => each !== hangar);
	if (made.length > 0) {
		console.error(`FAIL: a port made ${made.join(", ")} in place of its hangar as the smoke destroyed it`);
		process.exitCode = 1;
	}
	client.close();
	// A claude that outlives its core by a moment writes its config back, after a removal that came too soon.
	if (!(await ended(claudes, 10_000))) {
		console.error(`the pane's claude outlived its session, and is killed: ${claudes.filter(alive)}`);
		for (const pid of claudes.filter(alive)) process.kill(pid, "SIGTERM");
		await ended(claudes, 5_000);
	}
	await rm(directory, { recursive: true, force: true });
	log("cleanup", { claudes, claudesLeft: claudes.filter(alive), directoryLeft: existsSync(directory) });
}
