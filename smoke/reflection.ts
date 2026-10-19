// Reflection smoke test over one SQLite file and three processes, each ended by SIGKILL but the last:
//   1. one signal is recorded and the reflection armed; the core is killed while it sleeps toward its first tick;
//   2. a reopened core must reach the tick on time and submit the reflection; the model kills it mid-answer;
//   3. a reopened core finishes. There must be one reflection input and one notice, and a quiet period after
//      that must cost no model call.
//   node smoke/reflection.ts [periodSeconds=4]
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Child, run } from "./driver.ts";

const CHILD = fileURLToPath(new URL("./reflection-child.ts", import.meta.url));
const LATE_TOLERANCE_MS = 2_000;
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

async function killed(child: Child, step: string): Promise<void> {
	await child.exited;
	check(child.process.signalCode === "SIGKILL", `${step} ended by ${child.process.signalCode}`);
}

export async function runReflectionSmoke(periodMs: number) {
	const directory = await mkdtemp(join(tmpdir(), "soma-reflection-"));
	try {
		const db = join(directory, "soma.sqlite");
		const first = run(["start", db, String(periodMs)], CHILD);
		const armed = await first.next("armed");
		const next = Number(armed.next);
		check(Date.now() < next - 500, "the first tick is too close to kill before it");
		first.process.kill("SIGKILL");
		await killed(first, "the first core");
		const killedAt = Date.now();
		check(killedAt < next, "killed after the tick; the wait was not exercised");
		log("killed", { during: "wait", msBeforeTick: next - killedAt });

		const second = run(["resume", db], CHILD, { ...process.env, SOMA_SMOKE_KILL_IN_REFLECTION: "1" });
		await second.next("reopened");
		const reflecting = Number((await second.next("reflecting")).at);
		await killed(second, "the second core");
		log("killed", { during: "the reflection's run", lateMs: reflecting - next });
		check(reflecting >= next, `the reflection ran ${next - reflecting} ms early`);
		check(reflecting - next < LATE_TOLERANCE_MS, `the reflection ran ${reflecting - next} ms late`);

		const third = run(["finish", db, String(periodMs)], CHILD);
		const reopened = await third.next("reopened");
		const done = await third.next("done");
		check((await third.exited) === 0, "the third core failed");
		const { callsAtNotice, calls, notices, reflections } = done as unknown as {
			callsAtNotice: number;
			calls: number;
			notices: string[];
			reflections: { until: string }[];
		};
		log("reopened", reopened.checkpoint);
		log("ran", { notices, reflections });
		log("calls", { callsAtNotice, afterQuietPeriod: calls });
		check(
			(reopened.checkpoint as { upto?: number }).upto !== undefined,
			"the second core did not pin the signals before its run",
		);
		check(reflections.length === 1, `${reflections.length} reflection inputs`);
		check(reflections[0]?.until === new Date(next).toISOString(), "the reflection is not the first tick's");
		check(notices.length === 1 && notices[0]?.startsWith("觀察：") === true, "wrong or repeated notices");
		// The interrupted run answers once in the third core.
		check(callsAtNotice === 1, `the third core made ${callsAtNotice} model calls for one reflection`);
		check(calls === callsAtNotice, `a quiet period cost ${calls - callsAtNotice} model calls`);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await runReflectionSmoke(Number(process.argv[2] ?? 4) * 1_000);
	console.log("PASS");
}
