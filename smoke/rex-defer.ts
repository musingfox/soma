// Defer smoke through the rex adapter, against the real rex server and real claude:
//   1. a dedicated rex session, labelled soma-smoke-<random>, is the hangar;
//   2. a core dispatches a card into a trusted repo, and the agent runs its launch prompt;
//   3. claude's environment, which its shell tools inherit, must hold SOMA_AGENT=<card>, the core's socket, and soma's
//      bin first on PATH;
//   4. `soma defer --at PT2M ...` runs from this process with that environment, found through that PATH;
//   5. the agent is idle when the defer is accepted, so the core stops it at once: its window must leave the hangar;
//   6. the core is killed with SIGKILL during the wait and reopened;
//   7. the reopened core must take the stopped agent for reclaimed, not vanished: its job is recorded stopped and no
//      notice says it is gone (不見了);
//   8. at fire time the agent is gone, so the core starts it again with `claude --resume <session id>`: a window of the
//      card's name must reappear in this session, its block labelled with the job's session id, and its claude must
//      carry the environment of step 3, and the deferral must end `sent`;
//   9. the agent's transcript, the same file under the same session id, with no transcript added beside it, must
//      receive the instruction exactly once; no notice says it was not sent or that the agent vanished, the reopened
//      core called no model, the root conversation holds no input but the dispatch, and the job's reclaim is cleared.
// It destroys its rex session and removes the card's worktree and branch at the end, also on failure.
//   node smoke/rex-defer.ts [repo]    (default the fixed smoke repo, smoke/smoke-repo.ts, which claude must trust; any
//                                      other repo must be trusted already, as this smoke answers no dialog)
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { createRexClient, defaultRexSocket } from "../src/adapters/rex/client.ts";
import {
	AttachAllResultSchema,
	EmptyResultSchema,
	FormatResultSchema,
	ProcessResultSchema,
	ProgramStatusResultSchema,
	type StatusRecord,
	TERMINAL,
	ViewSchema,
} from "../src/adapters/rex/schema.ts";
import { readLastRecord, resolveTranscriptPath } from "../src/agent-cli/transcript.ts";
import type { Job } from "../src/core/domain/dispatch.ts";
import { type Child, delay, run } from "./driver.ts";
import { fixedSmokeRepo } from "./smoke-repo.ts";

const CHILD = fileURLToPath(new URL("./rex-defer-child.ts", import.meta.url));
const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), "bin");
const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const card = `smoke-${tag}`;
const marker = `deferred-${tag}`;
const socketPath = process.env.SOMA_REX_SOCKET ?? defaultRexSocket(homedir());
const client = createRexClient({ socketPath, onError: () => {} });
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

const repo = process.argv[2] ?? (await fixedSmokeRepo(homedir()));
const directory = await mkdtemp(join(tmpdir(), "soma-rex-defer-"));
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
const children: Child[] = [];

/** The blocks of the windows named after the card, with their labels. */
async function windows(): Promise<{ id: string; label?: string }[]> {
	const view = await client.call("session.view", { session_id: hangar }, ViewSchema);
	return (view.windows ?? [])
		.filter((window) => window.label === card)
		.flatMap(
			(window) =>
				window.layers?.[0]?.blocks?.map((each) => ({
					id: each.block_id ?? "",
					...(each.label === undefined ? {} : { label: each.label }),
				})) ?? [],
		);
}

const named = async () => (await windows()).map((each) => each.id);

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

/** The bottom of the block's screen, for a failure to show what claude was showing. */
async function screen(blockId: string): Promise<string> {
	const { method, ...payload } = block(`${TERMINAL}.format`, blockId, { format: "text", trim: true, max_bytes: 4096 });
	const { content } = await client.call(method, payload, FormatResultSchema);
	return content.split("\n").slice(-25).join("\n");
}

/** The user records of the transcript that carry `text`: what the agent was prompted with. */
async function promptedWith(transcript: string, text: string): Promise<number> {
	const lines = (await readFile(transcript, "utf8")).split("\n").filter((line) => line.trim() !== "");
	return lines
		.map((line) => JSON.parse(line) as { type?: string; message?: { content?: unknown } })
		.filter((record) => record.type === "user" && JSON.stringify(record.message?.content ?? "").includes(text)).length;
}

/** Whether claude is at rest after a turn whose reply is written. */
const finished = async (blockId: string, transcript: string) => {
	const record = await root(blockId);
	if (record?.state !== "done" && record?.state !== "idle") return undefined;
	const last = await readLastRecord(transcript);
	return last?.text === undefined ? undefined : { state: record.state, reply: last.text };
};

/** The block's process once claude is in its foreground. */
const claudeIn = (blockId: string) => {
	const { method, ...payload } = block(`${TERMINAL}.process`, blockId);
	return until("claude in the foreground", 60_000, async () => {
		const result = await client.call(method, payload, ProcessResultSchema);
		return result.foreground?.argv0 === "claude" ? result : undefined;
	});
};

/** The soma variables of claude's own environment, which its shell tools inherit; ps shows it for a non-system binary. */
function environment(pid: number | undefined) {
	const shown = spawnSync("ps", ["-Eww", "-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout;
	const variable = (name: string) => new RegExp(`(?:^| )${name}=(\\S+)`).exec(shown)?.[1];
	return {
		SOMA_AGENT: variable("SOMA_AGENT"),
		SOMA_SOCKET: variable("SOMA_SOCKET"),
		SOMA_NODE: variable("SOMA_NODE"),
		pathFirst: shown.includes(` PATH=${BIN}:`),
	};
}

/** The transcripts beside `transcript`: a resume that forked the session would add one. */
const transcripts = async (transcript: string) =>
	(await readdir(dirname(transcript))).filter((name) => name.endsWith(".jsonl")).sort();

try {
	await client.attach(hangar);
	const db = join(directory, "soma.sqlite");
	log("hangar", { session: hangar, label: `soma-smoke-${tag}`, card, repo });

	const first = run(["dispatch", db, card, repo], CHILD, env);
	children.push(first);
	const started = await first.next("started");
	const dispatched = await first.next("dispatched");
	const job = (dispatched.jobs as Job[]).find((each) => each.card === card);
	check(job !== undefined, `no job for ${card}: ${JSON.stringify(dispatched.jobs)}`);
	const [blockId] = await named();
	check(blockId !== undefined, "no window for the card");
	const id = blockId as string;
	const { foreground } = await claudeIn(id);
	await until("claude's first status record", 60_000, () => root(id)).catch(async (error: Error) => {
		throw new Error(`${error.message}; the screen ends:\n${await screen(id)}`);
	});
	// The core sends the held launch prompt at claude's first idle; the transcript exists once claude takes it.
	const transcript = await until("the launch turn's transcript", 120_000, () =>
		resolveTranscriptPath(job?.sessionId as string, foreground?.cwd),
	);
	const launched = await until("the launch turn to finish", 180_000, () => finished(id, transcript));
	log("dispatched", { job: job?.sessionId, pid: foreground?.pid, launch: launched });

	// claude's own environment, which the shell its Bash tool opens inherits.
	const { pathFirst, ...agentEnv } = environment(foreground?.pid);
	check(agentEnv.SOMA_AGENT === card, `claude's SOMA_AGENT is ${agentEnv.SOMA_AGENT}, not ${card}`);
	check(agentEnv.SOMA_SOCKET === started.socket, `claude's SOMA_SOCKET is ${agentEnv.SOMA_SOCKET}`);
	check(pathFirst, "claude's PATH does not start with soma's bin");
	log("agent env", { ...agentEnv, pathStartsWith: BIN });

	// Run as the agent's shell would: its variables, and `soma` found through the PATH soma gave it.
	const instruction = `Reply with exactly one word: ${marker}. Use no tools.`;
	const asked = await promisify(execFile)("soma", ["defer", "--at", "PT2M", instruction], {
		encoding: "utf8",
		env: { ...process.env, ...agentEnv, PATH: `${BIN}:${process.env.PATH}` },
	});
	const accepted = /accepted as (\d+); .* at (\S+)\. /.exec(asked.stdout);
	check(accepted !== null, `soma defer printed ${JSON.stringify(asked)}`);
	const [, deferral, at] = accepted as RegExpExecArray;
	log("deferred", { stdout: asked.stdout.trim(), stderr: asked.stderr });

	// The launch turn is over, so the agent is idle at the defer and is stopped at once, through block.close.
	await until("the agent's window to leave the hangar", 30_000, async () =>
		(await named()).length === 0 ? true : undefined,
	).catch(async (error: Error) => {
		throw new Error(`${error.message}; the screen ends:\n${await screen(id).catch(() => "(unreadable)")}`);
	});
	log("reclaimed", { windows: await named(), at: new Date().toISOString() });

	const file = { ino: (await stat(transcript)).ino, beside: await transcripts(transcript) };
	await delay(10_000);
	first.process.kill("SIGKILL");
	await first.exited;
	check(first.process.signalCode === "SIGKILL", `first core ended by ${first.process.signalCode}`);
	check(Date.now() < Date.parse(at as string), "killed after the deferral fell due; the wait was not exercised");
	check((await promptedWith(transcript, marker)) === 0, "the instruction reached the agent before it fell due");
	log("killed", { signal: "SIGKILL", at: new Date().toISOString(), due: at });

	const second = run(["reopen", db], CHILD, env);
	children.push(second);
	const reopened = await second.next("started");
	check(JSON.stringify(reopened.pending) === JSON.stringify([deferral]), `pending after reopen: ${reopened.pending}`);
	const waiting = (reopened.jobs as Job[]).find((each) => each.card === card);
	check(waiting?.reclaim?.phase === "stopped", `after reopen the job's reclaim is ${JSON.stringify(waiting?.reclaim)}`);
	const settled = await second.next("settled");
	check(
		JSON.stringify(settled.outcome) === JSON.stringify({ status: "completed", result: "sent" }),
		`deferral ended ${JSON.stringify(settled.outcome)}`,
	);
	check(Number(settled.at) >= Date.parse(at as string), "the deferral fired early");
	log("fired", { id: settled.id, outcome: settled.outcome, late: Number(settled.at) - Date.parse(at as string) });

	// Started again with `claude --resume`, in a window of the card's name whose block keeps the session id.
	const back = await windows();
	check(back.length === 1, `the hangar has ${back.length} windows named ${card}`);
	const [resumed] = back as [{ id: string; label?: string }];
	check(resumed.label === job?.sessionId, `the resumed block is labelled ${resumed.label}, not ${job?.sessionId}`);
	const { foreground: again } = await claudeIn(resumed.id);
	const { pathFirst: resumedPathFirst, ...resumedEnv } = environment(again?.pid);
	check(resumedEnv.SOMA_AGENT === card, `the resumed claude's SOMA_AGENT is ${resumedEnv.SOMA_AGENT}`);
	check(resumedEnv.SOMA_SOCKET === reopened.socket, `the resumed claude's SOMA_SOCKET is ${resumedEnv.SOMA_SOCKET}`);
	check(resumedEnv.SOMA_NODE !== undefined, "the resumed claude has no SOMA_NODE");
	check(resumedPathFirst, "the resumed claude's PATH does not start with soma's bin");
	log("resumed", { block: resumed, pid: again?.pid, cwd: again?.cwd, ...resumedEnv });

	// The instruction is the next turn of the same conversation, in the same file.
	const turn = await until("the deferred turn to finish", 180_000, async () =>
		(await promptedWith(transcript, marker)) === 0 ? undefined : finished(resumed.id, transcript),
	).catch(async (error: Error) => {
		throw new Error(`${error.message}; the screen ends:\n${await screen(resumed.id).catch(() => "(unreadable)")}`);
	});
	check(
		(await resolveTranscriptPath(job?.sessionId as string, again?.cwd)) === transcript,
		"the session's transcript moved",
	);
	check((await stat(transcript)).ino === file.ino, "the session's transcript is a new file");
	const beside = await transcripts(transcript);
	check(JSON.stringify(beside) === JSON.stringify(file.beside), `the transcripts beside it are ${beside}`);
	log("deferred turn", turn);

	// Long enough for a second prompt or notice, had one been written, to show up.
	await delay(10_000);
	check((await named()).length === 1, "the resumed agent's window is gone or doubled");
	const prompts = await promptedWith(transcript, marker);
	check(prompts === 1, `the agent's transcript holds the instruction ${prompts} times`);
	second.process.kill("SIGTERM");
	const report = await second.next("report");
	check((await second.exited) === 0, "reopened core failed");
	const entries = report.entries as { kind: string; roles: string[] }[];
	const inputs = entries.filter((entry) => entry.roles.includes("user"));
	const notices = report.notices as string[];
	const resumedJob = (report.jobs as Job[]).find((each) => each.card === card);
	check(report.modelCalls === 0, `the reopened core called the model ${report.modelCalls} times`);
	check(inputs.length === 1, `the root conversation holds ${inputs.length} inputs`);
	check(resumedJob?.sessionId === job?.sessionId, `the job's session is now ${resumedJob?.sessionId}`);
	check(resumedJob?.reclaim === undefined, `the job's reclaim is ${JSON.stringify(resumedJob?.reclaim)}`);
	check(!notices.some((notice) => notice.includes("不見了")), `a notice says the agent vanished: ${notices}`);
	check(
		!notices.some((notice) => notice.includes(`Deferred instruction ${deferral} `) || notice.includes("not sent")),
		`a notice says the instruction was not sent: ${JSON.stringify(notices)}`,
	);
	log("agent", { windows: 1, promptedWithInstruction: prompts, status: resumedJob?.status });
	log("root", { modelCallsAfterReopen: report.modelCalls, inputs: inputs.length, notices });
	console.log("PASS");
} finally {
	// Each core stops calling the hangar first: one that still did would find it destroyed, as a hangar lost, and make
	// one in its place that nothing removes. A kill is only sent, so its port is gone once the core has exited.
	for (const child of children)
		if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill("SIGKILL");
	await Promise.all(children.map((child) => child.exited));
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
	const worktree = join(repo, ".claude/worktrees", card);
	if (existsSync(worktree))
		spawnSync("git", ["-C", repo, "worktree", "remove", "--force", worktree], { stdio: "inherit" });
	spawnSync("git", ["-C", repo, "branch", "-D", `fleet/${card}`], { stdio: "ignore" });
	await rm(directory, { recursive: true, force: true });
}
