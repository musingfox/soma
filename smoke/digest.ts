// Digest smoke test over one SQLite file and three processes, each ended by SIGKILL but the last:
//   1. jobs a and b finish; the core is killed while the digest sleeps toward its first tick;
//   2. a reopened core reaches the tick and submits the report input; the model kills it mid-answer;
//   3. a reopened core finishes job c before resuming. The first report must still cover exactly a and b,
//      once, and c must come in the next one; a quiet period after that must cost no model call.
//   node smoke/digest.ts [periodSeconds=4]
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Child, run } from "./driver.ts";

const CHILD = fileURLToPath(new URL("./digest-child.ts", import.meta.url));
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

async function killed(child: Child, step: string): Promise<void> {
	await child.exited;
	check(child.process.signalCode === "SIGKILL", `${step} ended by ${child.process.signalCode}`);
	const errors = child.lines.filter((line) => line.event === "bridge_error");
	check(errors.length === 0, `bridge error: ${JSON.stringify(errors)}`);
}

export async function runDigestSmoke(periodMs: number) {
	const directory = await mkdtemp(join(tmpdir(), "soma-digest-"));
	try {
		const db = join(directory, "soma.sqlite");
		const first = run(["start", db, String(periodMs)], CHILD);
		const armed = await first.next("armed");
		const next = Number(armed.next);
		check(armed.calls === 0, `finished turns cost ${armed.calls} model calls`);
		check(Date.now() < next - 500, "the first tick is too close to kill before it");
		first.process.kill("SIGKILL");
		await killed(first, "the first core");
		const killedAt = Date.now();
		check(killedAt < next, "killed after the tick; the wait was not exercised");
		log("killed", { during: "wait", msBeforeTick: next - killedAt });

		const second = run(["resume", db], CHILD, { ...process.env, SOMA_SMOKE_KILL_IN_DIGEST: "1" });
		await second.next("reopened");
		await killed(second, "the second core");
		log("killed", { during: "the report's run", afterTickMs: Date.now() - next });

		const third = run(["finish", db, String(periodMs)], CHILD);
		const reopened = await third.next("reopened");
		const done = await third.next("done");
		check((await third.exited) === 0, "the third core failed");
		const { callsAtReports, calls, notices, digests } = done as unknown as {
			callsAtReports: number;
			calls: number;
			notices: string[];
			digests: { cards: string[]; until: string }[];
		};
		log("reopened", reopened.checkpoint);
		log("reports", { notices, digests });
		log("calls", { callsAtReports, afterQuietPeriod: calls });
		check(
			(reopened.checkpoint as { upto?: number }).upto !== undefined,
			"the second core did not pin the report before its run",
		);
		check(JSON.stringify(digests.map((each) => each.cards)) === '[["a","b"],["c"]]', "reports cover the wrong jobs");
		check(JSON.stringify(notices) === '["報告：a 完成；b 未知","報告：c 完成"]', "wrong or repeated notices");
		check(digests[0]?.until === new Date(next).toISOString(), "the first report is not the first tick's");
		// The interrupted run answers once, then c's report: one call each.
		check(callsAtReports === 2, `the third core made ${callsAtReports} model calls for two reports`);
		check(calls === callsAtReports, `a quiet period cost ${calls - callsAtReports} model calls`);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await runDigestSmoke(Number(process.argv[2] ?? 4) * 1_000);
	console.log("PASS");
}
