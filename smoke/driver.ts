// Durable smoke test: a background task sleeps until `until`, the process is killed
// with SIGKILL mid-sleep, a new process reopens the same SQLite file and calls
// resume(), and the task must fire once, at `until`.
//   node smoke/driver.ts [delaySeconds=120]
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const CHILD = fileURLToPath(new URL("./child.ts", import.meta.url));
const LATE_TOLERANCE_MS = 2_000;

type Line = Record<string, unknown> & { event?: string };
type Child = {
	process: ChildProcess;
	lines: Line[];
	next(event: string): Promise<Line>;
	exited: Promise<number | null>;
};

function run(args: string[]): Child {
	const child = spawn(process.execPath, [CHILD, ...args], { stdio: ["ignore", "pipe", "inherit"] });
	if (child.stdout === null) throw new Error("child has no stdout");
	const lines: Line[] = [];
	const waiters: { event: string; resolve(line: Line): void }[] = [];
	createInterface({ input: child.stdout }).on("line", (text) => {
		let line: Line;
		try {
			line = JSON.parse(text);
		} catch {
			return;
		}
		lines.push(line);
		for (const waiter of waiters.filter((w) => w.event === line.event)) waiter.resolve(line);
	});
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	const next = (event: string) =>
		new Promise<Line>((resolve, reject) => {
			const seen = lines.find((line) => line.event === event);
			if (seen) return resolve(seen);
			waiters.push({ event, resolve });
			void exited.then((code) => reject(new Error(`child exited (${code}) before "${event}"`)));
		});
	return { process: child, lines, next, exited };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type SmokeReport = { until: number; killedAt: number; reopenedAt: number; firedAt: number; wakeups: number };

export async function runSmoke(delayMs: number, killAfterMs = Math.min(5_000, delayMs / 3)): Promise<SmokeReport> {
	const directory = await mkdtemp(join(tmpdir(), "soma-smoke-"));
	try {
		const db = join(directory, "soma.sqlite");
		const until = Date.now() + delayMs;

		const first = run(["start", db, String(until)]);
		const armed = await first.next("armed");
		await delay(killAfterMs);
		if (first.process.exitCode !== null) throw new Error("first process exited on its own before the kill");
		first.process.kill("SIGKILL");
		await first.exited;
		const killedAt = Date.now();
		if (first.process.signalCode !== "SIGKILL") throw new Error(`first process ended by ${first.process.signalCode}`);
		if (first.lines.some((line) => line.event === "fired")) throw new Error("fired before the kill");

		const second = run(["resume", db, String(armed.taskId)]);
		const reopenedAt = Number((await second.next("reopened")).at);
		const done = await second.next("done");
		if ((await second.exited) !== 0) throw new Error("second process failed");

		const fired = second.lines.filter((line) => line.event === "fired");
		const wakeups = done.wakeups as { firedAt: number }[];
		const outcome = done.outcome as { status: string };
		if (outcome.status !== "completed") throw new Error(`task ended ${JSON.stringify(outcome)}`);
		if (fired.length !== 1) throw new Error(`fired ${fired.length} times after reopen`);
		const [wakeup] = wakeups;
		if (wakeups.length !== 1 || wakeup === undefined) throw new Error(`${wakeups.length} wakeup records`);
		const { firedAt } = wakeup;
		if (reopenedAt >= until) throw new Error("reopened after until; the wait was not exercised");
		if (firedAt < until) throw new Error(`fired ${until - firedAt} ms early`);
		if (firedAt - until > LATE_TOLERANCE_MS) throw new Error(`fired ${firedAt - until} ms late`);
		return { until, killedAt, reopenedAt, firedAt, wakeups: wakeups.length };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const seconds = Number(process.argv[2] ?? 120);
	const report = await runSmoke(seconds * 1_000);
	const at = (ms: number) => new Date(ms).toISOString();
	console.log(`until     ${at(report.until)}`);
	console.log(`killed    ${at(report.killedAt)} (SIGKILL)`);
	console.log(`reopened  ${at(report.reopenedAt)}`);
	console.log(`fired     ${at(report.firedAt)} (+${report.firedAt - report.until} ms)`);
	console.log(`wakeups   ${report.wakeups}`);
}
