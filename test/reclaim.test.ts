import { expect, test } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { Deferrals } from "../src/core/extensions/defer/index.ts";
import { PromptRefused } from "../src/ports/agent.ts";
import { accepted, type Core, context, core, database } from "./defer-core.ts";

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
	const reclaimed = async (soma: Core) => {
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

test("a deferred prompt refused before it typed holds the job no longer: an idle while it waits stops the agent, and the next try starts it again", {
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
	const soma = await core(await database(), agents, { retryMs: 1_000, tries: 2 });
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
	// The resumed agent refuses too, and the tries are used up.
	expect(await soma.outcome(id)).toEqual({ status: "completed", result: "failed" });
	expect(agents.resumed).toEqual([{ name: "card-a", card: "card-a", sessionId: "s-card-a" }]);
	expect(agents.tried).toBe(2);
	expect(agents.stopped).toEqual(["card-a"]);
	expect(await soma.notices()).toEqual([
		expect.stringMatching(/was not sent after 2 tries: rex agent card-a is working/),
	]);
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

test("a restart after soma died sending one deferral, with another pending, stops the idle agent once, the rerun before the reconcile or after", {
	timeout: 30_000,
}, async () => {
	for (const resume of ["first", "late"] as const) {
		const db = await database();
		let reached: () => void = () => {};
		const typing = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let died: () => void = () => {};
		const dead = new Promise<void>((resolve) => {
			died = resolve;
		});
		// soma dies while the deferred prompt goes out: it returns only once soma is closing, too late to commit its end.
		const dying = new (class extends FakeAgentPort {
			override prompt(): Promise<void> {
				reached();
				return dead;
			}
		})();
		dying.emit("card-a", { state: "working" });
		const first = await core(db, dying);
		const id = await accepted(await first.defer("PT1S"));
		await accepted(await first.defer("PT1H"));
		await typing;
		expect(await first.job("card-a")).toMatchObject({ reclaim: { phase: "sending" } });
		const closed = first.close();
		died();
		await closed;

		// The agent is at rest by the restart. With the tasks resumed first, the late listing lets the rerun settle before
		// the reconcile; resumed late, it settles after the reconcile has skipped the job it found `sending`.
		const agents = new (class extends FakeAgentPort {
			late = resume === "first";
			override async list() {
				if (this.late) await new Promise((resolve) => setTimeout(resolve, 500));
				this.late = false;
				return super.list();
			}
		})();
		agents.emit("card-a", { state: "idle" });
		const soma = await core(db, agents, {}, resume);
		expect(await soma.outcome(id)).toEqual({ status: "completed", result: "unsure" });
		await soma.settle();
		for (const deadline = Date.now() + 3_000; (await soma.job("card-a"))?.reclaim?.phase !== "stopped"; ) {
			expect(Date.now(), `resume ${resume}: ${JSON.stringify(await soma.job("card-a"))}`).toBeLessThan(deadline);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(agents.stopped).toEqual(["card-a"]);
		expect(agents.prompts).toEqual([]);
		expect(await soma.notices()).toEqual([
			expect.stringMatching(new RegExp(`^Deferred instruction ${id} .*may not have reached`)),
		]);
		await soma.close();
	}
});
