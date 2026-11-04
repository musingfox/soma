import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import type { Job } from "../src/core/domain/dispatch.ts";
import { type DeferOptions, Deferrals, deferExtension } from "../src/core/extensions/defer/index.ts";
import { eventBridge, reconcileDispatches } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { NOTICE } from "../src/core/notice.ts";
import { PromptRefused } from "../src/ports/agent.ts";

const context = BACKGROUND_CONTEXT;
const jobOf = (card: string): Job => ({
	card,
	agent: card,
	sessionId: `s-${card}`,
	status: { state: "idle" },
	decisions: [],
});
const open: (() => Promise<void>)[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const close of open.splice(0)) await close();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function database() {
	const directory = await mkdtemp(join(tmpdir(), "soma-reclaim-"));
	directories.push(directory);
	return join(directory, "soma.sqlite");
}

/**
 * One core process as main.ts starts it: tasks resumed, the dispatch list (seeded with a job for each agent listed
 * that has none yet) reconciled with the agents listed, then the event bridge fed every status. A faux model answers
 * a woken block.
 */
async function core(db: string, agents: FakeAgentPort, options: DeferOptions = {}) {
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("好。")));
	const models = createModels();
	models.setProvider(faux.provider);
	const defers = deferExtension(agents, options);
	const harness: Harness = await openHarness(
		db,
		[dispatchExtension(agents, async () => ""), defers.extension],
		context,
		{ models },
	);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const listed = (await agents.list()).map((each) => each.name);
	await root.commit(async (tx) => {
		const doc = await tx.doc(Dispatches, root.id);
		for (const card of listed) {
			if (!doc.jobs.some((each) => each.card === card)) doc.jobs.push(jobOf(card));
		}
	}, context);
	await reconcileDispatches(root, agents, context);
	const bridge = eventBridge(root, agents, context);
	const handled: Promise<void>[] = [];
	const off = agents.onStatus((event) => handled.push(bridge.handle(event)));
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		off();
		await harness.close(context);
	};
	open.push(close);
	return {
		harness,
		root,
		close,
		settle: async () => {
			for (let seen = -1; seen !== handled.length; ) {
				seen = handled.length;
				await Promise.all(handled);
			}
			await root.waitForIdle(context);
		},
		defer: (at: string, card = "card-a") =>
			defers.defer(root, { agent: card, at, instruction: "run the tests" }, context),
		job: async (card: string) =>
			(await harness.snapshot(Dispatches, root.id, context))?.jobs.find((each) => each.card === card),
		notices: async () =>
			(await root.entries({ order: "ascending" }, 1000, undefined, context)).items
				.filter((entry) => entry.kind === NOTICE)
				.map((entry) => (entry.data as { content: string }).content),
		outcome: async (id: string) => (await harness.waitForTask(Number(id) as TaskId, context)).state.outcome,
	};
}

async function accepted(reply: Awaited<ReturnType<Awaited<ReturnType<typeof core>>["defer"]>>) {
	if (!reply.accepted) throw new Error(reply.reason);
	return reply.id;
}

test("an agent that defers mid-turn is stopped once, when the turn ends", async () => {
	const agents = new FakeAgentPort();
	agents.emit("card-a", { state: "working" });
	const soma = await core(await database(), agents);

	await accepted(await soma.defer("PT1H"));
	await soma.settle();
	expect(agents.stopped).toEqual([]);
	expect(await soma.job("card-a")).toMatchObject({ reclaim: { phase: "due" } });

	agents.finish("card-a", "結果：完成");
	await soma.settle();
	expect(agents.stopped).toEqual(["card-a"]);
	expect(await soma.job("card-a")).toMatchObject({ status: { state: "done" }, reclaim: { phase: "stopped" } });

	// The end re-stamped, and the done settling into idle, as rex reports them: no second stop.
	agents.emit("card-a", { state: "done" });
	agents.emit("card-a", { state: "idle" });
	await soma.settle();
	expect(agents.stopped).toEqual(["card-a"]);
});

test("an agent already idle when its defer is accepted is stopped once, before the reply", async () => {
	const agents = new FakeAgentPort();
	agents.emit("card-a", { state: "idle" });
	const soma = await core(await database(), agents);

	await accepted(await soma.defer("PT1H"));
	expect(agents.stopped).toEqual(["card-a"]);
	expect(await soma.job("card-a")).toMatchObject({ reclaim: { phase: "stopped" } });

	await accepted(await soma.defer("PT2H"));
	agents.emit("card-a", { state: "idle" });
	await soma.settle();
	expect(agents.stopped).toEqual(["card-a"]);
});

test("an agent that never deferred is not stopped when its turn ends; one that deferred is", async () => {
	const agents = new FakeAgentPort();
	agents.emit("card-a", { state: "working" });
	agents.emit("card-b", { state: "working" });
	const db = await database();
	const soma = await core(db, agents);

	await accepted(await soma.defer("PT1H", "card-a"));
	agents.finish("card-a", "結果：完成");
	agents.finish("card-b", "結果：完成");
	agents.emit("card-b", { state: "idle" });
	await soma.settle();
	await soma.close();
	await (await core(db, agents)).settle();

	expect(agents.stopped).toEqual(["card-a"]);
});

test("an agent with a deferral pending is not stopped while working or blocked, only once at rest", async () => {
	const agents = new FakeAgentPort();
	agents.emit("card-a", { state: "working" });
	const soma = await core(await database(), agents);
	await accepted(await soma.defer("PT1H"));

	agents.emit("card-a", { state: "blocked", kind: "permission", msg: "approve Bash: ls", fingerprint: "f-1" });
	await soma.settle();
	expect(agents.stopped).toEqual([]);
	agents.emit("card-a", { state: "working" });
	await soma.settle();
	expect(agents.stopped).toEqual([]);
	agents.finish("card-a", "結果：完成");
	await soma.settle();
	expect(agents.stopped).toEqual(["card-a"]);
});

test("an idle report the agent has already left behind does not stop it", async () => {
	// The listing is read fresh: the human typed into the agent after the idle it reported.
	const agents = new (class extends FakeAgentPort {
		busy = false;
		override async list() {
			const listed = await super.list();
			return this.busy ? listed.map((each) => ({ ...each, status: { state: "working" as const } })) : listed;
		}
	})();
	agents.emit("card-a", { state: "working" });
	const soma = await core(await database(), agents);
	await accepted(await soma.defer("PT1H"));

	agents.busy = true;
	agents.finish("card-a", "結果：完成");
	await soma.settle();
	expect(agents.stopped).toEqual([]);
	expect(await soma.job("card-a")).toMatchObject({ reclaim: { phase: "due" } });

	agents.busy = false;
	agents.emit("card-a", { state: "idle" });
	await soma.settle();
	expect(agents.stopped).toEqual(["card-a"]);
});

test("a restart between the defer and the idle still stops the agent once, and tells of no vanished agent", {
	timeout: 20_000,
}, async () => {
	const db = await database();
	const agents = new FakeAgentPort();
	agents.emit("card-a", { state: "working" });
	const first = await core(db, agents);
	await accepted(await first.defer("PT1H"));
	await first.close();
	// The turn ends while soma is down.
	agents.finish("card-a", "結果：完成");
	expect(agents.stopped).toEqual([]);

	for (let restart = 0; restart < 2; restart++) {
		const soma = await core(db, agents);
		await soma.settle();
		expect(agents.stopped).toEqual(["card-a"]);
		expect(await soma.job("card-a")).toMatchObject({ status: { state: "done" }, reclaim: { phase: "stopped" } });
		expect(await soma.notices()).toEqual([]);
		await soma.close();
	}
});

test("a restart after soma committed the stop but before it went out stops the agent once", {
	timeout: 20_000,
}, async () => {
	const db = await database();
	let reached: () => void = () => {};
	const stopping = new Promise<void>((resolve) => {
		reached = resolve;
	});
	// Stands in for soma dying before the stop reached rex: it never settles and does nothing.
	const dying = new (class extends FakeAgentPort {
		override stop(): Promise<void> {
			reached();
			return new Promise(() => {});
		}
	})();
	dying.emit("card-a", { state: "idle" });
	const first = await core(db, dying);
	void first.defer("PT1H");
	await stopping;
	await first.close();

	const agents = new FakeAgentPort();
	agents.emit("card-a", { state: "idle" });
	for (let restart = 0; restart < 2; restart++) {
		const soma = await core(db, agents);
		await soma.settle();
		expect(agents.stopped).toEqual(["card-a"]);
		expect(await soma.job("card-a")).toMatchObject({ reclaim: { phase: "stopped" } });
		expect(await soma.notices()).toEqual([]);
		await soma.close();
	}
});

test("a restart after the stop went out but before soma recorded it tells of no vanished agent", {
	timeout: 20_000,
}, async () => {
	const db = await database();
	let reached: () => void = () => {};
	const stopped = new Promise<void>((resolve) => {
		reached = resolve;
	});
	// The window closes, then soma dies before the commit that records it.
	const dying = new (class extends FakeAgentPort {
		override async stop(agent: string): Promise<void> {
			await super.stop(agent);
			reached();
			return new Promise(() => {});
		}
	})();
	dying.emit("card-a", { state: "idle" });
	const first = await core(db, dying);
	void first.defer("PT1H");
	await stopped;
	await first.close();

	for (let restart = 0; restart < 2; restart++) {
		const agents = new FakeAgentPort();
		const soma = await core(db, agents);
		await soma.settle();
		expect(agents.stopped).toEqual([]);
		expect(await soma.job("card-a")).toMatchObject({ status: { state: "idle" }, reclaim: { phase: "stopped" } });
		expect(await soma.notices()).toEqual([]);
		await soma.close();
	}
});

test("a reclaimed agent is no vanished agent, live or after a restart", { timeout: 20_000 }, async () => {
	const db = await database();
	const agents = new FakeAgentPort();
	agents.emit("card-a", { state: "working" });
	// Stopped while idle, which a reconcile would take for an unfinished job gone.
	agents.emit("card-b", { state: "idle" });
	const first = await core(db, agents);
	await accepted(await first.defer("PT1H", "card-a"));
	await accepted(await first.defer("PT1H", "card-b"));
	agents.finish("card-a", "結果：完成");
	await first.settle();
	expect(agents.stopped).toEqual(["card-b", "card-a"]);
	// What a closing window might still report is no news.
	agents.emit("card-a", { state: "error", msg: "claude exited" });
	await first.settle();
	const reclaimed = async (soma: Awaited<ReturnType<typeof core>>) => {
		expect(await soma.job("card-a")).toMatchObject({ status: { state: "done" }, reclaim: { phase: "stopped" } });
		expect(await soma.job("card-b")).toMatchObject({ status: { state: "idle" }, reclaim: { phase: "stopped" } });
		expect(await soma.notices()).toEqual([]);
	};
	await reclaimed(first);
	await first.close();

	for (let restart = 0; restart < 2; restart++) {
		const soma = await core(db, new FakeAgentPort());
		await soma.settle();
		await reclaimed(soma);
		await soma.close();
	}
});

test("a deferral that falls due after its agent was stopped tells the human once", { timeout: 20_000 }, async () => {
	const db = await database();
	const agents = new FakeAgentPort();
	agents.emit("card-a", { state: "idle" });
	const soma = await core(db, agents);

	const id = await accepted(await soma.defer("PT1S"));
	expect(agents.stopped).toEqual(["card-a"]);
	expect(await soma.outcome(id)).toEqual({ status: "completed", result: "gone" });
	expect(agents.prompts).toEqual([]);
	expect(await soma.notices()).toEqual([expect.stringMatching(new RegExp(`^Deferred instruction ${id} .*not sent`))]);
	await soma.close();

	const again = await core(db, agents);
	await again.settle();
	expect(await again.notices()).toHaveLength(1);
	expect(agents.stopped).toEqual(["card-a"]);
});

test("an agent that got its deferred instruction while still open is not stopped when that turn ends", {
	timeout: 20_000,
}, async () => {
	const agents = new FakeAgentPort();
	agents.emit("card-a", { state: "working" });
	const soma = await core(await database(), agents);
	const id = await accepted(await soma.defer("PT1S"));
	expect(await soma.job("card-a")).toMatchObject({ reclaim: { phase: "due" } });

	expect(await soma.outcome(id)).toEqual({ status: "completed", result: "sent" });
	expect((await soma.job("card-a"))?.reclaim).toBeUndefined();
	agents.finish("card-a", "結果：完成");
	await soma.settle();
	expect(agents.stopped).toEqual([]);
});

test("a stop that fails tells the human once and is not tried again; a stop that failed after closing counts", {
	timeout: 20_000,
}, async () => {
	const db = await database();
	const tried: string[] = [];
	const agents = new (class extends FakeAgentPort {
		closes = false;
		override async stop(agent: string): Promise<void> {
			tried.push(agent);
			if (this.closes) await super.stop(agent);
			throw new Error(`rex hangar has no window named ${agent}`);
		}
	})();
	agents.emit("card-a", { state: "idle" });
	agents.emit("card-b", { state: "idle" });
	const soma = await core(db, agents);

	await accepted(await soma.defer("PT1H", "card-a"));
	expect(tried).toEqual(["card-a"]);
	expect(await soma.job("card-a")).toMatchObject({
		reclaim: { phase: "failed", error: expect.stringMatching(/no window/) },
	});
	expect(await soma.notices()).toEqual([expect.stringMatching(/^soma could not stop agent card-a \(card card-a\)/)]);
	agents.emit("card-a", { state: "idle" });
	await soma.settle();
	await soma.close();
	const again = await core(db, agents);
	await again.settle();
	expect(tried).toEqual(["card-a"]);
	expect(await again.notices()).toHaveLength(1);

	agents.closes = true;
	await accepted(await again.defer("PT1H", "card-b"));
	expect(tried).toEqual(["card-a", "card-b"]);
	expect(await again.job("card-b")).toMatchObject({ reclaim: { phase: "stopped" } });
	expect(await again.notices()).toHaveLength(1);
});

test("an idle reported after the deferred prompt was typed does not stop the agent; a deferral still pending re-arms it", {
	timeout: 20_000,
}, async () => {
	// The prompt is typed, then the agent's last idle is reported, and the listing still shows it idle: a reclaim that
	// ran now would close the window over the instruction.
	const agents = new (class extends FakeAgentPort {
		override async prompt(agent: string, text: string): Promise<void> {
			this.prompts.push({ agent, text });
			this.emit(agent, { state: "idle" });
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
	})();
	agents.emit("card-a", { state: "working" });
	const soma = await core(await database(), agents);
	const id = await accepted(await soma.defer("PT1S"));
	await accepted(await soma.defer("PT1H"));

	expect(await soma.outcome(id)).toEqual({ status: "completed", result: "sent" });
	await soma.settle();
	expect(agents.prompts).toHaveLength(1);
	expect(agents.stopped).toEqual([]);
	expect(await soma.notices()).toEqual([]);
	expect(await soma.job("card-a")).toMatchObject({ reclaim: { phase: "due" } });

	// The turn the instruction started ends: the deferral still pending stops it then.
	agents.finish("card-a", "結果：完成");
	await soma.settle();
	expect(agents.stopped).toEqual(["card-a"]);
});

test("a deferred prompt refused before it typed holds the job no longer: an idle while it waits stops the agent", {
	timeout: 20_000,
}, async () => {
	const agents = new (class extends FakeAgentPort {
		tried = 0;
		override async prompt(): Promise<void> {
			this.tried++;
			throw new PromptRefused("rex agent card-a is working: a prompt goes only to idle or done");
		}
	})();
	agents.emit("card-a", { state: "working" });
	const soma = await core(await database(), agents, { retryMs: 1_000 });
	const id = await accepted(await soma.defer("PT1S"));
	for (
		const deadline = Date.now() + 5_000;
		(await soma.job("card-a"))?.reclaim?.phase !== "due" || agents.tried === 0;
	) {
		expect(Date.now()).toBeLessThan(deadline);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}

	agents.emit("card-a", { state: "idle" });
	await soma.settle();
	expect(agents.stopped).toEqual(["card-a"]);
	expect(await soma.outcome(id)).toEqual({ status: "completed", result: "gone" });
	expect(agents.tried).toBe(1);
});

test("a deferral that falls due while soma is down mid-stop tells what is known, and leaves no stop for later", {
	timeout: 20_000,
}, async () => {
	const db = await database();
	let reached: () => void = () => {};
	const stopping = new Promise<void>((resolve) => {
		reached = resolve;
	});
	// soma dies after committing `stopping`, before the stop reaches rex.
	const dying = new (class extends FakeAgentPort {
		override stop(): Promise<void> {
			reached();
			return new Promise(() => {});
		}
	})();
	dying.emit("card-a", { state: "idle" });
	const first = await core(db, dying);
	// The reply never comes: the defer waits on that stop.
	void first.defer("PT1S");
	await stopping;
	const [id = ""] = Object.keys((await first.harness.snapshot(Deferrals, first.root.id, context))?.items ?? {});
	await first.close();
	await new Promise((resolve) => setTimeout(resolve, 1_200));

	// The agent was never stopped and is at work again. Its listing comes late, so the deferral, due already, runs
	// before the reconcile, as it may at any start.
	const agents = new (class extends FakeAgentPort {
		late = true;
		override async list() {
			if (this.late) await new Promise((resolve) => setTimeout(resolve, 500));
			this.late = false;
			return super.list();
		}
	})();
	agents.emit("card-a", { state: "working" });
	const soma = await core(db, agents);
	expect(await soma.outcome(id)).toEqual({ status: "completed", result: "gone" });
	await soma.settle();
	const notices = await soma.notices();
	expect(notices).toEqual([expect.stringMatching(new RegExp(`^Deferred instruction ${id} .*not sent.*stopping`))]);
	expect(notices[0]).not.toMatch(/no longer listed/);
	expect((await soma.job("card-a"))?.reclaim).toBeUndefined();

	agents.finish("card-a", "結果：完成");
	await soma.settle();
	expect(agents.stopped).toEqual([]);
	expect(agents.prompts).toEqual([]);
});
