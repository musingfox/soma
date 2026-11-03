import { defineDoc, defineExtension, defineTask } from "@earendil-works/pi-durable";

/** Every time a sleeper woke, written in the same commit that completes the task. */
export const Wakeups = defineDoc<{ log: { taskId: number; until: number; firedAt: number }[] }>({
	kind: "soma.sleeper.wakeups",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ log: [] }),
	checkpointWhen: () => false,
});

export const Sleeper = defineTask<{ until: number }, { phase: "wait"; until: number }, { firedAt: number }>({
	name: "soma.sleeper",
	version: 1,
	initial: ({ until }) => ({ phase: "wait", until }),
	phases: {
		wait: async (task, runtime, context) => {
			const { until } = task.state.checkpoint;
			if (runtime.now() < until) return runtime.sleepUntil(until, task.state.checkpoint, context);
			const firedAt = runtime.now();
			if ((await runtime.memo("announced", context)) === undefined) {
				await runtime.memo("announced", true, context);
				console.log(JSON.stringify({ event: "fired", taskId: task.id, until, firedAt }));
			}
			await runtime.commit(async (tx) => {
				(await tx.doc(Wakeups, runtime.conversationId)).log.push({ taskId: task.id, until, firedAt });
				return { status: "terminal", outcome: { status: "completed", result: { firedAt } } };
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

export const sleeper = defineExtension({ name: "soma.sleeper", tasks: [Sleeper] });
