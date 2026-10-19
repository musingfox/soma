// Memory smoke test: the model revises a curated line, the core is killed with SIGKILL while that turn is still
// open, a new process reopens the same SQLite file, and the revision must be live once, with one history row
// and one notice.
//   node smoke/memory.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./driver.ts";

const CHILD = fileURLToPath(new URL("./memory-child.ts", import.meta.url));

const directory = await mkdtemp(join(tmpdir(), "soma-memory-"));
try {
	const db = join(directory, "soma.sqlite");
	const first = run(["start", db], CHILD);
	const revised = await first.next("revised");
	console.log(`revised   pid ${revised.pid}: ${JSON.stringify(revised.lines)}`);
	console.log(`          history ${(revised.history as unknown[]).length}, notices ${revised.notices}`);
	first.process.kill("SIGKILL");
	await first.exited;
	if (first.process.signalCode !== "SIGKILL") throw new Error(`first process ended by ${first.process.signalCode}`);
	console.log(`killed    pid ${revised.pid} (${first.process.signalCode}) mid-turn`);

	const second = run(["resume", db], CHILD);
	await second.next("reopened");
	const done = await second.next("done");
	if ((await second.exited) !== 0) throw new Error("second process failed");
	const lines = done.lines as { text: string }[];
	const history = done.history as { action: string; before: { text: string }; after: { text: string } }[];
	console.log(`reopened  turn ${done.status}: ${JSON.stringify(lines)}`);
	console.log(`          history ${JSON.stringify(history.map((r) => [r.action, r.before.text, r.after.text]))}`);
	console.log(`          notices ${done.notices}`);
	console.log(`prompt    ${JSON.stringify(done.prompt)}`);
	const live = lines.length === 1 && lines[0]?.text.includes("十點");
	const prompt = String(done.prompt);
	if (!live || history.length !== 1 || done.notices !== 1 || !prompt.includes("十點") || prompt.includes("九點")) {
		throw new Error("revision did not survive the kill exactly once");
	}
	console.log("ok        new version live, one history row, one notice");
} finally {
	await rm(directory, { recursive: true, force: true });
}
