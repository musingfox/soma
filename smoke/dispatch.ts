// Dispatch crash smoke against the real herdr session at $HERDR_SOCKET_PATH (use a test session, not the fleet):
//   1. the core dispatches a fresh card and is killed with SIGKILL after herdr acked agent.start,
//      before the dispatch list was written;
//   2. a reopened core reruns the dispatch: herdr must still hold one agent of that name, and the
//      dispatch list one job whose session id is the one claude was started with;
//   3. with the core down, the agent is walked through the trust prompt and one prompt to `done`;
//   4. a reopened core reconciles, and the job's status must be herdr's.
// It removes the card's worktree and branch at the end.
//   node smoke/dispatch.ts <repo>
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_BY_AGENT_STATUS } from "../src/adapters/herdr/agent-state.ts";
import { createHerdrClient } from "../src/adapters/herdr/client.ts";
import { PaneProcessInfoResultSchema } from "../src/adapters/herdr/schema.ts";
import type { Job } from "../src/core/domain/dispatch.ts";
import { delay, run } from "./driver.ts";

const CHILD = fileURLToPath(new URL("./dispatch-child.ts", import.meta.url));
const [repo] = process.argv.slice(2);
if (repo === undefined) throw new Error("usage: dispatch.ts <repo>");
const card = `smoke-${Date.now().toString(36)}`;
const herdr = createHerdrClient();
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);
const named = async () => (await herdr.agentList()).filter((agent) => agent.name === card);

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

async function reopen(db: string): Promise<Job> {
	const child = run(["reopen", db], CHILD);
	const jobs = (await child.next("jobs")).jobs as Job[];
	check((await child.exited) === 0, "reopened core failed");
	const mine = jobs.filter((job) => job.card === card);
	check(mine.length === 1 && mine[0] !== undefined, `expected one job for ${card}, got ${JSON.stringify(jobs)}`);
	return mine[0] as Job;
}

const directory = await mkdtemp(join(tmpdir(), "soma-dispatch-"));
try {
	const db = join(directory, "soma.sqlite");
	log("card", card);

	const first = run(["dispatch", db, card, repo], CHILD, { ...process.env, SOMA_SMOKE_HANG_AFTER_START: "1" });
	const started = await first.next("agent_started");
	const listedAtKill = (await named()).length;
	first.process.kill("SIGKILL");
	await first.exited;
	check(first.process.signalCode === "SIGKILL", `first core ended by ${first.process.signalCode}`);
	check(!first.lines.some((line) => line.event === "jobs"), "first core wrote jobs before the kill");
	log("killed", { signal: "SIGKILL", sessionId: started.sessionId, agentsNamedCardAtKill: listedAtKill });

	const recovered = await reopen(db);
	const agents = await named();
	check(agents.length === 1, `herdr holds ${agents.length} agents named ${card}`);
	const pane = (agents[0] as { pane_id: string }).pane_id;
	const { process_info } = await herdr.call("pane.process_info", { pane_id: pane }, PaneProcessInfoResultSchema);
	const argv = (process_info.foreground_processes ?? []).find((process) => process.argv?.[0] === "claude")?.argv ?? [];
	check(recovered.sessionId === started.sessionId, "the rerun recorded another session id");
	check(argv.join(" ").includes(`--session-id ${recovered.sessionId}`), `claude argv ${argv.join(" ")}`);
	log("reopened", { job: recovered, agentsNamedCard: agents.length, argv });

	for (let deadline = Date.now() + 30_000; ; await delay(500)) {
		const status = (await herdr.agentGet(card)).agent_status;
		if (status === "blocked") {
			// Claude Code's folder trust prompt: the cursor starts on "No, exit".
			await herdr.paneSendKeys(pane, ["Down"]);
			await delay(300);
			await herdr.paneSendKeys(pane, ["Enter"]);
			await herdr.agentWait({ target: card, until: ["idle"], timeout_ms: 20_000 });
			break;
		}
		if (status === "idle") break;
		check(Date.now() < deadline, `agent stayed ${status}`);
	}
	await herdr.call("agent.prompt", { target: card, text: "只回覆 ok 兩個字，不要使用任何工具。" });
	await herdr.agentWait({ target: card, until: ["working"], timeout_ms: 20_000 });
	const finished = await herdr.agentWait({ target: card, until: ["done", "idle"], timeout_ms: 120_000 });
	log("changed", { while: "core down", herdr: finished.agent_status });

	const reconciled = await reopen(db);
	check(
		JSON.stringify(reconciled.status) === JSON.stringify(STATE_BY_AGENT_STATUS[finished.agent_status]),
		`job status ${JSON.stringify(reconciled.status)}, herdr ${finished.agent_status}`,
	);
	check(JSON.stringify(reconciled.status) !== JSON.stringify(recovered.status), "status did not change");
	log("reconcile", { before: recovered.status, after: reconciled.status });
	console.log("PASS");
} finally {
	const agent = (await named())[0];
	if (agent !== undefined) await herdr.call("worktree.remove", { workspace_id: agent.workspace_id, force: true });
	spawnSync("git", ["-C", repo, "branch", "-d", `fleet/${card}`], { stdio: "ignore" });
	await rm(directory, { recursive: true, force: true });
}
