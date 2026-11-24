// An ACP job handed over to rex while it is busy, against the real rex server, the real claude-agent-acp and real claude,
// on haiku:
//   1. a dedicated rex session, labelled soma-smoke-<random>, is the hangar, and the fixed smoke repo (smoke/smoke-repo.ts)
//      is the card's, its worktree on a branch that adds the settings of step 3. claude trusts that repo already, so the
//      window shows no trust dialog: smoke/acp-handover.ts is what answers one, and this smoke is about the cut;
//   2. the real core, with a faux model standing in for soma's, dispatches the card over ACP and its brief plants a word;
//   3. a second prompt keeps the job busy:
//        working  it runs a long Bash `sleep`, which the repo's settings allow, behind an `echo`, since claude's Bash tool
//                 refuses a command that begins with a long sleep, and the sleep is seen running;
//        blocked  it runs a Bash `touch` that asks permission, and the job is recorded blocked, with the model woken;
//     or, as first-turn, no second prompt: the brief itself runs that sleep before any reply, so the job has finished no turn;
//   4. the model's show_job cuts the turn: the cut comes before the mark, nothing is left under this process and no sleep
//      runs anywhere, one window is open, showing no prompt and running `--resume` on the session, the job is neither
//      working nor blocked, no turn is recorded of what was cut, and the human is told once, the notice saying the turn was
//      cut or quoting the prompt. In `blocked` the model's pending wake is refused, and nothing was touched;
//   5. the model's reply goes into the pane and asks for the word, which is in no prompt since the brief: it comes back, as
//      a turn the bridge records, from the one transcript the session has.
// Up to three prompts run on haiku. It logs where things stood before its cleanup removes them. It destroys its rex session,
// removes the card's worktree and branch, what claude keeps for the worktree under ~/.claude/projects and its db, and kills
// what is left of its own by PID, also on failure. A run that gains a trust entry in ~/.claude.json for any path of its own
// fails; nothing else is read out of that file.
//   node smoke/acp-handover-busy.ts working|blocked|first-turn
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { z } from "zod";
import { createAcpAgentPort } from "../src/adapters/acp/agent-port.ts";
import { createHandoverAgentPort } from "../src/adapters/handover/agent-port.ts";
import { createRexAgentPort } from "../src/adapters/rex/agent-port.ts";
import { createRexClient, defaultRexSocket } from "../src/adapters/rex/client.ts";
import {
	AttachAllResultSchema,
	BlockListSchema,
	EmptyResultSchema,
	ProcessResultSchema,
	TERMINAL,
	ViewSchema,
} from "../src/adapters/rex/schema.ts";
import { projectDirNameFor, readLastRecord, readSessionModel } from "../src/agent-cli/transcript.ts";
import type { Job } from "../src/core/domain/dispatch.ts";
import { eventBridge, handoverBridge, JOB_DONE, reconcileDispatches } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { NOTICE } from "../src/core/notice.ts";
import { delay } from "./driver.ts";
import { branchWithSettings, fixedSmokeRepo } from "./smoke-repo.ts";

const context = BACKGROUND_CONTEXT;
const scenario = process.argv[2];
if (scenario !== "working" && scenario !== "blocked" && scenario !== "first-turn") {
	throw new Error("usage: acp-handover-busy.ts working|blocked|first-turn");
}
const tag = randomBytes(4).toString("hex");
const card = `smoke-${tag}`;
const word = `KUMQUAT-${tag}`;
const label = `soma-smoke-${tag}`;
// Long enough to outlast the run, and a number no other sleep on this machine is likely to have.
const sleepFor = 700 + (Number.parseInt(tag.slice(0, 4), 16) % 299);
const sleepCommand = `sleep ${sleepFor}`;
const touched = `cut-${tag}.txt`;
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
	for (const deadline = Date.now() + ms; ; await delay(250)) {
		const value = await probe();
		if (value !== undefined) return value;
		check(Date.now() < deadline, `timed out waiting for ${what}`);
	}
}

/** Every live process under `pid`, by pid: ps is asked for no command line, and the ps that looks is left out. */
function descendants(pid: number): number[] {
	const listing = spawnSync("ps", ["-A", "-o", "pid=,ppid=,stat="], { encoding: "utf8" });
	const rows = listing.stdout
		.trim()
		.split("\n")
		.map((row) => /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(row))
		.filter((match) => match !== null)
		.map(([, child, parent, stat]) => ({ pid: Number(child), ppid: Number(parent), stat: stat ?? "" }));
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
	// A process that has exited, and waits to be reaped, is in state Z.
	return rows
		.filter((row) => row.pid !== pid && row.pid !== listing.pid && under.has(row.pid) && !row.stat.startsWith("Z"))
		.map((row) => row.pid);
}

/** The pids whose argument list matches `pattern`, an extended regex: pgrep -f prints the pids, and no command line. */
function matching(pattern: string): Set<number> {
	const { status, stdout } = spawnSync("pgrep", ["-f", "--", pattern], { encoding: "utf8" });
	if (status !== 0 && status !== 1) throw new Error(`pgrep -f ${pattern} exited ${status}`);
	return new Set(stdout.split("\n").filter(Boolean).map(Number));
}

const mine = () => descendants(process.pid);

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** The project paths ~/.claude.json marks as trusted; nothing else is read out of it. */
async function trusted(): Promise<Set<string>> {
	const text = await readFile(join(homedir(), ".claude.json"), "utf8");
	const { projects } = JSON.parse(text) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
	return new Set(
		Object.entries(projects ?? {}).flatMap(([path, entry]) => (entry.hasTrustDialogAccepted ? [path] : [])),
	);
}

const onError = (error: Error) => console.error(`[smoke] ${error.message}`);
const client = createRexClient({ socketPath: process.env.SOMA_REX_SOCKET ?? defaultRexSocket(homedir()), onError });
// First of all that can fail, so a repo that cannot be used leaves nothing behind.
const repo = await fixedSmokeRepo(homedir());
const directory = await realpath(await mkdtemp(join(tmpdir(), "soma-acp-handover-busy-")));
const projects = join(homedir(), ".claude", "projects");
const worktree = join(repo, ".claude", "worktrees", card);
const sessionsFile = join(directory, "acp-sessions.json");
const entry = async () =>
	JSON.parse(await readFile(sessionsFile, "utf8"))[card] as {
		acpSessionId: string;
		cwd: string;
		handedOver?: true;
		handingOver?: true;
		model?: string;
	};
let paneClaude: number | undefined;
let acpAgents: () => Promise<void> = async () => {};
let closeRex = () => {};
const sleeps = new Set<number>();
// Where the job stood, for a run that stops: its cleanup removes everything that would have said.
let standing: () => Promise<unknown> = async () => undefined;
let harness: Awaited<ReturnType<typeof openHarness>> | undefined;
// What listens to the agent side's statuses, each one's unsubscribe: the rex port watches its hangar while any listens.
const offs: (() => void)[] = [];
// Last before the `try`, whose `finally` destroys it, so nothing that can fail lies between.
const { session_id: hangar } = await client
	.call("session.create", { label }, z.object({ session_id: z.string() }).passthrough())
	.catch(async (error: Error) => {
		await rm(directory, { recursive: true, force: true });
		throw error;
	});
try {
	await client.attach(hangar);
	// The human's own mode may be auto, under which claude does not ask; here `touch` asks, and `sleep` need not.
	branchWithSettings(repo, card, { permissions: { defaultMode: "default", allow: ["Bash(sleep:*)"] } }, directory);
	const trustedBefore = await trusted();
	log("hangar", { session: hangar, label, card, repo, scenario, word, sleepCommand, touched });

	const bin = join(fileURLToPath(new URL("..", import.meta.url)), "bin");
	const env = { SOMA_SOCKET: join(directory, "defer.sock"), SOMA_NODE: process.execPath };
	// ANTHROPIC_MODEL picks the ACP session's model; the window is told by the --model the handover reads off its reply.
	const acp = createAcpAgentPort({
		env: process.env,
		vars: { ...env, ANTHROPIC_MODEL: "haiku" },
		path: bin,
		sessionsFile,
		onError,
	});
	acpAgents = async () => {
		for (const { name } of await acp.list()) await acp.stop(name);
	};
	// Read as the handover goes: what the cut found and how long it took, and that no mark stood until it was over.
	const order: unknown[] = [];
	const rex = createRexAgentPort({ client, sessionId: hangar, label, onError, env, path: bin, takeMs: 60_000 });
	closeRex = () => rex.close();
	const agents = createHandoverAgentPort({
		from: {
			...acp,
			cut: async (agent) => {
				const started = Date.now();
				const under = mine().length;
				const cut = await acp.cut(agent);
				const { handingOver } = await entry();
				const next = {
					step: "cut",
					cut,
					ms: Date.now() - started,
					processesBefore: under,
					marked: handingOver === true,
				};
				order.push(next);
				log("cut", next);
				return cut;
			},
			release: async (agent, mark) => {
				const { handingOver } = await entry();
				const next = { step: "release", markedBefore: handingOver === true };
				order.push(next);
				const released = await acp.release(agent, mark);
				log("released", { ...next, marked: (await entry()).handingOver === true, under: mine().length });
				return released;
			},
		},
		to: rex,
		onError,
	});
	const offStatus = agents.onStatus((event) => {
		const { state } = event.status;
		log("status", {
			agent: event.agent,
			state,
			seq: event.seq,
			...(state === "blocked" ? { kind: event.status.kind, msg: event.status.msg } : {}),
		});
	});
	offs.push(offStatus);

	const sleeping = `Run this exact command with the Bash tool, in the foreground, with a timeout of 600000 ms, and wait for it: echo started && ${sleepCommand}`;
	// soma's model: dispatches, replies and shows on ask. A wake is left unanswered in `blocked`, with its fingerprint kept
	// for the answer to come, and otherwise answered yes, should claude ask for the sleep after all.
	const results: unknown[] = [];
	let pending: string | undefined;
	const faux = fauxProvider();
	faux.setResponses(
		Array.from({ length: 20 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
			const last = request.messages.at(-1);
			if (last?.role === "toolResult") {
				results.push(JSON.parse((last.content as { text: string }[])[0]?.text ?? "null"));
				return fauxAssistantMessage("好。");
			}
			const text = JSON.stringify(last?.content ?? "");
			const call = (name: string, args: Record<string, string | number>) =>
				fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
			const fingerprint = /fingerprint=([0-9a-f]{16})/.exec(text)?.[1];
			if (fingerprint !== undefined) {
				if (scenario === "blocked") {
					pending = fingerprint;
					return fauxAssistantMessage("好。");
				}
				return call("respond", { card, option: "1", fingerprint, reason: "the smoke allows its own sleep" });
			}
			const reason = "the smoke's own prompt";
			if (text.includes("派工")) return call("dispatch", { card, repo });
			if (text.includes("給我看")) return call("show_job", { card });
			if (text.includes("工作")) return call("jobs", {});
			if (text.includes("舊提示")) {
				return call("respond", {
					card,
					option: "1",
					fingerprint: pending as string,
					reason: "the wake it had pending",
				});
			}
			if (text.includes("忙起來")) {
				const busy = scenario === "blocked" ? `Run this exact command with the Bash tool: touch ${touched}` : sleeping;
				return call("reply", { card, text: busy, reason });
			}
			if (text.includes("回覆")) {
				return call("reply", {
					card,
					text:
						"What was the word I asked you to remember in my first message? Use no tool. Reply with exactly two " +
						"lines: 結果：完成, then that word alone.",
					reason,
				});
			}
			return fauxAssistantMessage("好。");
		}),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const brief =
		scenario === "first-turn"
			? `Remember this word for later: ${word}. Before you write any text: ${sleeping}. End your turn with exactly one line: 結果：完成`
			: `Use no tool. Remember this word for later: ${word}. End your turn with exactly one line: 結果：完成`;
	harness = await openHarness(
		join(directory, "soma.sqlite"),
		[dispatchExtension(agents, async () => `# ${card}\n\n${brief}`, agents)],
		context,
		{ models },
	);
	const open = harness;
	const root = await open.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	open.resume();
	// As main.ts starts them.
	offs.push(handoverBridge(root, agents, context).listen((error) => console.error("[handover]", error)));
	await agents.heard();
	await reconcileDispatches(root, agents, context, await agents.dormant());
	offs.push(eventBridge(root, agents, context).listen((error) => console.error("[bridge]", error)));
	const job = async () =>
		(await open.snapshot(Dispatches, root.id, context))?.jobs.find((each) => each.card === card) as Job | undefined;
	const entries = async (kind: string) =>
		(await root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter((each) => each.kind === kind);
	const say = async (content: string) => {
		const submission = await root.submit({ type: "input", content, requestId: `smoke:${content}` }, context);
		check((await submission.wait(context)).status === "done", `the turn of "${content}" did not finish`);
		await root.waitForIdle(context);
	};
	const blocks = async () =>
		(await client.call("session.list_blocks", { session_id: hangar }, BlockListSchema)).blocks ?? [];
	standing = async () => ({
		entry: await entry().catch((error: Error) => error.message),
		job: await job(),
		result: await agents.readResult(card).catch((error: Error) => error.message),
		notices: (await entries(NOTICE)).map((each) => each.data),
		done: (await entries(JOB_DONE)).map((each) => each.data),
		order,
		processes: mine(),
		windows: ((await client.call("session.view", { session_id: hangar }, ViewSchema)).windows ?? []).map(
			(window) => window.label,
		),
		screen: await agents.readScreen(card).then(
			(text) => text.split("\n").slice(-30),
			(error: Error) => error.message,
		),
	});

	await say("派工");
	if (scenario !== "first-turn") {
		await until("the brief's turn to be recorded", 180_000, async () =>
			(await entries(JOB_DONE)).length > 0 ? true : undefined,
		);
		await root.waitForIdle(context);
	} else await until("the session to open", 60_000, async () => (await entry().catch(() => undefined))?.acpSessionId);
	const { acpSessionId, cwd, model: reported } = await entry();
	log("over acp", {
		job: await job(),
		reply: await agents.readResult(card),
		acpSessionId,
		cwd,
		reported,
		blocksInHangar: (await blocks()).length,
	});
	check(reported === "haiku", `session/new is recorded as having reported ${reported}`);
	check((await blocks()).length === 0, "the hangar holds a block before the handover");

	let asked = "";
	if (scenario !== "first-turn") {
		await say("忙起來");
		check(JSON.stringify(results.at(-1)) === '{"sent":true}', `the second prompt: ${JSON.stringify(results.at(-1))}`);
	}
	if (scenario !== "blocked") {
		const sleepingHere = () => {
			const named = matching(sleepCommand);
			return mine().filter((pid) => named.has(pid));
		};
		await until("the sleep to run", 180_000, async () => {
			const running = sleepingHere();
			for (const pid of running) sleeps.add(pid);
			return running.length > 0 ? running : undefined;
		});
		log("sleeping", { sleeps: [...sleeps], job: (await job())?.status });
		// A shell may stand between the Bash tool and the sleep, started a moment after it.
		await delay(1_000);
		for (const pid of sleepingHere()) sleeps.add(pid);
		check((await job())?.status.state === "working", "the job is not recorded working as the sleep runs");
	} else {
		await until("the job to be recorded blocked", 180_000, async () =>
			(await job())?.status.state === "blocked" ? true : undefined,
		);
		await root.waitForIdle(context);
		await until("the model's wake", 30_000, async () => pending);
		log("asking", { status: (await job())?.status, handedOver: (await job())?.handedOver, pending });
		asked = (await job())?.status.msg?.split("\n")[0] ?? "";
		check(asked !== "", "the prompt says nothing of what it asks");
	}
	const turnsBefore = (await entries(JOB_DONE)).length;
	const outcomeBefore = (await job())?.outcome;
	if (scenario === "first-turn") check(turnsBefore === 0, "the job finished a turn before it was shown");
	const under = mine();
	const transcript = join(projects, projectDirNameFor(cwd), `${acpSessionId}.jsonl`);
	log("before", {
		turnsBefore,
		outcomeBefore,
		named: await readSessionModel(transcript),
		reply: (await readLastRecord(transcript))?.text,
		processes: under,
	});

	const started = Date.now();
	await say("給我看");
	const moved = results.at(-1) as {
		handedOver: boolean;
		window?: string;
		session?: string;
		ready?: boolean;
		cut?: { prompt?: string };
	};
	log("show_job", { result: moved, ms: Date.now() - started });
	check(moved.handedOver === true, `show_job refused: ${JSON.stringify(moved)}`);
	check(moved.ready === true, "claude did not report itself up in the window");
	check(moved.window === card && moved.session === label, "show_job names another window");
	check(moved.cut !== undefined, "show_job does not say what it cut");
	check(
		order.length === 2 &&
			(order[0] as { step: string }).step === "cut" &&
			(order[0] as { marked: boolean }).marked === false,
		`the cut did not come before the mark: ${JSON.stringify(order)}`,
	);

	const left = await until("the ACP processes to end", 20_000, async () => (mine().length === 0 ? [] : undefined));
	for (const deadline = Date.now() + 15_000; [...sleeps].some(alive) && Date.now() < deadline; ) await delay(250);
	const running = [...sleeps].filter(alive);
	const named = [...matching(sleepCommand)];
	log("acp gone", { processesLeft: left.length, sleepsSeen: [...sleeps], sleepsAlive: running, byCommand: named });
	check(running.length === 0, `${running.length} of the sleeps it ran are still alive`);
	check(named.length === 0, `something still runs ${sleepCommand}: ${JSON.stringify(named)}`);
	const final = await entry();
	check(final.handedOver === true && final.handingOver === undefined, "the entry is not marked handed over for good");
	check(!(await acp.list()).some(({ name }) => name === card), "the ACP side still lists the job");

	const inHangar = await blocks();
	const view = await client.call("session.view", { session_id: hangar }, ViewSchema);
	check(inHangar.length === 1, `the hangar holds ${inHangar.length} blocks`);
	const [block] = inHangar;
	const where = { session_id: hangar, block_id: block?.block_id, args: {} };
	const { foreground } = await client.call(`${TERMINAL}.process`, where, ProcessResultSchema);
	paneClaude = foreground?.pid;
	const resumed = foreground != null && matching(`--resume ${acpSessionId}`).has(foreground.pid);
	const onHaiku = foreground != null && matching("--model [^ ]*haiku").has(foreground.pid);
	log("window", {
		windows: (view.windows ?? []).map((window) => window.label),
		blockLabel: block?.label,
		argv0: foreground?.argv0,
		cwd: foreground?.cwd,
		resumed,
		onHaiku,
	});
	check((view.windows ?? []).length === 1 && view.windows?.[0]?.label === card, "the window is not the card's");
	check(block?.label === acpSessionId, `the block is labelled ${block?.label}`);
	check(foreground?.argv0 === "claude", `the pane's foreground is ${foreground?.argv0}`);
	check(resumed, "claude was not started with --resume on the ACP session");
	check(onHaiku, "claude was not started with an explicit haiku model");

	// Past anything of the cut turn or the window's first idle that could still reach the bridge.
	await delay(3_000);
	await root.waitForIdle(context);
	const handed = await job();
	const listed = (await agents.list()).find(({ name }) => name === card);
	const screen = await agents.readScreen(card);
	const notices = await entries(NOTICE);
	const turnsAfter = await entries(JOB_DONE);
	await say("工作");
	const jobs = results.at(-1) as { card: string; status: { state: string } }[];
	log("moved", {
		job: handed,
		listed,
		jobsTool: jobs,
		notices: notices.map((each) => each.data),
		turnsAfter: turnsAfter.length,
		screen: screen.split("\n").slice(-25),
	});
	check(handed?.sessionId === acpSessionId, "the job does not go by the session its window runs");
	check(handed?.handedOver === undefined, "the job still holds the block handed over before the move");
	check(handed?.outcome === outcomeBefore, `the cut turn set the outcome to ${handed?.outcome}`);
	check(handed?.launch === undefined, "the job still holds a brief for the window");
	check(turnsAfter.length === turnsBefore, `${turnsAfter.length - turnsBefore} turns were recorded of the cut turn`);
	check(!/^(working|blocked)$/.test(handed?.status.state ?? ""), `jobs reads ${handed?.status.state} after the move`);
	check(jobs[0]?.status.state === handed?.status.state, "the jobs tool reads another state");
	check(listed?.status?.state === handed?.status.state, "the job does not hold what the window reports");
	check(notices.length === 1, `${notices.length} notices were written`);
	const notice = String((notices[0]?.data as { content?: string } | undefined)?.content);
	check(notice.includes(`its window is ${card} in session ${label}`), "the notice names no window");
	if (scenario !== "blocked") {
		check(notice.includes("Its running turn was cut"), "the notice does not say the turn was cut");
	} else {
		check(notice.includes("was cancelled") && notice.includes(asked), "the notice does not quote the prompt");
		check(!notice.includes("1. Yes"), "the notice quotes the prompt's options");
		check(!/Do you want|❯ 1\./.test(screen), "the window shows a prompt");
		check(listed?.status?.state !== "blocked", "the window reports a prompt");
		await say("舊提示");
		const answered = results.at(-1) as { sent: boolean; refusal?: string };
		log("old wake", answered);
		check(
			answered.sent === false && (answered.refusal === "not_blocked" || answered.refusal === "stale"),
			`the pending wake's answer: ${JSON.stringify(answered)}`,
		);
		check(!existsSync(join(cwd, touched)), "the touch the prompt asked for ran");
	}

	await say("回覆");
	check(JSON.stringify(results.at(-1)) === '{"sent":true}', `reply said ${JSON.stringify(results.at(-1))}`);
	// A turn read before claude flushed it is recorded 未知 and then for real ("Event bridge"), so it is waited for by the
	// word, which is what shows the conversation went on.
	const turns = await until("the reply's turn to be recorded", 180_000, async () => {
		const done = await entries(JOB_DONE);
		return done.length > turnsBefore && (await agents.readResult(card))?.text?.includes(word) ? done : undefined;
	});
	await root.waitForIdle(context);
	const replied = await agents.readResult(card);
	const after = await job();
	log("reply", {
		result: replied,
		done: turns.slice(turnsBefore).map((each) => each.data),
		job: after && { status: after.status, outcome: after.outcome, resultId: after.resultId },
		pane: mine().length,
	});
	check(replied?.text?.includes(word) ?? false, "the reply does not hold the word planted over ACP");
	check(mine().length === 0, "something runs under this process though the job is on rex");

	const files = (await readdir(join(projects, projectDirNameFor(cwd)))).filter((name) => name.endsWith(".jsonl"));
	const last = await readLastRecord(join(projects, projectDirNameFor(cwd), `${acpSessionId}.jsonl`));
	log("transcript", { files, lastId: last?.id, resultId: after?.resultId });
	check(JSON.stringify(files) === JSON.stringify([`${acpSessionId}.jsonl`]), `transcripts ${JSON.stringify(files)}`);

	const gained = [...(await trusted())].filter((path) => !trustedBefore.has(path));
	// Other claudes of the human's may gain theirs meanwhile; none of this smoke's paths may.
	const ours = gained.filter((path) => path.startsWith(directory) || path.startsWith(repo));
	log("trust", { gained, ours });
	check(ours.length === 0, `~/.claude.json gained trust for ${JSON.stringify(ours)}`);
	console.log(`PASS ${scenario}`);
} finally {
	log("at the end", await standing().catch((error: Error) => error.message));
	// The port stops calling its hangar first: one that still did would find it destroyed, as a hangar lost, and make one
	// in its place that nothing removes. Closed, it makes none, and the core, once closed, asks nothing.
	for (const each of offs) each();
	closeRex();
	await harness?.close(context);
	await client
		.call("session.destroy", { session_id: hangar }, EmptyResultSchema)
		.catch((error: Error) => console.error(`destroy ${hangar}: ${error.message}`));
	await acpAgents().catch((error: Error) => console.error(`stop: ${error.message}`));
	// The pane's claude and the sleeps were started for this smoke, so what is left of them is the smoke's to end.
	const pid = paneClaude;
	if (pid !== undefined) {
		for (const deadline = Date.now() + 10_000; alive(pid) && Date.now() < deadline; ) await delay(200);
		if (alive(pid)) {
			console.error(`the pane's claude ${pid} outlived its session, and is killed`);
			process.kill(pid, "SIGTERM");
		}
	}
	for (const each of sleeps) if (alive(each)) process.kill(each, "SIGKILL");
	await delay(1_000);
	const { sessions } = await client
		.call("session.attach_all", { event_scope: "session" }, AttachAllResultSchema)
		.catch(() => ({ sessions: null }));
	// The tag is this run's alone, so every session of this label is its own: the hangar, or one the port made in its place.
	const ours = (sessions ?? []).filter((session) => session.label === label).map((session) => session.session_id);
	for (const each of ours) {
		await client
			.call("session.destroy", { session_id: each }, EmptyResultSchema)
			.catch((error: Error) => console.error(`destroy ${each}: ${error.message}`));
	}
	const made = ours.filter((each) => each !== hangar);
	const remaining = mine();
	for (const each of remaining) process.kill(each);
	log("cleanup", {
		sessionGone: sessions !== null && !ours.includes(hangar),
		madeInPlace: made,
		paneClaudeAlive: pid !== undefined && alive(pid),
		sleepsAlive: [...sleeps].filter(alive),
		processesLeft: remaining,
	});
	if (made.length > 0) {
		console.error(`FAIL: the port made ${made.join(", ")} in place of its hangar as the smoke destroyed it`);
		process.exitCode = 1;
	}
	client.close();
	// What claude keeps for the fixed repo itself is shared with the other smokes, so only the worktree's goes.
	const resolved = existsSync(worktree) ? await realpath(worktree) : worktree;
	await rm(join(projects, projectDirNameFor(resolved)), { recursive: true, force: true });
	if (existsSync(worktree)) {
		spawnSync("git", ["-C", repo, "worktree", "remove", "--force", worktree], { stdio: "inherit" });
	}
	spawnSync("git", ["-C", repo, "branch", "-D", `fleet/${card}`], { stdio: "ignore" });
	await rm(directory, { recursive: true, force: true });
}
