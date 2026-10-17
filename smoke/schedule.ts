// Schedule smoke test: the model schedules a reminder, the core is killed with SIGKILL mid-wait, a new
// process reopens the same SQLite file, and the reminder must reach the root conversation once, on time.
//   node smoke/schedule.ts [delaySeconds=120]
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./driver.ts";

const CHILD = fileURLToPath(new URL("./schedule-child.ts", import.meta.url));
const LATE_TOLERANCE_MS = 2_000;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type ScheduleReport = { at: number; killedAt: number; reopenedAt: number; firedAt: number; reply: string };

export async function runScheduleSmoke(delayMs: number, killAfterMs: number, words: string): Promise<ScheduleReport> {
	const directory = await mkdtemp(join(tmpdir(), "soma-schedule-"));
	try {
		const db = join(directory, "soma.sqlite");
		const first = run(["start", db, `PT${delayMs / 1000}S`, words], CHILD);
		const armed = await first.next("armed");
		const at = Number(armed.at);
		await delay(killAfterMs);
		if (first.process.exitCode !== null) throw new Error("first process exited on its own before the kill");
		first.process.kill("SIGKILL");
		await first.exited;
		const killedAt = Date.now();
		if (first.process.signalCode !== "SIGKILL") throw new Error(`first process ended by ${first.process.signalCode}`);
		if (killedAt >= at) throw new Error("killed after at; the wait was not exercised");

		const second = run(["resume", db, String(armed.taskId)], CHILD);
		const reopenedAt = Number((await second.next("reopened")).at);
		const done = await second.next("done");
		if ((await second.exited) !== 0) throw new Error("second process failed");

		const outcome = done.outcome as { status: string };
		const fires = done.fires as string[];
		const [firedAt] = done.firedAt as number[];
		const [reply] = done.replies as string[];
		if (outcome.status !== "completed") throw new Error(`task ended ${JSON.stringify(outcome)}`);
		if (fires.length !== 1 || firedAt === undefined || reply === undefined) {
			throw new Error(`reminder reached the conversation ${fires.length} times: ${JSON.stringify(fires)}`);
		}
		if (firedAt < at) throw new Error(`fired ${at - firedAt} ms early`);
		if (firedAt - at > LATE_TOLERANCE_MS) throw new Error(`fired ${firedAt - at} ms late`);
		return { at, killedAt, reopenedAt, firedAt, reply };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const seconds = Number(process.argv[2] ?? 120);
	const words = `${seconds} 秒後提醒我 喝水`;
	console.log(`said      ${words}`);
	const report = await runScheduleSmoke(seconds * 1_000, Math.min(5_000, (seconds * 1_000) / 3), words);
	const iso = (ms: number) => new Date(ms).toISOString();
	console.log(`at        ${iso(report.at)}`);
	console.log(`killed    ${iso(report.killedAt)} (SIGKILL)`);
	console.log(`reopened  ${iso(report.reopenedAt)}`);
	console.log(`fired     ${iso(report.firedAt)} (+${report.firedAt - report.at} ms, once)`);
	console.log(`reply     ${report.reply}`);
}
