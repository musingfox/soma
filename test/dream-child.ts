// One side of the dream crash test in test/dream.test.ts, run twice over one SQLite file:
//   answer <db>   start the dream; once its answer is stored, and before the notice's commit, SIGKILL itself
//   resume <db>   reopen and resume; report the notices, the dream model's calls and the checkpoint
import { AssistantEntry } from "@earendil-works/pi-durable";
import { DREAM_MODEL, openCore } from "./dream-core.ts";

const [mode, db] = process.argv.slice(2);
if (db === undefined) throw new Error("usage: dream-child.ts answer|resume <db>");
const emit = (record: object) => console.log(JSON.stringify(record));

const soma = await openCore({ db, resume: false });
if (mode === "answer") {
	// Commit observers run before any wait the commit resolves, so the dream task never sees the answer it waits for.
	soma.harness.observeCommits({
		advance({ changes }) {
			for (const change of changes)
				if (change.type === "entry" && change.value.conversationId !== soma.root.id && AssistantEntry.is(change.value))
					process.kill(process.pid, "SIGKILL");
		},
		end() {},
	});
	soma.harness.resume();
	await soma.startDream();
	// A dream that never answers would leave this process running past the test.
	setTimeout(() => process.exit(1), 10_000);
} else if (mode === "resume") {
	// Read before the tasks resume, so it is what the crash left.
	const pinned = await soma.checkpoint();
	soma.harness.resume();
	while (soma.notices().length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
	// Long enough for a second notice of the same window to show.
	await new Promise((resolve) => setTimeout(resolve, 500));
	emit({
		event: "done",
		notices: soma.notices().map((notice) => notice.content),
		dreamCalls: soma.requests.filter((request) => request.model === DREAM_MODEL).length,
		checkpoint: await soma.checkpoint(),
		pinned,
	});
	await soma.close();
} else {
	throw new Error(`unknown mode: ${mode}`);
}
