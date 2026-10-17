// Terminal client smoke under real tmux (which does not support OSC 7501) and a real herdr test session:
//   1. auto-detect: the client asks, tmux answers only device attributes, so no report is written; a typed
//      「派 <card> <repo>」 dispatches through herdr and the answer is printed on a clean screen;
//   2. once herdr reports the agent blocked (Claude Code's folder trust prompt), a restarted client with
//      SOMA_PROGRAM_STATUS=1 writes the job's blocked record and soma's working/idle records, and tmux
//      swallows them: the screen still shows only what was typed and answered.
// The raw bytes the client wrote are captured with script(1) inside the tmux pane.
// It removes the card's worktree, branch and repo at the end.
//   node smoke/terminal.ts <herdr socket of a test session>
// herdr refuses to nest, so from inside a herdr pane start the test session with its variables cleared:
//   tmux -L herdr-test new-session -d "env -u HERDR_SOCKET_PATH -u HERDR_ENV -u HERDR_SESSION -u HERDR_TAB_ID \
//     -u HERDR_WORKSPACE_ID -u HERDR_PANE_ID -u TERM_PROGRAM -u SSH_AUTH_SOCK herdr --session soma-test"
//   node smoke/terminal.ts ~/.config/herdr/sessions/soma-test/herdr.sock
// and remove it afterwards with `herdr session stop soma-test`, `herdr session delete soma-test`, and
// `tmux -L herdr-test kill-server`.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHerdrClient } from "../src/adapters/herdr/client.ts";
import { formatProgramStatus } from "../src/adapters/terminal/program-status.ts";
import { delay } from "./driver.ts";

const [socket] = process.argv.slice(2);
if (socket === undefined) throw new Error("usage: terminal.ts <herdr socket>");
const CHILD = fileURLToPath(new URL("./terminal-child.ts", import.meta.url));
const card = `smoke-${Date.now().toString(36)}`;
const herdr = createHerdrClient({ socketPath: socket });
const directory = mkdtempSync(join(tmpdir(), "soma-terminal-"));
const repo = join(directory, "repo");
const db = join(directory, "soma.sqlite");
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", "soma-terminal-smoke", ...args], { encoding: "utf8" });
const screen = () => tmux("capture-pane", "-p", "-t", "soma").replace(/\s+$/, "");
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, ms = 30_000): Promise<T> {
	for (const deadline = Date.now() + ms; Date.now() < deadline; await delay(250)) {
		const value = await probe();
		if (value !== undefined) return value;
	}
	throw new Error(`timed out waiting for ${what}; screen:\n${screen()}`);
}

async function client(raw: string, programStatus: "auto" | "1") {
	const env = [`SOMA_HERDR_SOCKET=${socket}`, ...(programStatus === "1" ? ["SOMA_PROGRAM_STATUS=1"] : [])];
	// stderr goes to a file so node's own warnings do not count as stray output.
	const command = `script -q -F ${raw} sh -c 'node ${CHILD} ${db} 2>>${join(directory, "stderr.log")}'`;
	tmux("new-session", "-d", "-s", "soma", "-x", "100", "-y", "20", ...env.flatMap((e) => ["-e", e]), command);
	await delay(3000);
}

async function stop() {
	tmux("send-keys", "-t", "soma", "C-d");
	await until("the client to exit", () =>
		spawnSync("tmux", ["-L", "soma-terminal-smoke", "has-session", "-t", "soma"], { stdio: "ignore" }).status === 0
			? undefined
			: true,
	);
}

// What the screen may show: the typed line and the client's answer. Anything else would be a leaked sequence.
function checkClean(typed: string) {
	const lines = screen()
		.split("\n")
		.filter((line) => line.trim() !== "");
	const stray = lines.filter((line) => line !== typed && line !== "已派工。");
	check(stray.length === 0, `stray output on screen: ${JSON.stringify(stray)}`);
	return lines;
}

const typed = `派 ${card} ${repo}`;
try {
	execFileSync("git", ["init", "-q", "-b", "main", repo]);
	execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "chore: init"]);
	log("card", card);

	const autoRaw = join(directory, "auto.raw");
	await client(autoRaw, "auto");
	tmux("send-keys", "-t", "soma", "-l", typed);
	tmux("send-keys", "-t", "soma", "Enter");
	await until("the answer", () => (screen().includes("已派工。") ? true : undefined));
	const auto = readFileSync(autoRaw, "utf8");
	check(auto.includes("\x1b]7501;?\x1b\\\x1b[c"), "the client did not ask");
	check(!auto.includes("\x1b]7501;state="), "the client wrote a report to a terminal that never answered");
	log("auto", { asked: true, reports: 0, screen: checkClean(typed) });

	const status = await until("herdr to report the agent blocked", async () => {
		const agent = (await herdr.agentList()).find((a) => a.name === card);
		return agent?.agent_status === "blocked" ? agent.agent_status : undefined;
	});
	await stop();
	log("herdr", { agent: card, status });

	const forcedRaw = join(directory, "forced.raw");
	await client(forcedRaw, "1");
	tmux("send-keys", "-t", "soma", "-l", typed);
	tmux("send-keys", "-t", "soma", "Enter");
	await until("the answer", () => (screen().includes("已派工。") ? true : undefined));
	await delay(500);
	const forcedScreen = checkClean(typed);
	await stop();
	const forced = readFileSync(forcedRaw, "utf8");
	const expected = [
		formatProgramStatus({ state: "idle", app: "soma" }),
		formatProgramStatus({ state: "blocked", id: `job/${card}`, title: card, kind: "permission" }),
		formatProgramStatus({ state: "working", app: "soma" }),
	];
	let at = 0;
	for (const sequence of [...expected, expected[0] as string]) {
		const found = forced.indexOf(sequence, at);
		check(found >= 0, `missing ${JSON.stringify(sequence)} after byte ${at} in ${JSON.stringify(forced)}`);
		at = found + sequence.length;
	}
	check(!forced.includes("\x1b]7501;?"), "the forced client still asked");
	const reports = forced
		.split("\x1b]7501;")
		.slice(1)
		.map((report) => report.split("\x1b")[0]);
	log("forced", { reports, screen: forcedScreen });
	console.log("PASS");
} catch (error) {
	console.error(readFileSync(join(directory, "stderr.log"), "utf8"));
	throw error;
} finally {
	spawnSync("tmux", ["-L", "soma-terminal-smoke", "kill-server"], { stdio: "ignore" });
	const agent = (await herdr.agentList()).find((a) => a.name === card);
	if (agent !== undefined) await herdr.call("worktree.remove", { workspace_id: agent.workspace_id, force: true });
	rmSync(directory, { recursive: true, force: true });
}
