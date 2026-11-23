// Dispatch crash smoke through the rex adapter, against the real rex server and real claude:
//   1. a dedicated rex session, labelled soma-smoke-<random>, is the hangar;
//   2. a core dispatches a fresh card into a trusted repo and is killed with SIGKILL after the adapter's start
//      returned, before the dispatch list was written;
//   3. a reopened core reruns the dispatch: the hangar must still hold one window of that name, and the dispatch list
//      one job whose session id is the one claude was started with;
//   4. with the core down, the agent is sent one prompt through the rex API and runs it to done or idle;
//   5. a reopened core reconciles: the job's status must be rex's, and the finished turn is recorded once, with the
//      outcome read off claude's transcript.
// It destroys its rex session and removes the card's worktree and branch at the end, also on failure.
//   node smoke/rex-dispatch.ts [repo]    (default the fixed smoke repo, smoke/smoke-repo.ts, which claude must trust;
//                                         any other repo must be trusted already, as this smoke answers no dialog)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { seqOf, stateOf } from "../src/adapters/rex/agent-port.ts";
import { createRexClient, defaultRexSocket } from "../src/adapters/rex/client.ts";
import {
	EmptyResultSchema,
	ProcessResultSchema,
	ProgramStatusResultSchema,
	type StatusRecord,
	TERMINAL,
	ViewSchema,
} from "../src/adapters/rex/schema.ts";
import { readLastRecord, resolveTranscriptPath } from "../src/agent-cli/transcript.ts";
import type { Job } from "../src/core/domain/dispatch.ts";
import { outcomeOf } from "../src/core/domain/report.ts";
import { delay, run } from "./driver.ts";
import { fixedSmokeRepo } from "./smoke-repo.ts";

const CHILD = fileURLToPath(new URL("./rex-dispatch-child.ts", import.meta.url));
const repo = process.argv[2] ?? (await fixedSmokeRepo(homedir()));
const tag = Date.now().toString(36);
const card = `smoke-${tag}`;
const socketPath = process.env.SOMA_REX_SOCKET ?? defaultRexSocket(homedir());
const client = createRexClient({ socketPath, onError: () => {} });
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

const created = await client.call(
	"session.create",
	{ label: `soma-smoke-${tag}` },
	z.object({ session_id: z.string() }).passthrough(),
);
const hangar = created.session_id;
const env = {
	...process.env,
	SOMA_REX_SESSION_ID: hangar,
	SOMA_REX_LABEL: `soma-smoke-${tag}`,
	SOMA_REX_SOCKET: socketPath,
};
const block = (method: string, blockId: string, args = {}) => ({ session_id: hangar, block_id: blockId, args, method });

async function named(): Promise<string[]> {
	const view = await client.call("session.view", { session_id: hangar }, ViewSchema);
	return (view.windows ?? [])
		.filter((window) => window.label === card)
		.flatMap((window) => window.layers?.[0]?.blocks?.map((each) => each.block_id ?? "") ?? []);
}

async function root(blockId: string): Promise<StatusRecord | undefined> {
	const { method, ...payload } = block(`${TERMINAL}.program_status`, blockId);
	const { records } = await client.call(method, payload, ProgramStatusResultSchema);
	return records.find((record) => record.id === undefined || record.id === "");
}

async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
	for (const deadline = Date.now() + ms; ; await delay(500)) {
		const value = await probe();
		if (value !== undefined) return value;
		check(Date.now() < deadline, `timed out waiting for ${what}`);
	}
}

async function reopen(db: string): Promise<{ job: Job; done: Record<string, unknown>[] }> {
	const child = run(["reopen", db], CHILD, env);
	const line = await child.next("jobs");
	check((await child.exited) === 0, "reopened core failed");
	const mine = (line.jobs as Job[]).filter((job) => job.card === card);
	check(mine.length === 1 && mine[0] !== undefined, `expected one job for ${card}, got ${JSON.stringify(line.jobs)}`);
	const done = (line.done as Record<string, unknown>[]).filter((entry) => entry.card === card);
	return { job: mine[0] as Job, done };
}

const directory = await mkdtemp(join(tmpdir(), "soma-rex-dispatch-"));
try {
	await client.attach(hangar);
	const db = join(directory, "soma.sqlite");
	log("hangar", { session: hangar, label: `soma-smoke-${tag}`, card, repo });

	const first = run(["dispatch", db, card, repo], CHILD, { ...env, SOMA_SMOKE_HANG_AFTER_START: "1" });
	const started = await first.next("agent_started");
	const windowsAtKill = (await named()).length;
	first.process.kill("SIGKILL");
	await first.exited;
	check(first.process.signalCode === "SIGKILL", `first core ended by ${first.process.signalCode}`);
	check(!first.lines.some((line) => line.event === "jobs"), "first core wrote jobs before the kill");
	log("killed", { signal: "SIGKILL", sessionId: started.sessionId, windowsNamedCardAtKill: windowsAtKill });

	// claude comes up while the core is down; its first record is what lets a core hand it the launch prompt.
	const [blockId] = await named();
	check(blockId !== undefined, "no window for the card");
	const ready = await until("claude's first status record", 60_000, () => root(blockId as string));
	log("claude", { state: ready.state, app: ready.app });

	const recovered = await reopen(db);
	const blocks = await named();
	check(blocks.length === 1, `the hangar holds ${blocks.length} windows named ${card}`);
	const { method: processMethod, ...processPayload } = block(`${TERMINAL}.process`, blockId as string);
	const { foreground } = await client.call(processMethod, processPayload, ProcessResultSchema);
	check(foreground?.argv0 === "claude", `foreground is ${foreground?.argv0}`);
	// claude's own record of the session it runs, keyed by its pid; read only for its sessionId.
	const own = JSON.parse(await readFile(join(homedir(), ".claude/sessions", `${foreground?.pid}.json`), "utf8"));
	check(recovered.job.sessionId === started.sessionId, "the rerun recorded another session id");
	check(own.sessionId === recovered.job.sessionId, `claude runs session ${own.sessionId}`);
	log("reopened", {
		job: recovered.job,
		windowsNamedCard: blocks.length,
		argv0: foreground?.argv0,
		claudeSessionId: own.sessionId,
	});

	// The reopened core sent the held launch prompt; let that turn finish before the smoke's own prompt.
	await until("the launch turn to finish", 180_000, async () => {
		const record = await root(blockId as string);
		return record && (record.state === "done" || record.state === "idle") ? record : undefined;
	});
	const before = seqOf((await root(blockId as string)) as StatusRecord) ?? 0;
	const { method: paste, ...pastePayload } = block("block.event", blockId as string);
	await client.call(
		paste,
		{ ...pastePayload, event: { type: "paste", payload: { text: "Reply with exactly one word: ok. Use no tools." } } },
		EmptyResultSchema,
	);
	const { method: write, ...writePayload } = block(`${TERMINAL}.write`, blockId as string, { data: "\r" });
	const enter = () => client.call(write, writePayload, z.object({ bytes_written: z.number() }).passthrough());
	await enter();
	const turned = await until("the prompt to start", 10_000, async () => {
		const record = await root(blockId as string);
		return record && record.state === "working" ? record : undefined;
	}).catch(async () => {
		await enter();
		return undefined;
	});
	const finished = await until("the prompt's turn to finish", 180_000, async () => {
		const record = await root(blockId as string);
		const seq = record && seqOf(record);
		return record && seq !== undefined && seq > before && (record.state === "done" || record.state === "idle")
			? record
			: undefined;
	});
	log("changed", { while: "core down", sawWorking: turned !== undefined, rex: finished.state });

	const reconciled = await reopen(db);
	const now = (await root(blockId as string)) as StatusRecord;
	check(
		JSON.stringify(reconciled.job.status) === JSON.stringify(stateOf(now)),
		`job status ${JSON.stringify(reconciled.job.status)}, rex ${JSON.stringify(stateOf(now))}`,
	);
	const transcript = await resolveTranscriptPath(started.sessionId as string, foreground?.cwd);
	check(transcript !== undefined, "no transcript for the session");
	const reply = await readLastRecord(transcript as string);
	check(reply !== undefined, "the transcript holds no reply");
	check(reconciled.done.length === 1, `${reconciled.done.length} finished turns recorded`);
	check(
		reconciled.job.resultId === reply?.id,
		`job recorded reply ${reconciled.job.resultId}, transcript ${reply?.id}`,
	);
	check(reconciled.done[0]?.outcome === outcomeOf(reply?.text), `outcome ${reconciled.done[0]?.outcome}`);
	log("reconcile", {
		before: recovered.job.status,
		after: reconciled.job.status,
		rex: now.state,
		done: reconciled.done,
		reply: reply?.text,
	});

	const again = await reopen(db);
	check(again.done.length === 1, `${again.done.length} finished turns recorded after another restart`);
	log("again", { done: again.done.length });
	console.log("PASS");
} finally {
	await client
		.call("session.destroy", { session_id: hangar }, EmptyResultSchema)
		.catch((error: Error) => console.error(`destroy ${hangar}: ${error.message}`));
	client.close();
	const worktree = join(repo, ".claude/worktrees", card);
	if (existsSync(worktree))
		spawnSync("git", ["-C", repo, "worktree", "remove", "--force", worktree], { stdio: "inherit" });
	spawnSync("git", ["-C", repo, "branch", "-D", `fleet/${card}`], { stdio: "ignore" });
	await rm(directory, { recursive: true, force: true });
}
