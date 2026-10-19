// Outcome-signals smoke: a core records each kind of signal once, and a kill -9 restart records none again.
//   1. a core reconciles a dispatch that finished 「結果：失敗」, runs a round whose model throws, and has the model
//      deny an answer; it is killed with SIGKILL after mark_denied's commit, before the tool result's;
//   2. a reopened core reconciles the same listing again and reruns mark_denied, a replay-safe tool. Each signal
//      must still be in the fact layer exactly once.
//   node smoke/signals.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Child, delay, run } from "./driver.ts";

const CHILD = fileURLToPath(new URL("./signals-child.ts", import.meta.url));
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

type Signal = { kind: string; key: string };
type Report = { calls: number; signals: Signal[] };

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

const latest = (child: Child) => child.lines.filter((line) => line.event === "report").at(-1) as Report | undefined;

async function until(child: Child, what: string, ok: (report: Report) => boolean, ms: number): Promise<Report> {
	for (const deadline = Date.now() + ms; ; await delay(250)) {
		const last = latest(child);
		if (last !== undefined && ok(last)) return last;
		check(Date.now() < deadline, `timed out waiting for ${what}; last report ${JSON.stringify(last)}`);
	}
}

const kinds = (report: Report) => report.signals.map((signal) => signal.kind).sort();
const EXPECTED = ["signal.denied", "signal.dispatch_failed", "signal.turn_failed"];

const directory = await mkdtemp(join(tmpdir(), "soma-signals-"));
const children: Child[] = [];
try {
	const db = join(directory, "soma.sqlite");

	const first = run(["run", db, "first"], CHILD, { ...process.env, SOMA_SMOKE_HANG_AFTER_DENIED: "1" });
	children.push(first);
	await first.next("hung");
	const before = await until(first, "three signals", (report) => report.signals.length === 3, 10_000);
	check(JSON.stringify(kinds(before)) === JSON.stringify(EXPECTED), `first core recorded ${kinds(before)}`);
	log("recorded", before.signals);

	first.process.kill("SIGKILL");
	await first.exited;
	check(first.process.signalCode === "SIGKILL", `first core ended by ${first.process.signalCode}`);
	log("killed", { signal: first.process.signalCode, pid: first.process.pid });

	const second = run(["run", db], CHILD);
	children.push(second);
	const rerun = await second.next("denied_exec");
	log("replayed", { tool: "mark_denied", pid: rerun.pid });
	// The replayed tool's result then goes back to the model, which answers once.
	await until(second, "the resumed round to finish", (report) => report.calls >= 1, 10_000);
	await delay(3_000);
	const after = latest(second) as Report;
	check(JSON.stringify(kinds(after)) === JSON.stringify(EXPECTED), `after the restart: ${kinds(after)}`);
	const keys = after.signals.map((signal) => signal.key);
	check(new Set(keys).size === keys.length, `a key recorded twice: ${keys}`);
	log("after", { calls: after.calls, signals: after.signals });
	console.log("PASS");
} finally {
	for (const child of children) child.process.kill("SIGKILL");
	await rm(directory, { recursive: true, force: true });
}
