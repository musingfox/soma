// The ACP job handed over to rex, against the real rex server, the real claude-agent-acp and real claude, on haiku:
//   1. a dedicated rex session, labelled soma-smoke-<random>, is the hangar, and a fresh git repo, which claude has not
//      been told to trust, is the card's;
//   2. the real core, with a faux model standing in for soma's, dispatches the card over ACP and its brief plants a
//      word: the hangar stays empty, and the agent is claude-agent-acp under this process;
//   3. the model's show_job hands the job over: nothing runs under this process any more, one window is open, labelled
//      with the ACP session id, whose claude runs `--resume` on that session with an explicit model in the worktree's
//      realpath, past a real trust dialog that take answered and nobody pressed by hand, and the human is told once;
//   4. the model's reply goes into the pane and asks for the word, which is in no prompt since the brief: the turn is
//      recorded by the event bridge, readResult reads the word back from the one transcript, and screen shows the pane;
//   5. the session is destroyed, and neither the pane's claude nor anything under this process is left.
// Two prompts run on haiku. Both claudes run with one CLAUDE_CONFIG_DIR beside the repo, as the pane's --resume has to
// find the transcript written over ACP, so the dialog is asked and its answer lands there: a run with no dialog, or one
// that gains a trust entry in ~/.claude.json for a path of its own, fails. It removes its rex session, and its repo,
// config and db, at the end, also on failure. Only the trusted paths are read out of either .claude.json.
//   node smoke/acp-handover.ts
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
	FormatResultSchema,
	ProcessResultSchema,
	ProgramStatusResultSchema,
	TERMINAL,
	ViewSchema,
} from "../src/adapters/rex/schema.ts";
import { isTrustDialog, readBlockedScreen } from "../src/agent-cli/permission/blocked-screen.ts";
import { projectDirNameFor, readLastRecord, readSessionModel } from "../src/agent-cli/transcript.ts";
import { runGit } from "../src/agent-cli/worktree.ts";
import type { Job } from "../src/core/domain/dispatch.ts";
import { eventBridge, JOB_DONE } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { NOTICE } from "../src/core/notice.ts";
import type { AgentStatusEvent } from "../src/ports/agent.ts";
import { delay } from "./driver.ts";

const context = BACKGROUND_CONTEXT;
const tag = Date.now().toString(36);
const card = `smoke-${tag}`;
const word = `KUMQUAT-${tag}`;
const label = `soma-smoke-${tag}`;
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
	// ps shows a process that has exited, and waits to be reaped, by its name in parentheses; the ps that looks is its own.
	return rows.filter((row) => row.pid !== pid && under.has(row.pid) && !/^\(|^ps -A/.test(row.command));
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

/** The project paths the `.claude.json` in `directory` marks as trusted; nothing else is read out of it. */
async function trusted(directory: string): Promise<Set<string>> {
	const text = await readFile(join(directory, ".claude.json"), "utf8");
	const { projects } = JSON.parse(text) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
	return new Set(
		Object.entries(projects ?? {}).flatMap(([path, entry]) => (entry.hasTrustDialogAccepted ? [path] : [])),
	);
}

const socketPath = process.env.SOMA_REX_SOCKET ?? defaultRexSocket(homedir());
const onError = (error: Error) => console.error(`[smoke] ${error.message}`);
const client = createRexClient({ socketPath, onError });
// Every key pressed in a pane, read off the client the adapter calls rex through: what a trust dialog was answered with.
const pressed: string[] = [];
// The screen the first key was pressed on, read just before it: once it lands, the dialog is gone.
let answered: string | undefined;
const { call: callRex } = client;
client.call = async (method, payload, schema, options) => {
	const { event, session_id, block_id } = payload as {
		event?: { type: string; payload: { key: string; action: string } };
		session_id?: string;
		block_id?: string;
	};
	if (method === "block.event" && event?.type === "key" && event.payload.action === "press") {
		if (pressed.length === 0) {
			const args = { format: "text", trim: true, max_bytes: 65_536 };
			const screen = await callRex(`${TERMINAL}.format`, { session_id, block_id, args }, FormatResultSchema);
			answered = screen.content;
		}
		pressed.push(event.payload.key);
	}
	return callRex(method, payload, schema, options);
};
const created = await client.call("session.create", { label }, z.object({ session_id: z.string() }).passthrough());
const hangar = created.session_id;

const directory = await realpath(await mkdtemp(join(tmpdir(), "soma-acp-handover-")));
const repo = join(directory, "repo");
const config = join(directory, "claude-config");
const projects = join(config, "projects");
const sessionsDir = join(config, "sessions");
const worktree = join(repo, ".claude", "worktrees", card);
const sessionsFile = join(directory, "acp-sessions.json");
const git = (...args: string[]) => runGit(repo, args);
const identity = ["-c", "user.name=soma smoke", "-c", "user.email=smoke@example.com", "-c", "commit.gpgsign=false"];
let paneClaude: number | undefined;
let acpAgents: () => Promise<void> = async () => {};
// Where the job stood, for a run that stops: its cleanup removes the transcript that would have said.
let standing: () => Promise<unknown> = async () => undefined;
let harness: Awaited<ReturnType<typeof openHarness>> | undefined;
let off = () => {};
try {
	await runGit(directory, ["init", "-q", "-b", "main", repo]);
	await writeFile(join(repo, "README.md"), `# acp handover smoke ${tag}\n`);
	await mkdir(join(repo, ".claude"));
	// The human's own mode may be auto, under which claude does not ask; here a tool call would ask, and the faux model
	// answers yes, in either runtime.
	await writeFile(
		join(repo, ".claude", "settings.json"),
		`${JSON.stringify({ permissions: { defaultMode: "default" } })}\n`,
	);
	await git("add", "README.md", ".claude/settings.json");
	await git(...identity, "commit", "-q", "--no-verify", "-m", "chore: init");
	// Past the first-run screens, which come before the dialog; there is nothing else in this config to start with.
	await mkdir(config);
	await writeFile(join(config, ".claude.json"), `${JSON.stringify({ hasCompletedOnboarding: true })}\n`);
	const trustedBefore = await trusted(homedir());
	log("hangar", { session: hangar, label, card, repo });

	const bin = join(fileURLToPath(new URL("..", import.meta.url)), "bin");
	const env = {
		SOMA_SOCKET: join(directory, "defer.sock"),
		SOMA_NODE: process.execPath,
		CLAUDE_CONFIG_DIR: config,
		// claude names its login's Keychain item after a CLAUDE_CONFIG_DIR, which would leave this config with no login.
		// Empty, this keeps the usual name; the smoke handles no credential.
		CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
	};
	// ANTHROPIC_MODEL picks the ACP session's model; the window is told by the --model the handover reads off its reply.
	const acp = createAcpAgentPort({
		env: process.env,
		vars: { ...env, ANTHROPIC_MODEL: "haiku" },
		path: bin,
		sessionsFile,
		projectsDir: projects,
		onError,
	});
	acpAgents = async () => {
		for (const { name } of await acp.list()) await acp.stop(name);
	};
	const rex = createRexAgentPort({
		client,
		sessionId: hangar,
		onError,
		env,
		path: bin,
		projectsDir: projects,
		sessionsDir,
		takeMs: 60_000,
	});
	const agents = createHandoverAgentPort({ from: acp, to: rex });
	const statuses: AgentStatusEvent[] = [];
	agents.onStatus((event) => {
		statuses.push(event);
		const { state } = event.status;
		log("status", { agent: event.agent, state, ...(state === "blocked" ? { kind: event.status.kind } : {}) });
	});

	// soma's model: dispatches, shows, replies and reads the screen on ask, and says yes to a prompt it is woken for.
	const results: unknown[] = [];
	let responses = 0;
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
				responses++;
				return call("respond", { card, option: "1", fingerprint, reason: "the smoke approves its own agent" });
			}
			if (text.includes("派工")) return call("dispatch", { card, repo });
			if (text.includes("給我看")) return call("show_job", { card });
			if (text.includes("畫面")) return call("screen", { card, lines: 40 });
			if (text.includes("回覆")) {
				return call("reply", {
					card,
					text: "Use no tool. Reply with exactly two lines: 結果：完成, then the word I asked you to remember.",
					reason: "the smoke's second prompt",
				});
			}
			return fauxAssistantMessage("好。");
		}),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const brief = `Use no tool. Remember this word for later: ${word}. End your turn with exactly one line: 結果：完成`;
	harness = await openHarness(
		join(directory, "soma.sqlite"),
		[dispatchExtension(agents, async () => `# ${card}\n\n${brief}`, agents)],
		context,
		{ models },
	);
	const open = harness;
	const root = await open.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	open.resume();
	off = eventBridge(root, agents, context).listen((error) => console.error("[bridge]", error));
	const job = async () =>
		(await open.snapshot(Dispatches, root.id, context))?.jobs.find((each) => each.card === card) as Job | undefined;
	const entries = async (kind: string) =>
		(await root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter((entry) => entry.kind === kind);
	const say = async (content: string) => {
		const submission = await root.submit({ type: "input", content, requestId: `smoke:${content}` }, context);
		check((await submission.wait(context)).status === "done", `the turn of "${content}" did not finish`);
		await root.waitForIdle(context);
	};
	standing = async () => ({ job: await job(), result: await agents.readResult(card) });
	const blocks = async () =>
		(await client.call("session.list_blocks", { session_id: hangar }, BlockListSchema)).blocks ?? [];

	await say("派工");
	// Whatever its first line says: the outcome is read off the model's wording, and what is under test is the handover.
	await until("the brief's turn to be recorded", 180_000, async () =>
		(await entries(JOB_DONE)).length > 0 ? true : undefined,
	);
	await root.waitForIdle(context);
	const onAcp = await job();
	const { acpSessionId, cwd } = JSON.parse(await readFile(sessionsFile, "utf8"))[card] as {
		acpSessionId: string;
		cwd: string;
	};
	const children = mine();
	log("over acp", {
		job: onAcp && { sessionId: onAcp.sessionId, status: onAcp.status, outcome: onAcp.outcome },
		reply: await agents.readResult(card),
		acpSessionId,
		cwd,
		processes: children.map(({ pid, command }) => ({ pid, command: command.slice(0, 160) })),
		blocksInHangar: (await blocks()).length,
		model: await readSessionModel(join(projects, projectDirNameFor(cwd), `${acpSessionId}.jsonl`)),
	});
	check(cwd === (await realpath(worktree)), `the session's cwd is ${cwd}`);
	check(
		children.some(({ command }) => command.includes("claude-agent-acp")),
		"no claude-agent-acp runs under this process",
	);
	// A job not handed over has nothing on rex: no block of it in the hangar, none of its status on the bridge from rex.
	check((await blocks()).length === 0, "the hangar holds a block before the handover");
	check(acpSessionId !== onAcp?.sessionId, "the job already goes by the ACP session id");

	const started = Date.now();
	const responsesBefore = responses;
	await say("給我看");
	const moved = results.at(-1) as { handedOver: boolean; window?: string; session?: string; ready?: boolean };
	log("show_job", { result: moved, ms: Date.now() - started, keysPressed: pressed });
	log("dialog", answered?.split("\n"));
	check(moved.handedOver === true, `show_job refused: ${JSON.stringify(moved)}`);
	// What explains it, read now: the cleanup below removes the pane and everything else that would.
	if (moved.ready === false) {
		const [pane] = await blocks();
		const where = { session_id: hangar, block_id: pane?.block_id, args: {} };
		const { foreground } = await client.call(`${TERMINAL}.process`, where, ProcessResultSchema);
		paneClaude = foreground?.pid;
		log("not ready", {
			keysPressed: pressed,
			foreground: foreground?.argv0,
			records: (await client.call(`${TERMINAL}.program_status`, where, ProgramStatusResultSchema)).records,
			screen: (await agents.readScreen(card)).split("\n").slice(-40),
		});
	}
	check(moved.ready === true, "claude did not report itself up in the window");
	check(moved.window === card && moved.session === label, "show_job names another window");

	// The ACP side is gone: the session closed, its process and everything under it ended, and its entry marked.
	const left = await until("the ACP processes to end", 15_000, async () => (mine().length === 0 ? [] : undefined));
	const entry = JSON.parse(await readFile(sessionsFile, "utf8"))[card] as { handedOver?: boolean };
	log("acp gone", { processesLeft: left.length, entry });
	check(entry.handedOver === true, "the ACP entry is not marked handed over");
	check(!(await acp.list()).some(({ name }) => name === card), "the ACP side still lists the job");

	// One window, labelled as a job's, whose claude goes on with the ACP session on an explicit model in the realpath.
	const inHangar = await blocks();
	const view = await client.call("session.view", { session_id: hangar }, ViewSchema);
	check(inHangar.length === 1, `the hangar holds ${inHangar.length} blocks`);
	const [block] = inHangar;
	const blockId = block?.block_id as string;
	const where = { session_id: hangar, block_id: blockId, args: {} };
	const { foreground } = await client.call(`${TERMINAL}.process`, where, ProcessResultSchema);
	paneClaude = foreground?.pid;
	const command = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(foreground?.pid)], {
		encoding: "utf8",
	}).stdout;
	// claude's own record of the session it runs, keyed by its pid; read only for its sessionId.
	const own = await until("claude's record of its session", 15_000, () =>
		readFile(join(sessionsDir, `${foreground?.pid}.json`), "utf8").then(
			(text) => JSON.parse(text) as { sessionId?: string },
			() => undefined,
		),
	);
	log("window", {
		windows: (view.windows ?? []).map((window) => window.label),
		blockLabel: block?.label,
		argv0: foreground?.argv0,
		cwd: foreground?.cwd,
		command: command.trim(),
		claudeSessionId: own.sessionId,
	});
	check((view.windows ?? []).length === 1 && view.windows?.[0]?.label === card, "the window is not the card's");
	check(block?.label === acpSessionId, `the block is labelled ${block?.label}`);
	check(foreground?.argv0 === "claude", `the pane's foreground is ${foreground?.argv0}`);
	check(foreground?.cwd === cwd, `the pane's cwd is ${foreground?.cwd}`);
	check(command.includes(`--resume ${acpSessionId}`), "claude was not started with --resume on the ACP session");
	check(/--model \S*haiku/.test(command), "claude was not started with an explicit haiku model");
	check(own.sessionId === acpSessionId, `the pane's claude runs session ${own.sessionId}`);

	const handed = await job();
	const listed = (await agents.list()).find(({ name }) => name === card);
	const notices = await entries(NOTICE);
	log("moved", {
		job: handed && { card: handed.card, agent: handed.agent, sessionId: handed.sessionId },
		listed,
		notices: notices.map((each) => each.data),
	});
	check(handed?.card === card && handed.agent === card, "the job changed its card or name");
	check(handed?.sessionId === acpSessionId, "the job does not go by the session its window runs");
	check(listed?.sessionId === acpSessionId, "the listing does not name the window's session");
	check(notices.length === 1, `${notices.length} notices were written`);
	check(JSON.stringify(notices[0]?.data).includes(`its window is ${card} in session ${label}`), "no notice names it");

	// The real dialog, answered by take: a repo trusted already would pass everything above with no key pressed at all.
	log("answer", {
		keysPressed: pressed,
		responsesDuringHandover: responses - responsesBefore,
		inOwnConfigNow: [...(await trusted(config))],
	});
	check(answered !== undefined, "no key was pressed in the window");
	check(isTrustDialog(readBlockedScreen(answered as string)), "the first key was not pressed on the trust dialog");
	check(responses === responsesBefore, "the model answered a prompt during the handover, which take should have");

	await say("回覆");
	check(JSON.stringify(results.at(-1)) === '{"sent":true}', `reply said ${JSON.stringify(results.at(-1))}`);
	// A turn read before claude flushed it is recorded 未知 and then for real ("Event bridge"), so it is waited for by the
	// word, which is what shows the conversation went on.
	const turns = await until("the reply's turn to be recorded", 180_000, async () => {
		const done = await entries(JOB_DONE);
		return done.length > 1 && (await agents.readResult(card))?.text?.includes(word) ? done : undefined;
	});
	await root.waitForIdle(context);
	const replied = await agents.readResult(card);
	const after = await job();
	log("reply", {
		result: replied,
		done: turns.at(-1)?.data,
		job: after && { status: after.status, outcome: after.outcome },
	});
	check(replied?.text?.includes(word) ?? false, "the reply does not hold the word planted over ACP");

	await say("畫面");
	const screen = results.at(-1) as { text?: string };
	log("screen", (screen.text ?? "").split("\n").slice(-20));
	check(screen.text?.includes(word) ?? false, "the screen does not show the word in the pane");

	// One transcript throughout: the reply is the last record of the file the ACP session wrote, on haiku.
	const directoryOf = join(projects, projectDirNameFor(cwd));
	const files = (await readdir(directoryOf)).filter((name) => name.endsWith(".jsonl"));
	const transcript = join(directoryOf, `${acpSessionId}.jsonl`);
	const last = await readLastRecord(transcript);
	const model = await readSessionModel(transcript);
	log("transcript", { files, lastId: last?.id, resultId: after?.resultId, model });
	check(files.includes(`${acpSessionId}.jsonl`), "the ACP session's transcript is gone");
	check(last?.id === after?.resultId, "the job did not record the transcript's last record");
	check(model?.includes("haiku") ?? false, `the reply ran on ${model}`);
	const { records } = await client.call(`${TERMINAL}.program_status`, where, ProgramStatusResultSchema);
	log("status", { root: records.find((record) => !record.id)?.state });
	// Read after a turn, as claude may not have written the answer yet when it first reports itself up.
	const inOwnConfig = await until("the answer to the dialog in the smoke's own config", 30_000, async () => {
		const own = await trusted(config);
		return own.has(repo) ? [...own] : undefined;
	});
	const gained = [...(await trusted(homedir()))].filter((path) => !trustedBefore.has(path));
	// Other claudes of the human's may gain theirs meanwhile.
	const ours = gained.filter((path) => path.startsWith(directory));
	log("trust", { gained, ours, inOwnConfig });
	check(ours.length === 0, `~/.claude.json gained trust for ${JSON.stringify(ours)}`);
	console.log("PASS");
} finally {
	log("at the end", await standing().catch((error: Error) => error.message));
	off();
	await client
		.call("session.destroy", { session_id: hangar }, EmptyResultSchema)
		.catch((error: Error) => console.error(`destroy ${hangar}: ${error.message}`));
	// The pane's claude was started for this smoke, so what the destroy left of it is the smoke's to end.
	await acpAgents().catch((error: Error) => console.error(`stop: ${error.message}`));
	const pid = paneClaude;
	if (pid !== undefined) {
		for (const deadline = Date.now() + 10_000; alive(pid) && Date.now() < deadline; ) await delay(200);
		if (alive(pid)) {
			console.error(`the pane's claude ${pid} outlived its session, and is killed`);
			process.kill(pid, "SIGTERM");
		}
	}
	const { sessions } = await client
		.call("session.attach_all", { event_scope: "session" }, AttachAllResultSchema)
		.catch(() => ({ sessions: null }));
	await delay(1_000);
	const remaining = mine();
	for (const { pid: each } of remaining) process.kill(each);
	log("cleanup", {
		sessionGone: !(sessions ?? []).some((session) => session.label === label),
		paneClaudeAlive: pid !== undefined && alive(pid),
		processesLeft: remaining.map(({ pid: each, command }) => ({ pid: each, command: command.slice(0, 80) })),
	});
	await harness?.close(context);
	client.close();
	await rm(directory, { recursive: true, force: true });
	log("removed", { directoryLeft: existsSync(directory) });
}
