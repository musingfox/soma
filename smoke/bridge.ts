// Event-bridge smoke against the real herdr session at $HERDR_SOCKET_PATH (use a test session, not the fleet):
//   1. a core dispatches a fresh card; claude stops at its folder trust prompt, which herdr reports as
//      blocked. The model must be woken exactly once, and stay at once over further snapshots;
//   2. the core is killed with SIGKILL after the wake's run finished, before the job's seq was committed;
//   3. a reopened core sees the same block again: its requestId must make the submit a no-op, with no
//      model call in that process;
//   4. the trust prompt is answered; the reopened core sends the held launch prompt, the agent finishes,
//      and the dispatch list and transcript must record it, with the outcome read off claude's own
//      transcript, and no model call;
//   5. the answer landed for the smoke's repo in the CLAUDE_CONFIG_DIR its claude runs with beside the repo, and
//      ~/.claude.json gained no trust entry for a path of its own (read, never written).
// It runs in a throwaway git repo under ~/.cache (not $TMPDIR, which claude trusts on its own): claude keeps folder
// trust per repo root, so a repo it has seen before shows no trust prompt and nothing blocks. The repo, its config,
// the card's worktree and its agent go at the end, once the agent's claude has ended.
//   node smoke/bridge.ts
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHerdrClient } from "../src/adapters/herdr/client.ts";
import { readSessionModel, resolveTranscriptPath } from "../src/agent-cli/transcript.ts";
import { type Child, delay, run } from "./driver.ts";
import { checkTrust, removeAgents, seedClaudeConfig, trusted } from "./herdr-claude.ts";

const CHILD = fileURLToPath(new URL("./bridge-child.ts", import.meta.url));
const card = `smoke-${Date.now().toString(36)}`;
const herdr = createHerdrClient({ socketPath: process.env.HERDR_SOCKET_PATH });
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

type Job = {
	agent: string;
	seq?: number;
	sessionId: string;
	status: { state: string };
	outcome?: string;
	launchHeld: boolean;
	wake?: string;
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

// realpath, as claude keys its trust by the real path.
const directory = await realpath(await mkdtemp(join(homedir(), ".cache", "soma-bridge-")));
const children: Child[] = [];
try {
	const db = join(directory, "soma.sqlite");
	const repo = join(directory, "repo");
	const config = join(directory, "claude-config");
	const trustedBefore = await trusted(homedir());
	spawnSync("git", ["init", "-q", repo]);
	spawnSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "chore: init"]);
	await seedClaudeConfig(config);
	const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
	log("card", { card, repo });

	const first = run(["run", db, card, repo], CHILD, { ...env, SOMA_SMOKE_HANG_AFTER_WAKE: "1" });
	children.push(first);
	const woke = await first.next("woke");
	check(
		woke.requestId === `agent:${card}:${(await herdr.agentGet(card)).state_change_seq}`,
		"requestId is not herdr's seq",
	);
	// Dispatch is two requests (the tool call, then the answer); the wake is the third.
	check(woke.calls === 3, `expected 3 model calls by the wake, got ${woke.calls}`);
	const settled = reports(first).length;
	await delay(5_000);
	const later = reports(first).slice(settled);
	check(later.length >= 4, `only ${later.length} reports in 5 s`);
	check(
		later.every((report) => report.calls === 3 && report.blocked.length === 1),
		`a repeated snapshot woke the model again: ${JSON.stringify(later.at(-1))}`,
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
	await delay(3_000);
	const quiet = reports(second).at(-1) as Report;
	check(quiet.calls === 0, `the resent block cost ${quiet.calls} model calls`);
	check(quiet.blocked.length === 1, `${quiet.blocked.length} wake entries after the resend`);
	check(jobOf(quiet)?.wake === "done", `the wake submission is ${jobOf(quiet)?.wake}`);
	log("resent", { calls: quiet.calls, wakes: quiet.blocked.length, job: jobOf(resent) });

	const { pane_id: pane, cwd: worktree } = await herdr.agentGet(card);
	const dialog = (await herdr.paneRead({ pane_id: pane, source: "detection" })).text;
	check(dialog.includes("Yes, I trust this folder"), `the pane shows no trust dialog: ${dialog}`);
	log("dialog", dialog.split("\n").filter(Boolean));
	// Claude Code's folder trust prompt: the cursor starts on "No, exit".
	await herdr.paneSendKeys(pane, ["Down"]);
	await delay(300);
	await herdr.paneSendKeys(pane, ["Enter"]);
	const finished = await until(
		second,
		"the finished turn",
		(report) => report.done.length > 0 && jobOf(report)?.launchHeld === false,
		120_000,
	);
	await delay(3_000);
	const after = reports(second).at(-1) as Report;
	check(after.calls === 0, `the finished turn cost ${after.calls} model calls`);
	check(after.done.length === 1, `${after.done.length} done records`);
	check(jobOf(after)?.outcome === "完成", `the job's outcome is ${jobOf(after)?.outcome}`);
	const transcript = await herdr.call("agent.read", { target: card, source: "visible" });
	log("done", {
		calls: after.calls,
		done: after.done,
		job: jobOf(finished),
		herdr: (await herdr.agentGet(card)).agent_status,
	});
	log("agent", JSON.stringify(transcript).includes("ok") ? "replied ok to the launch prompt" : transcript);
	const session = await resolveTranscriptPath(jobOf(after)?.sessionId as string, worktree, join(config, "projects"));
	check(session !== undefined, "no transcript for the session");
	log("model", await readSessionModel(session as string));
	log("trust", await checkTrust(config, repo, homedir(), trustedBefore, [directory, worktree as string]));
	console.log("PASS");
} finally {
	for (const child of children) child.process.kill("SIGKILL");
	const claudes = await removeAgents(herdr, [card]);
	await rm(directory, { recursive: true, force: true });
	log("cleanup", { claudes, directoryLeft: existsSync(directory) });
}
