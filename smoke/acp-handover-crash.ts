// A handover of an ACP job cut short by SIGKILL, against the real rex server, the real claude-agent-acp and real claude,
// on haiku. Two soma processes in turn on one db and one sessions file (smoke/acp-handover-crash-child.ts), as a soma and
// the soma that restarts after it; the hangar is a rex session of its own, labelled soma-smoke-<random>, and the job a
// fresh git repo. The first dispatches a card whose brief plants a word over ACP, then is asked to show the job:
//   before  it dies past the in-progress mark and the end of its ACP process, just before the window opens. The second
//           starts inside the grace period and finds no window, so the job is undecided: no process, and a reply refused
//           naming the grace period. Once the 60 s have passed a look with no caller puts it on ACP, with one notice, and
//           a reply wakes it with session/load and brings the word back.
//   after   it dies just as the window opens, before the final mark. The second finds the window, so the job is on rex:
//           one notice names the window, the job takes the session, the listing names the window, nothing runs under the
//           second soma, ever, the bridge hands the model the trust dialog no one answered, and a reply goes into the pane
//           and brings the word back.
// Either way one transcript holds the job. Two prompts run on haiku. Every claude runs with one CLAUDE_CONFIG_DIR beside the
// repo, as the pane's --resume has to find the transcript written over ACP, so in `after` the dialog is asked and its
// answer lands there. Since the dead soma's `take` is not repeated, the bridge wakes the model for it, and `respond`
// answers it: an `after` run with no dialog, or with one answered any other way, fails, and either scenario fails on a
// trust entry in ~/.claude.json for a path of its own. It kills what is left of its children by PID, waits for the pane's
// claude, and destroys its rex session and removes its repo, config and db at the end, also on failure. Only the trusted
// paths are read out of either .claude.json.
//   node smoke/acp-handover-crash.ts before|after
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createRexClient, defaultRexSocket } from "../src/adapters/rex/client.ts";
import {
	BlockListSchema,
	EmptyResultSchema,
	FormatResultSchema,
	ProcessResultSchema,
	ProgramStatusResultSchema,
	TERMINAL,
	ViewSchema,
} from "../src/adapters/rex/schema.ts";
import { isTrustDialog, readBlockedScreen } from "../src/agent-cli/permission/blocked-screen.ts";
import { projectDirNameFor, readSessionModel } from "../src/agent-cli/transcript.ts";
import { runGit } from "../src/agent-cli/worktree.ts";
import { delay } from "./driver.ts";

const scenario = process.argv[2];
if (scenario !== "before" && scenario !== "after") throw new Error("usage: acp-handover-crash.ts before|after");
const CHILD = fileURLToPath(new URL("./acp-handover-crash-child.ts", import.meta.url));
const tag = Date.now().toString(36);
const card = `smoke-${tag}`;
const word = `KUMQUAT-${tag}`;
const label = `soma-smoke-${tag}`;
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

type Line = { step: string } & Record<string, unknown>;

/** A soma of the smoke's, with every JSON line it printed so far; its stderr goes to the smoke's. */
function soma(args: string[]) {
	const child = spawn(process.execPath, [CHILD, ...args], { stdio: ["pipe", "pipe", "inherit"] });
	const lines: Line[] = [];
	createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
		try {
			const parsed = JSON.parse(line) as Line;
			lines.push(parsed);
			if (["status", "tool", "dying", "woken", "dialog", "key"].includes(parsed.step)) log(parsed.step, parsed);
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
	return { process: child, lines, next, go: () => child.stdin.write("go\n") };
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
	// ps shows a process that has exited, and waits to be reaped, by its name in parentheses or as <defunct>.
	return rows.filter((row) => row.pid !== pid && under.has(row.pid) && !/^\(|^<defunct>/.test(row.command));
}

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

const client = createRexClient({
	socketPath: process.env.SOMA_REX_SOCKET ?? defaultRexSocket(homedir()),
	onError: (error) => console.error(`[smoke] ${error.message}`),
});
const directory = await realpath(await mkdtemp(join(tmpdir(), "soma-acp-handover-crash-")));
const repo = join(directory, "repo");
const config = join(directory, "claude-config");
const projects = join(config, "projects");
const sessionsFile = join(directory, "acp-sessions.json");
const git = (...args: string[]) => runGit(repo, args);
const identity = ["-c", "user.name=soma smoke", "-c", "user.email=smoke@example.com", "-c", "commit.gpgsign=false"];
const entry = async () =>
	JSON.parse(await readFile(sessionsFile, "utf8"))[card] as {
		acpSessionId: string;
		cwd: string;
		handedOver?: true;
		handingOver?: true;
		hangar?: string;
	};
// Last before the `try`, whose `finally` destroys it, so nothing that can fail lies between.
const { session_id: hangar } = await client
	.call("session.create", { label }, z.object({ session_id: z.string() }).passthrough())
	.catch(async (error: Error) => {
		await rm(directory, { recursive: true, force: true });
		throw error;
	});
const blocks = async () =>
	(await client.call("session.list_blocks", { session_id: hangar }, BlockListSchema)).blocks ?? [];
const children: ChildProcess[] = [];
// The first soma's processes until they are seen gone: its death leaves them under no one, and `descendants` finds none.
let firstTree: number[] = [];

/** The claude in each pane of the hangar, read before the destroy ends it. */
async function paneClaudes(): Promise<number[]> {
	const running = await Promise.all(
		(await blocks()).map((block) =>
			client.call(
				`${TERMINAL}.process`,
				{ session_id: hangar, block_id: block.block_id, args: {} },
				ProcessResultSchema,
			),
		),
	);
	return running.flatMap(({ foreground }) => (foreground?.argv0 === "claude" ? [foreground.pid] : []));
}

/** What explains a run, read before the cleanup removes it. */
async function standing() {
	const where = async (block: string | null) => {
		const at = { session_id: hangar, block_id: block, args: {} };
		const [running, status, screen] = await Promise.all([
			client.call(`${TERMINAL}.process`, at, ProcessResultSchema),
			client.call(`${TERMINAL}.program_status`, at, ProgramStatusResultSchema),
			client.call(
				`${TERMINAL}.format`,
				{ ...at, args: { format: "text", trim: true, max_bytes: 4000 } },
				FormatResultSchema,
			),
		]);
		return {
			foreground: running.foreground?.argv0,
			records: status.records,
			screen: screen.content.split("\n").slice(-25),
		};
	};
	const inHangar = await blocks();
	return {
		entry: await entry().catch((error: Error) => error.message),
		view: ((await client.call("session.view", { session_id: hangar }, ViewSchema)).windows ?? []).map(
			(window) => window.label,
		),
		blocks: await Promise.all(
			inHangar.map(async (block) => ({ label: block.label, ...(await where(block.block_id)) })),
		),
		somas: children.map((child) => `${child.pid}: exit ${child.exitCode} signal ${child.signalCode}`),
	};
}

try {
	await client.attach(hangar);
	await runGit(directory, ["init", "-q", "-b", "main", repo]);
	await writeFile(join(repo, "README.md"), `# acp handover crash smoke ${tag}\n`);
	await mkdir(join(repo, ".claude"));
	// The human's own mode may be auto, under which claude does not ask.
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
	log("hangar", { session: hangar, label, card, repo, scenario, word });
	const args = [scenario, directory, hangar, card, repo, word];

	const first = soma(["first", ...args]);
	children.push(first.process);
	const recorded = await first.next("recorded", 240_000);
	log("recorded", { done: recorded.done, result: recorded.result });
	const before = await entry();
	const tree = descendants(first.process.pid as number);
	firstTree = tree.map(({ pid }) => pid);
	log("over acp", {
		entry: before,
		processes: tree.map(({ pid, command }) => ({ pid, command: command.slice(0, 160) })),
		blocksInHangar: (await blocks()).length,
		model: await readSessionModel(join(projects, projectDirNameFor(before.cwd), `${before.acpSessionId}.jsonl`)),
	});
	check(
		tree.some(({ command }) => command.includes("claude-agent-acp")),
		"no claude-agent-acp process runs under the first soma",
	);
	check((await blocks()).length === 0, "the hangar holds a block before the handover");

	first.go();
	const [code, signal] = await new Promise<[number | null, string | null]>((resolve) => {
		first.process.once("exit", (...exit) => resolve(exit));
	});
	log("killed", { code, signal, entry: await entry(), blocks: (await blocks()).map((block) => block.label) });
	check(signal === "SIGKILL", `the first soma ended with ${signal ?? `code ${code}`}`);
	check(
		first.lines.some((line) => line.step === "dying"),
		"the first soma did not die at the scenario's point",
	);
	const left = await entry();
	check(left.handingOver === true, "the entry does not hold the in-progress mark as the first soma dies");
	check(left.handedOver === undefined, "the entry holds the final mark as the first soma dies");
	check((await blocks()).length === (scenario === "after" ? 1 : 0), "the hangar holds the wrong number of blocks");
	for (const deadline = Date.now() + 15_000; tree.some(({ pid }) => alive(pid)) && Date.now() < deadline; ) {
		await delay(250);
	}
	const orphaned = tree.filter(({ pid }) => alive(pid));
	log("left", orphaned);
	check(orphaned.length === 0, `${orphaned.length} of the first soma's processes are still alive`);
	firstTree = [];

	const second = soma(["second", ...args]);
	children.push(second.process);
	const secondPid = second.process.pid as number;
	const reconciled = await second.next("reconciled", 120_000);
	log("reconciled", reconciled);
	const listed = reconciled.listed as { name: string; sessionId?: string; status?: unknown }[];
	const resolved = await entry();
	log("resolved", resolved);
	check(listed.length === 1 && listed[0]?.name === card, "the second soma does not list the job, alone");
	check(
		!(reconciled.notices as { content: string }[]).some(({ content }) => content.includes("不見了")),
		"the job was reported gone",
	);
	check((reconciled.dormant as string[]).length === 0, "the second soma names the job dormant");
	const moves = (notices: unknown) =>
		(notices as { content: string }[]).filter(({ content }) =>
			content.includes(`its window is ${card} in session ${label}`),
		);
	if (scenario === "before") {
		check(resolved.handingOver === true, "the second soma gave the job up inside the grace period");
		check(resolved.handedOver === undefined, "the job is marked handed over with no window");
		check(resolved.hangar === hangar, `the mark records the hangar ${resolved.hangar}`);
		check(listed[0]?.status === undefined, "the job is listed with a status before any prompt");
		check(moves(reconciled.notices).length === 0, "a notice names a window that never opened");
	} else {
		check(resolved.handingOver === undefined, "the second soma left the in-progress mark");
		check(resolved.handedOver === true, "the entry did not get the final mark");
		check(listed[0]?.sessionId === before.acpSessionId, "the listing does not name the window's session");
		check(moves(reconciled.notices).length === 1, "no one notice names the window and its session");
		const { sessionId } = reconciled.job as { sessionId: string };
		check(sessionId === before.acpSessionId, `the job holds the session ${sessionId}`);
	}
	// The second soma waits for the smoke before it replies.
	await delay(2_000);
	const asleep = descendants(secondPid);
	log("under 2nd", asleep);
	check(asleep.length === 0, "something runs under the second soma before any prompt");

	second.go();
	// Everything that ran under the second soma from here on, read while its turn runs.
	const seen = new Map<number, string>();
	const watch = setInterval(() => {
		for (const { pid, command } of descendants(secondPid)) seen.set(pid, command);
	}, 250);
	if (scenario === "before") {
		const refused = await second.next("too soon", 30_000);
		log("too soon", refused);
		check(String(refused.result).includes("grace period"), "the reply was not refused naming the grace period");
		check(seen.size === 0, "something ran under the second soma inside the grace period");
		const back = await second.next("back", 90_000);
		log("back", back);
		const after = await entry();
		log("resolved", after);
		check(after.handingOver === undefined, "the look at the end of the grace period left the mark");
		check(after.handedOver === undefined, "the job is marked handed over with no window");
		const told = (back.notices as { content: string }[]).filter(({ content }) => content.includes("is back on ACP"));
		check(told.length === 1, `${told.length} notices tell the job came back`);
	}
	const replied = await second.next("replied", 360_000).finally(() => clearInterval(watch));
	log(
		"said",
		second.lines.find((line) => line.step === "said"),
	);
	log("replied", { result: replied.result, done: replied.done, listed: replied.listed });
	if (scenario === "after") {
		check(moves(replied.notices).length === 1, "the notice of the move was not told once");
	}
	log(
		"under 2nd",
		[...seen.entries()].map(([pid, command]) => [pid, command.slice(-80)]),
	);
	const text = (replied.result as { text?: string } | undefined)?.text ?? "";
	check(text.includes(word), "the reply does not hold the word planted over ACP");
	if (scenario === "before") {
		check(
			[...seen.values()].some((command) => command.includes("claude-agent-acp")),
			"no claude-agent-acp process ran under the second soma for the reply",
		);
	} else {
		check(seen.size === 0, "something ran under the second soma though the job is on rex");
	}

	// One window when it is on rex, labelled with the session and running it, and none when it is not.
	const view = await client.call("session.view", { session_id: hangar }, ViewSchema);
	const inHangar = await blocks();
	log("hangar", { windows: (view.windows ?? []).map((window) => window.label), blocks: inHangar.map((b) => b.label) });
	if (scenario === "before") {
		check(inHangar.length === 0 && (view.windows ?? []).length === 0, "a job on ACP has a window");
	} else {
		check(inHangar.length === 1 && view.windows?.[0]?.label === card, "a job on rex does not have its one window");
		check(inHangar[0]?.label === before.acpSessionId, `the block is labelled ${inHangar[0]?.label}`);
		const where = { session_id: hangar, block_id: inHangar[0]?.block_id, args: {} };
		const { foreground } = await client.call(`${TERMINAL}.process`, where, ProcessResultSchema);
		const command = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(foreground?.pid)], {
			encoding: "utf8",
		}).stdout;
		log("window", { argv0: foreground?.argv0, cwd: foreground?.cwd, command: command.trim() });
		check(command.includes(`--resume ${before.acpSessionId}`), "the pane's claude does not go on with the session");
	}

	// One transcript throughout, named after the session the job ran over ACP.
	const files = (await readdir(join(projects, projectDirNameFor(before.cwd)))).filter((name) =>
		name.endsWith(".jsonl"),
	);
	const model = await readSessionModel(join(projects, projectDirNameFor(before.cwd), `${before.acpSessionId}.jsonl`));
	log("transcript", { files, model });
	check(
		JSON.stringify(files) === JSON.stringify([`${before.acpSessionId}.jsonl`]),
		`the job has transcripts ${JSON.stringify(files)}`,
	);

	if (scenario === "after") {
		// The real dialog, answered by the model: a repo trusted already would pass everything above with no key pressed.
		const woken = second.lines.find((line) => line.step === "woken");
		const dialog = second.lines.find((line) => line.step === "dialog");
		const { decisions } = replied.job as { decisions: { action: string; fingerprint?: string }[] };
		log("answer", {
			keysPressed: second.lines.filter((line) => line.step === "key").map((line) => line.key),
			option: woken?.option,
			decisions,
		});
		check(woken !== undefined, "the bridge did not wake the model for the dialog");
		check(String(woken?.wake).includes(`repository root ${repo}`), "the wake does not name the smoke's repo");
		check(dialog !== undefined, "no key was pressed in the window");
		check(
			isTrustDialog(readBlockedScreen(((dialog?.screen ?? []) as string[]).join("\n"))),
			"the first key was not pressed on the trust dialog",
		);
		check(
			decisions.some(({ action, fingerprint }) => action === "answered" && fingerprint === woken?.fingerprint),
			"the job records no answer to the prompt the model was woken for",
		);
		// Read after a turn, as claude may not have written the answer yet when it first reports itself up.
		for (const deadline = Date.now() + 30_000; !(await trusted(config)).has(repo); await delay(250)) {
			check(Date.now() < deadline, "the answer to the dialog did not land in the smoke's own config");
		}
	}
	const gained = [...(await trusted(homedir()))].filter((path) => !trustedBefore.has(path));
	// Other claudes of the human's may gain theirs meanwhile.
	const ours = gained.filter((path) => path.startsWith(directory));
	log("trust", { gained, ours, inOwnConfig: [...(await trusted(config))] });
	check(ours.length === 0, `~/.claude.json gained trust for ${JSON.stringify(ours)}`);

	second.go();
	await second.next("end", 30_000);
	console.log(`PASS ${scenario}`);
} finally {
	log("at the end", await standing().catch((error: Error) => error.message));
	// Everything under a soma is the smoke's too: left running, it would write its transcript back after the removal below.
	const orphans = [
		...firstTree,
		...children.flatMap((child) => descendants(child.pid as number).map(({ pid }) => pid)),
	];
	for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	for (const pid of orphans) if (alive(pid)) process.kill(pid, "SIGKILL");
	for (const deadline = Date.now() + 5_000; orphans.some(alive) && Date.now() < deadline; ) await delay(100);
	const panes = await paneClaudes().catch((error: Error) => {
		console.error(`the panes' claudes: ${error.message}`);
		return [];
	});
	await client
		.call("session.destroy", { session_id: hangar }, EmptyResultSchema)
		.catch((error: Error) => console.error(`destroy ${hangar}: ${error.message}`));
	// A claude that outlives its session writes its config back, after a removal that came too soon, so what the destroy
	// left of it is the smoke's to end, and to wait for.
	for (const deadline = Date.now() + 10_000; panes.some(alive) && Date.now() < deadline; ) await delay(200);
	for (const pid of panes.filter(alive)) {
		console.error(`the pane's claude ${pid} outlived its session, and is killed`);
		process.kill(pid, "SIGTERM");
	}
	for (const deadline = Date.now() + 5_000; panes.some(alive) && Date.now() < deadline; ) await delay(200);
	client.close();
	await rm(directory, { recursive: true, force: true });
	log("cleanup", { panes, paneClaudesAlive: panes.filter(alive), directoryLeft: existsSync(directory) });
}
