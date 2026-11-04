import { defineExtension, defineTask, type TaskId } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { JOB_DONE } from "../src/core/extensions/dispatch/bridge.ts";
import { dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { NotImplemented, type ResumeRequest } from "../src/ports/agent.ts";
import { accepted, type Core, context, core, database } from "./defer-core.ts";

// The job the core helper seeds for card-a, and the session id it holds.
const session: ResumeRequest = { name: "card-a", card: "card-a", sessionId: "s-card-a" };
const sent = { status: "completed", result: "sent" };
const instruction = (id: string) => ({
	agent: "card-a",
	text: expect.stringMatching(new RegExp(`^\\[soma deferred instruction ${id}\\] .*: run the tests$`)),
});

/** Resolves once `phase` is the task's checkpoint. */
async function reaches(soma: Core, id: string, phase: string): Promise<void> {
	for (const deadline = Date.now() + 5_000; ; await new Promise((resolve) => setTimeout(resolve, 20))) {
		const task = await soma.harness.getTask(Number(id) as TaskId, context);
		const state = task?.state as { checkpoint?: { phase?: string } } | undefined;
		if (state?.checkpoint?.phase === phase) return;
		expect(Date.now(), `checkpoint ${JSON.stringify(task?.state)}`).toBeLessThan(deadline);
	}
}

/**
 * Stands in for soma dying in a call to the agent side: `reached` resolves once the call is made, and `dead` settles
 * only at `die`, which a test calls once the core is closing, so nothing the run does after the call can commit.
 */
function dying() {
	let reach: () => void = () => {};
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	let kill: (error: Error) => void = () => {};
	const dead = new Promise<never>((_resolve, reject) => {
		kill = reject;
	});
	return { reach, reached, dead, die: () => kill(new Error("soma went down")) };
}

/** Closes `soma` as a crash would end it: the call `death` holds fails only once the core is closing. */
async function crash(soma: Core, death: ReturnType<typeof dying>): Promise<void> {
	const closed = soma.close();
	death.die();
	await closed;
}

test("a reclaimed agent is resumed at fire time in its stored session, and gets the instruction once", {
	timeout: 20_000,
}, async () => {
	const db = await database();
	const agents = new FakeAgentPort();
	agents.emit("card-a", { state: "idle" });
	const soma = await core(db, agents);
	const id = await accepted(await soma.defer("PT1S"));
	expect(agents.stopped).toEqual(["card-a"]);
	expect(await soma.job("card-a")).toMatchObject({ reclaim: { phase: "stopped" } });

	expect(await soma.outcome(id)).toEqual(sent);
	expect(agents.resumed).toEqual([session]);
	expect(agents.prompts).toEqual([instruction(id)]);
	expect(await soma.notices()).toEqual([]);
	// No deferral of the agent is left: it is an open agent like any other.
	expect((await soma.job("card-a"))?.reclaim).toBeUndefined();
	await soma.settle();
	// Host code all the way: the resume and the prompt woke no model.
	expect(soma.faux.state.callCount).toBe(0);
	await soma.close();

	const again = await core(db, agents);
	await again.settle();
	expect(agents.resumed).toHaveLength(1);
	expect(agents.prompts).toHaveLength(1);
	expect(await again.notices()).toEqual([]);
});

test("an agent closed by hand, never reclaimed, is resumed the same way", { timeout: 20_000 }, async () => {
	const agents = new FakeAgentPort();
	agents.emit("card-a", { state: "working" });
	const soma = await core(await database(), agents);
	const id = await accepted(await soma.defer("PT1S"));
	expect(await soma.job("card-a")).toMatchObject({ reclaim: { phase: "due" } });
	agents.close("card-a");

	expect(await soma.outcome(id)).toEqual(sent);
	expect(agents.stopped).toEqual([]);
	expect(agents.resumed).toEqual([session]);
	expect(agents.prompts).toEqual([instruction(id)]);
	expect(await soma.notices()).toEqual([]);
	expect((await soma.job("card-a"))?.reclaim).toBeUndefined();
});

test("a hangar whose cap is full does not hold the resume back", { timeout: 20_000 }, async () => {
	const agents = new (class extends FakeAgentPort {
		override async start(): Promise<void> {
			throw new Error("hangar is full: 4 of 4 agents running");
		}
	})();
	agents.emit("card-a", { state: "idle" });
	const soma = await core(await database(), agents);
	const id = await accepted(await soma.defer("PT1S"));

	expect(await soma.outcome(id)).toEqual(sent);
	expect(agents.started).toEqual([]);
	expect(agents.resumed).toEqual([session]);
	expect(agents.prompts).toEqual([instruction(id)]);
});

test("the bridge takes the resumed window's statuses: its turn is recorded, though soma had stopped the agent", {
	timeout: 20_000,
}, async () => {
	const agents = new FakeAgentPort();
	agents.emit("card-a", { state: "working" });
	const soma = await core(await database(), agents);
	// Its launch turn ends on record, as a dispatched agent's does, and it defers at rest, so it is stopped at once.
	agents.finish("card-a", "結果：完成");
	await soma.settle();
	const id = await accepted(await soma.defer("PT1S"));
	expect(agents.stopped).toEqual(["card-a"]);
	expect(await soma.outcome(id)).toEqual(sent);
	await soma.settle();
	expect(await soma.job("card-a")).toMatchObject({ status: { state: "working" } });

	agents.finish("card-a", "結果：需要你");
	await soma.settle();
	expect(await soma.job("card-a")).toMatchObject({ status: { state: "done" }, outcome: "需要你" });
	const entries = (await soma.root.entries({ order: "ascending" }, 1000, undefined, context)).items;
	// The idle the resumed claude came up in is no turn: its transcript ends where the launch turn left it.
	expect(entries.filter((entry) => entry.kind === JOB_DONE).map((entry) => entry.data)).toEqual([
		expect.objectContaining({ agent: "card-a", outcome: "完成" }),
		expect.objectContaining({ agent: "card-a", outcome: "需要你", notified: true }),
	]);
});

test("a resumed agent that defers again is reclaimed again once its turn ends", { timeout: 20_000 }, async () => {
	const agents = new FakeAgentPort();
	agents.emit("card-a", { state: "idle" });
	const soma = await core(await database(), agents);
	const id = await accepted(await soma.defer("PT1S"));
	expect(await soma.outcome(id)).toEqual(sent);
	expect(agents.stopped).toEqual(["card-a"]);

	// At work on the instruction, as an agent running `soma defer` is.
	await accepted(await soma.defer("PT1H"));
	expect(await soma.job("card-a")).toMatchObject({ reclaim: { phase: "due" } });
	agents.finish("card-a", "結果：完成");
	await soma.settle();
	expect(agents.stopped).toEqual(["card-a", "card-a"]);
	expect(await soma.job("card-a")).toMatchObject({ reclaim: { phase: "stopped" } });
});

test("two deferrals that fall due together each send their instruction once, the second waiting out the first's start", {
	timeout: 20_000,
}, async () => {
	const agents = new FakeAgentPort();
	agents.emit("card-a", { state: "idle" });
	const soma = await core(await database(), agents, { retryMs: 300 });
	const first = await accepted(await soma.defer("PT1S"));
	const second = await accepted(await soma.defer("PT1S"));

	expect([await soma.outcome(first), await soma.outcome(second)]).toEqual([sent, sent]);
	// No second start while the first holds the job. One start in all only because this agent never ends the turn the
	// first instruction began: one that does is at rest with the second pending, so it is reclaimed and started again.
	expect(agents.resumed).toEqual([session]);
	expect(agents.prompts).toEqual(expect.arrayContaining([instruction(first), instruction(second)]));
	expect(agents.prompts).toHaveLength(2);
	expect(await soma.notices()).toEqual([]);
});

test("a crash in the start, before its window was made, starts the agent once at restart and sends once", {
	timeout: 20_000,
}, async () => {
	const db = await database();
	const death = dying();
	// soma dies while the start is under way, before rex made the window.
	const dead = new (class extends FakeAgentPort {
		override resume(request: ResumeRequest): Promise<void> {
			this.resumed.push(request);
			death.reach();
			return death.dead;
		}
	})();
	dead.emit("card-a", { state: "idle" });
	const first = await core(db, dead);
	const id = await accepted(await first.defer("PT1S"));
	await death.reached;
	expect(await first.job("card-a")).toMatchObject({ reclaim: { phase: "resuming" } });
	await crash(first, death);

	const agents = new FakeAgentPort();
	for (let restart = 0; restart < 2; restart++) {
		const soma = await core(db, agents);
		expect(await soma.outcome(id)).toEqual(sent);
		await soma.settle();
		expect(agents.resumed).toEqual([session]);
		expect(agents.prompts).toEqual([instruction(id)]);
		// The reconcile ran while the agent was not listed yet: a job being resumed is no vanished agent.
		expect(await soma.notices()).toEqual([]);
		await soma.close();
	}
	expect(dead.prompts).toEqual([]);
});

test("a crash in the start, after its window was made, starts nothing at restart and sends once", {
	timeout: 20_000,
}, async () => {
	const db = await database();
	const death = dying();
	// rex made the window, and soma died before the start returned.
	const dead = new (class extends FakeAgentPort {
		override resume(request: ResumeRequest): Promise<void> {
			this.resumed.push(request);
			this.emit(request.name, { state: "idle" });
			death.reach();
			return death.dead;
		}
	})();
	dead.emit("card-a", { state: "idle" });
	const first = await core(db, dead);
	const id = await accepted(await first.defer("PT1S"));
	await death.reached;
	await crash(first, death);

	const agents = new FakeAgentPort();
	agents.emit("card-a", { state: "idle" });
	for (let restart = 0; restart < 2; restart++) {
		const soma = await core(db, agents);
		expect(await soma.outcome(id)).toEqual(sent);
		await soma.settle();
		expect(agents.resumed).toEqual([]);
		expect(agents.prompts).toEqual([instruction(id)]);
		expect(await soma.notices()).toEqual([]);
		await soma.close();
	}
	expect(dead.resumed).toEqual([session]);
	expect(dead.prompts).toEqual([]);
});

test("a deferral that faulted while it held its job resuming holds back no later deferral of the agent", {
	timeout: 20_000,
}, async () => {
	const db = await database();
	const death = dying();
	const dead = new (class extends FakeAgentPort {
		override resume(request: ResumeRequest): Promise<void> {
			this.resumed.push(request);
			death.reach();
			return death.dead;
		}
	})();
	dead.emit("card-a", { state: "idle" });
	const first = await core(db, dead);
	const faulted = await accepted(await first.defer("PT1S"));
	await death.reached;
	await crash(first, death);

	// A rollback to a release whose deferral has no `resuming` phase: the task faults, holding the job.
	const old = defineTask<object, { phase: "wait" | "sending" }, string>({
		name: "soma.defer",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: { wait: async () => {}, sending: async () => {} },
		abort: async () => {},
	});
	const rolledBack = await openHarness(
		db,
		[dispatchExtension(new FakeAgentPort(), async () => ""), defineExtension({ name: "soma.defer", tasks: [old] })],
		context,
	);
	rolledBack.resume();
	expect((await rolledBack.waitForTask(Number(faulted) as TaskId, context)).state.outcome).toMatchObject({
		status: "faulted",
	});
	await rolledBack.close(context);

	const agents = new FakeAgentPort();
	const soma = await core(db, agents, { retryMs: 100, tries: 3 });
	expect(await soma.job("card-a")).toMatchObject({ reclaim: { phase: "resuming" } });
	const id = await accepted(await soma.defer("PT1S"));
	expect(await soma.outcome(id)).toEqual(sent);
	expect(agents.resumed).toEqual([session]);
	expect(agents.prompts).toEqual([instruction(id)]);
	expect((await soma.job("card-a"))?.reclaim).toBeUndefined();
});

test("a crash while the resumed agent is not ready yet starts nothing at restart and sends once it is", {
	timeout: 20_000,
}, async () => {
	const db = await database();
	// The window is up, and claude is not at rest yet when soma dies.
	const dead = new (class extends FakeAgentPort {
		override async resume(request: ResumeRequest): Promise<void> {
			this.resumed.push(request);
			this.emit(request.name, { state: "working" });
		}
	})();
	dead.emit("card-a", { state: "idle" });
	const first = await core(db, dead, { pollMs: 50 });
	const id = await accepted(await first.defer("PT1S"));
	await reaches(first, id, "ready");
	await new Promise((resolve) => setTimeout(resolve, 200));
	await first.close();
	expect(dead.prompts).toEqual([]);

	const agents = new FakeAgentPort();
	agents.emit("card-a", { state: "idle" });
	for (let restart = 0; restart < 2; restart++) {
		const soma = await core(db, agents, { pollMs: 50 });
		expect(await soma.outcome(id)).toEqual(sent);
		await soma.settle();
		expect(agents.resumed).toEqual([]);
		expect(agents.prompts).toEqual([instruction(id)]);
		expect(await soma.notices()).toEqual([]);
		await soma.close();
	}
	expect(dead.resumed).toEqual([session]);
});

test("a crash while the instruction goes to the resumed agent sends nothing more, starts nothing, and tells once", {
	timeout: 20_000,
}, async () => {
	const db = await database();
	const death = dying();
	// The window is up and claude at rest; soma dies while the prompt goes out.
	const dead = new (class extends FakeAgentPort {
		override prompt(agent: string, text: string): Promise<void> {
			this.prompts.push({ agent, text });
			death.reach();
			return death.dead;
		}
	})();
	dead.emit("card-a", { state: "idle" });
	const first = await core(db, dead);
	const id = await accepted(await first.defer("PT1S"));
	await death.reached;
	expect(await first.job("card-a")).toMatchObject({ reclaim: { phase: "sending" } });
	await crash(first, death);

	const agents = new FakeAgentPort();
	agents.emit("card-a", { state: "working" });
	for (let restart = 0; restart < 2; restart++) {
		const soma = await core(db, agents);
		expect(await soma.outcome(id)).toEqual({ status: "completed", result: "unsure" });
		await soma.settle();
		expect(await soma.notices()).toEqual([
			expect.stringMatching(new RegExp(`^Deferred instruction ${id} .*may not have reached the agent`)),
		]);
		await soma.close();
	}
	expect(dead.resumed).toEqual([session]);
	expect(dead.prompts).toEqual([instruction(id)]);
	expect(agents.resumed).toEqual([]);
	expect(agents.prompts).toEqual([]);
});

test.each([
	[
		"its worktree is gone",
		"the worktree /repo/.claude/worktrees/card-a claude session s-card-a ran in no longer exists",
	],
	["the start fails", "rex connection lost"],
])(
	"an agent that cannot be started again because %s is not prompted, and the human is told once",
	{
		timeout: 20_000,
	},
	async (_case, error) => {
		const db = await database();
		const agents = new (class extends FakeAgentPort {
			override async resume(request: ResumeRequest): Promise<void> {
				this.resumed.push(request);
				throw new Error(error);
			}
		})();
		agents.emit("card-a", { state: "idle" });
		const soma = await core(db, agents);
		const id = await accepted(await soma.defer("PT1S"));

		expect(await soma.outcome(id)).toEqual({ status: "completed", result: "unresumed" });
		expect(agents.resumed).toEqual([session]);
		expect(agents.prompts).toEqual([]);
		const told = [
			expect.stringMatching(
				new RegExp(
					`^Deferred instruction ${id} .* was not sent: .*could not start it again: ${error}\\. .*run the tests$`,
				),
			),
		];
		expect(await soma.notices()).toEqual(told);
		// Still gone, as soma stopped it: no reconcile takes it for a vanished agent.
		expect(await soma.job("card-a")).toMatchObject({ reclaim: { phase: "stopped" } });
		await soma.close();

		const again = await core(db, agents);
		await again.settle();
		expect(await again.notices()).toEqual(told);
		expect(agents.resumed).toHaveLength(1);
	},
);

test("an agent closed by hand that cannot be started again is no longer due, and a window reopened later is seen", {
	timeout: 20_000,
}, async () => {
	const agents = new (class extends FakeAgentPort {
		override async resume(request: ResumeRequest): Promise<void> {
			this.resumed.push(request);
			throw new Error("rex connection lost");
		}
	})();
	agents.emit("card-a", { state: "working" });
	const soma = await core(await database(), agents);
	const id = await accepted(await soma.defer("PT1S"));
	expect(await soma.job("card-a")).toMatchObject({ reclaim: { phase: "due" } });
	agents.close("card-a");

	expect(await soma.outcome(id)).toEqual({ status: "completed", result: "unresumed" });
	expect(await soma.notices()).toEqual([
		expect.stringMatching(new RegExp(`^Deferred instruction ${id} .* was not sent: .*could not start it again`)),
	]);
	// soma never stopped it, so it is not taken for one soma stopped.
	expect((await soma.job("card-a"))?.reclaim).toBeUndefined();
	agents.emit("card-a", { state: "working" });
	agents.finish("card-a", "結果：完成");
	await soma.settle();
	expect(await soma.job("card-a")).toMatchObject({ status: { state: "done" }, outcome: "完成" });
});

test.each([
	["closed by hand", "working", undefined],
	["reclaimed", "idle", { phase: "stopped" }],
])(
	"an agent %s on a side that cannot resume one takes the gone path, as before resuming was built",
	{
		timeout: 20_000,
	},
	async (_case, state, reclaim) => {
		const agents = new (class extends FakeAgentPort {
			override async resume(): Promise<void> {
				throw new NotImplemented("tty AgentPort: resume is not implemented");
			}
		})();
		agents.emit("card-a", { state: state as "idle" | "working" });
		const soma = await core(await database(), agents);
		const id = await accepted(await soma.defer("PT1S"));
		agents.close("card-a");

		expect(await soma.outcome(id)).toEqual({ status: "completed", result: "gone" });
		expect(agents.prompts).toEqual([]);
		expect(await soma.notices()).toEqual([
			expect.stringMatching(new RegExp(`^Deferred instruction ${id} .* was not sent: the agent was no longer listed`)),
		]);
		expect((await soma.job("card-a"))?.reclaim).toEqual(reclaim);
	},
);

test("a start that made the window and lost its connection, the listing after it failing too, prompts that window", {
	timeout: 20_000,
}, async () => {
	// rex made the window, then the connection dropped, and the next listing met the same dropped connection.
	const agents = new (class extends FakeAgentPort {
		failing = 0;
		override async list() {
			if (this.failing > 0) {
				this.failing--;
				throw new Error("rex connection lost");
			}
			return super.list();
		}
		override async resume(request: ResumeRequest): Promise<void> {
			this.resumed.push(request);
			this.emit(request.name, { state: "idle" });
			this.failing = 1;
			throw new Error("rex connection lost");
		}
	})();
	agents.emit("card-a", { state: "idle" });
	const soma = await core(await database(), agents, { pollMs: 50 });
	const id = await accepted(await soma.defer("PT1S"));

	expect(await soma.outcome(id)).toEqual(sent);
	expect(agents.resumed).toEqual([session]);
	expect(agents.prompts).toEqual([instruction(id)]);
	expect(await soma.notices()).toEqual([]);
	// Not left `stopped`, which would have the bridge drop the statuses of the window that is open.
	expect((await soma.job("card-a"))?.reclaim).toBeUndefined();
});

test("listings that fail past the start's deadline do not take an open window for none", {
	timeout: 20_000,
}, async () => {
	// The fire-time listing finds the agent gone; the human reopens its window just after it, and rex stops answering
	// past the deadline the start has to list the agent.
	const agents = new (class extends FakeAgentPort {
		failUntil = 0;
		override async list() {
			if (Date.now() < this.failUntil) throw new Error("rex connection lost");
			const listed = await super.list();
			if (this.stopped.length > 0 && this.failUntil === 0) {
				this.emit("card-a", { state: "idle" });
				this.failUntil = Date.now() + 600;
			}
			return listed;
		}
	})();
	agents.emit("card-a", { state: "idle" });
	const soma = await core(await database(), agents, { readyMs: 400, pollMs: 50 });
	const id = await accepted(await soma.defer("PT1S"));

	expect(await soma.outcome(id)).toEqual(sent);
	expect(agents.resumed).toEqual([]);
	expect(agents.prompts).toEqual([instruction(id)]);
	expect(await soma.notices()).toEqual([]);
	expect((await soma.job("card-a"))?.reclaim).toBeUndefined();
});

test("a window of the agent's name the human reopened is prompted in place, and nothing is started", {
	timeout: 20_000,
}, async () => {
	const agents = new FakeAgentPort();
	agents.emit("card-a", { state: "idle" });
	const soma = await core(await database(), agents);
	const id = await accepted(await soma.defer("PT1S"));
	expect(agents.stopped).toEqual(["card-a"]);
	agents.emit("card-a", { state: "idle" });

	expect(await soma.outcome(id)).toEqual(sent);
	expect(agents.resumed).toEqual([]);
	expect(agents.prompts).toEqual([instruction(id)]);
	expect(await soma.notices()).toEqual([]);
	expect((await soma.job("card-a"))?.reclaim).toBeUndefined();
	// No longer stopped, so the bridge records the turn the instruction started.
	agents.finish("card-a", "結果：完成");
	await soma.settle();
	expect(await soma.job("card-a")).toMatchObject({ status: { state: "done" }, outcome: "完成" });
});

test("a window of the agent's name opened while the start was under way is prompted, and the start makes no second", {
	timeout: 20_000,
}, async () => {
	// The adapter lists the name again just before it makes a window, and refuses: the human got there first.
	const agents = new (class extends FakeAgentPort {
		override async resume(request: ResumeRequest): Promise<void> {
			this.resumed.push(request);
			this.emit(request.name, { state: "idle" });
			throw new Error(`rex hangar session:hangar already has a window named ${request.name}`);
		}
	})();
	agents.emit("card-a", { state: "idle" });
	const soma = await core(await database(), agents);
	const id = await accepted(await soma.defer("PT1S"));

	expect(await soma.outcome(id)).toEqual(sent);
	expect(agents.resumed).toEqual([session]);
	expect(agents.prompts).toEqual([instruction(id)]);
	expect(await soma.notices()).toEqual([]);
});

test("a resumed agent not ready in time is left open, not prompted, and the human is told once", {
	timeout: 20_000,
}, async () => {
	const agents = new (class extends FakeAgentPort {
		override async resume(request: ResumeRequest): Promise<void> {
			this.resumed.push(request);
			this.emit(request.name, { state: "working" });
		}
	})();
	agents.emit("card-a", { state: "idle" });
	const soma = await core(await database(), agents, { readyMs: 500, pollMs: 50 });
	const id = await accepted(await soma.defer("PT1S"));

	expect(await soma.outcome(id)).toEqual({ status: "completed", result: "failed" });
	expect(agents.prompts).toEqual([]);
	expect(await soma.notices()).toEqual([
		expect.stringMatching(new RegExp(`^Deferred instruction ${id} .* was not sent: .*not ready .*working`)),
	]);
	expect(agents.stopped).toEqual(["card-a"]);
	expect((await soma.job("card-a"))?.reclaim).toBeUndefined();
	expect((await agents.list()).map((each) => each.name)).toEqual(["card-a"]);
});

test("listings that fail until past the ready deadline decide nothing: the first that answers does", {
	timeout: 20_000,
}, async () => {
	// The window is up at rest, and rex answers no listing until the wait for it to be ready is over.
	const agents = new (class extends FakeAgentPort {
		failUntil = 0;
		override async list() {
			if (Date.now() < this.failUntil) throw new Error("rex connection lost");
			return super.list();
		}
		override async resume(request: ResumeRequest): Promise<void> {
			this.resumed.push(request);
			this.emit(request.name, { state: "idle" });
			this.failUntil = Date.now() + 600;
		}
	})();
	agents.emit("card-a", { state: "idle" });
	const soma = await core(await database(), agents, { readyMs: 300, pollMs: 50 });
	const id = await accepted(await soma.defer("PT1S"));

	expect(await soma.outcome(id)).toEqual(sent);
	expect(agents.resumed).toEqual([session]);
	expect(agents.prompts).toEqual([instruction(id)]);
	expect(await soma.notices()).toEqual([]);
});

test("a resumed window that closes before the instruction goes is not prompted, and the human is told once", {
	timeout: 20_000,
}, async () => {
	const agents = new (class extends FakeAgentPort {
		override async resume(request: ResumeRequest): Promise<void> {
			this.resumed.push(request);
			this.emit(request.name, { state: "working" });
			setTimeout(() => this.close(request.name), 200);
		}
	})();
	agents.emit("card-a", { state: "idle" });
	const soma = await core(await database(), agents, { pollMs: 50 });
	const id = await accepted(await soma.defer("PT1S"));

	expect(await soma.outcome(id)).toEqual({ status: "completed", result: "gone" });
	expect(agents.prompts).toEqual([]);
	expect(await soma.notices()).toEqual([
		expect.stringMatching(new RegExp(`^Deferred instruction ${id} .* was not sent: .*window closed`)),
	]);
	expect(await soma.job("card-a")).toMatchObject({ reclaim: { phase: "stopped" } });
});
