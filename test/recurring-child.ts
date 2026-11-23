// One side of the recurring schedule's crash tests in test/recurring.test.ts, run twice over one SQLite file:
//   wait <db> <periodMs> <lateMs>     the model sets a rule; report its slot and stay alive until killed
//   answer <db>                       the model sets a rule; once its first fire's answer is stored, and before the
//                                     notice's commit, SIGKILL itself
//   resume <db> <periodMs> <lateMs>   reopen and resume; once a notice is told, report the notices, the fires' model
//                                     calls, the result entries and the conversations the rule's task owns
import { AssistantEntry, type TaskId } from "@earendil-works/pi-durable";
import { context, openCore } from "./recurring-core.ts";

const [mode, db, period = "3600000", late = "60000"] = process.argv.slice(2);
if (db === undefined) throw new Error("usage: recurring-child.ts wait|answer|resume <db> [periodMs] [lateMs]");
const emit = (record: object) => console.log(JSON.stringify(record));
let slots = 0;
// `answer` fires once, soon; the others every `period`.
const nextFire = (_cron: string, after: number) =>
	after + (mode === "answer" ? (++slots === 1 ? 300 : 3_600_000) : Number(period));

const soma = await openCore({ db, nextFire, lateMs: Number(late), resume: false });
const rule = async () => {
	const [[taskId, item] = []] = Object.entries(await soma.rules());
	return { taskId: Number(taskId) as TaskId, next: item?.next };
};
if (mode === "wait") {
	soma.harness.resume();
	await soma.say("每 */2 * * * * 做 報時");
	emit({ event: "armed", ...(await rule()) });
	setTimeout(() => process.exit(1), 20_000);
} else if (mode === "answer") {
	// Commit observers run before any wait the commit resolves, so the task never sees the answer it waits for.
	soma.harness.observeCommits({
		advance({ changes }) {
			for (const change of changes)
				if (change.type === "entry" && change.value.conversationId !== soma.root.id && AssistantEntry.is(change.value))
					process.kill(process.pid, "SIGKILL");
		},
		end() {},
	});
	soma.harness.resume();
	await soma.say("每 */2 * * * * 做 報時");
	setTimeout(() => process.exit(1), 10_000);
} else if (mode === "resume") {
	const { taskId } = await rule();
	// Read before the tasks resume, so it is what the crash left.
	const task = await soma.harness.getTask(taskId, context);
	const pinned = (task?.state as unknown as { checkpoint: object } | undefined)?.checkpoint;
	soma.harness.resume();
	while (soma.notices().length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
	// Long enough for a second notice of the same slot to show.
	await new Promise((resolve) => setTimeout(resolve, 500));
	const owned = [];
	for (const conversation of await soma.owned(taskId))
		owned.push({
			id: conversation.id,
			requests: (await soma.submissions(conversation.id)).map((submission) => submission.requestId),
		});
	emit({
		event: "done",
		taskId,
		pinned,
		notices: soma.notices(),
		fireCalls: soma.requests.filter((request) => request.fire).length,
		results: (await soma.results()).map((entry) => entry.data),
		owned,
	});
	await soma.close();
} else {
	throw new Error(`unknown mode: ${mode}`);
}
