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
//   8. at fire time the agent is gone, and resuming it is not built yet, so the deferral must end `gone` with exactly
//      one notice to the human, the instruction must never reach the agent's transcript, the reopened core called no
//      model, and the root conversation holds no input but the dispatch.
// It destroys its rex session and removes the card's worktree and branch at the end, also on failure.
//   node smoke/rex-defer.ts [repo]    (default the current directory, which claude must already trust: a repo it does
//                                      not stops at the trust dialog, which this smoke does not answer)
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { createRexClient, defaultRexSocket } from "../src/adapters/rex/client.ts";
import {
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

const directory = await mkdtemp(join(tmpdir(), "soma-rex-defer-"));
const repo = process.argv[2] ?? process.cwd();
const created = await client.call(
	"session.create",
	{ label: `soma-smoke-${tag}` },
	z.object({ session_id: z.string() }).passthrough(),
);
const hangar = created.session_id;
const env = { ...process.env, SOMA_REX_SESSION_ID: hangar, SOMA_REX_SOCKET: socketPath };
const block = (method: string, blockId: string, args = {}) => ({ session_id: hangar, block_id: blockId, args, method });
const children: Child[] = [];

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
	const { method: processMethod, ...processPayload } = block(`${TERMINAL}.process`, id);
	const { foreground } = await until("claude in the foreground", 60_000, async () => {
		const result = await client.call(processMethod, processPayload, ProcessResultSchema);
		return result.foreground?.argv0 === "claude" ? result : undefined;
	});
	await until("claude's first status record", 60_000, () => root(id)).catch(async (error: Error) => {
		throw new Error(`${error.message}; the screen ends:\n${await screen(id)}`);
	});
	// The core sends the held launch prompt at claude's first idle; the transcript exists once claude takes it.
	const transcript = await until("the launch turn's transcript", 120_000, () =>
		resolveTranscriptPath(job?.sessionId as string, foreground?.cwd),
	);
	const launched = await until("the launch turn to finish", 180_000, () => finished(id, transcript));
	log("dispatched", { job: job?.sessionId, pid: foreground?.pid, launch: launched });

	// claude's own environment, which the shell its Bash tool opens inherits. ps shows it for a non-system binary.
	const shown = spawnSync("ps", ["-Eww", "-p", String(foreground?.pid), "-o", "command="], { encoding: "utf8" }).stdout;
	const variable = (name: string) => new RegExp(`(?:^| )${name}=(\\S+)`).exec(shown)?.[1];
	const agentEnv = {
		SOMA_AGENT: variable("SOMA_AGENT"),
		SOMA_SOCKET: variable("SOMA_SOCKET"),
		SOMA_NODE: variable("SOMA_NODE"),
	};
	check(agentEnv.SOMA_AGENT === card, `claude's SOMA_AGENT is ${agentEnv.SOMA_AGENT}, not ${card}`);
	check(agentEnv.SOMA_SOCKET === started.socket, `claude's SOMA_SOCKET is ${agentEnv.SOMA_SOCKET}`);
	check(shown.includes(` PATH=${BIN}:`), "claude's PATH does not start with soma's bin");
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
	const settled = await second.next("settled");
	check(
		JSON.stringify(settled.outcome) === JSON.stringify({ status: "completed", result: "gone" }),
		`deferral ended ${JSON.stringify(settled.outcome)}`,
	);
	check(Number(settled.at) >= Date.parse(at as string), "the deferral fired early");
	log("fired", { id: settled.id, outcome: settled.outcome, late: Number(settled.at) - Date.parse(at as string) });

	// Long enough for a second notice, had one been written, to show up.
	await delay(10_000);
	check((await named()).length === 0, "the agent's window came back");
	const prompts = await promptedWith(transcript, marker);
	check(prompts === 0, `the stopped agent's transcript holds the instruction ${prompts} times`);
	second.process.kill("SIGTERM");
	const report = await second.next("report");
	check((await second.exited) === 0, "reopened core failed");
	const entries = report.entries as { kind: string; roles: string[] }[];
	const inputs = entries.filter((entry) => entry.roles.includes("user"));
	const notices = report.notices as string[];
	const reclaimed = (report.jobs as Job[]).find((each) => each.card === card);
	check(report.modelCalls === 0, `the reopened core called the model ${report.modelCalls} times`);
	check(inputs.length === 1, `the root conversation holds ${inputs.length} inputs`);
	check(reclaimed?.reclaim?.phase === "stopped", `the job's reclaim is ${JSON.stringify(reclaimed?.reclaim)}`);
	check(!notices.some((notice) => notice.includes("不見了")), `a notice says the agent vanished: ${notices}`);
	check(notices.length === 1, `the human got ${notices.length} notices: ${JSON.stringify(notices)}`);
	check(
		notices[0]?.startsWith(`Deferred instruction ${deferral} `) === true && notices[0].includes("was not sent"),
		`the notice is ${JSON.stringify(notices[0])}`,
	);
	log("agent", { windows: 0, promptedWithInstruction: prompts, reclaim: reclaimed?.reclaim });
	log("root", { modelCallsAfterReopen: report.modelCalls, inputs: inputs.length, notices });
	console.log("PASS");
} finally {
	for (const child of children)
		if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill("SIGKILL");
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
