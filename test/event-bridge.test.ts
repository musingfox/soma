import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation, Harness, SubmissionId } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { HUMAN_CHOSEN, type Job } from "../src/core/domain/dispatch.ts";
import {
	AGENT_BLOCKED,
	blockedRequestId,
	eventBridge,
	JOB_DONE,
	reconcileDispatches,
} from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { NOTICE } from "../src/core/notice.ts";
import type { AgentState, StartRequest } from "../src/ports/agent.ts";

const context = BACKGROUND_CONTEXT;
const open: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function database() {
	const directory = await mkdtemp(join(tmpdir(), "soma-bridge-"));
	directories.push(directory);
	return join(directory, "soma.sqlite");
}

/** One core process: a harness over `db`, a faux model whose request count is the model-call count. */
async function core(db: string, agents: FakeAgentPort) {
	const faux = fauxProvider();
	faux.setResponses(
		Array.from({ length: 20 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
			const last = request.messages.at(-1);
			const card = /派 ([a-z0-9-]+)/.exec(JSON.stringify(last?.content ?? ""))?.[1];
			if (last?.role === "user" && card !== undefined) {
				return fauxAssistantMessage([fauxToolCall("dispatch", { card, repo: "/repo" })], { stopReason: "toolUse" });
			}
			return fauxAssistantMessage("好。");
		}),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await openHarness(db, [dispatchExtension(agents, async (_repo, card) => `# ${card}`)], context, {
		models,
	});
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const bridge = eventBridge(root, agents, context);
	const handled: Promise<void>[] = [];
	agents.onStatus((event) => handled.push(bridge.handle(event)));
	return {
		harness,
		root,
		calls: () => faux.state.callCount,
		/** Every status handled and every run it started finished. */
		settle: async () => {
			// A handled event can raise the next one, as a launch prompt raises working.
			for (let seen = -1; seen !== handled.length; ) {
				seen = handled.length;
				await Promise.all(handled);
			}
			await root.waitForIdle(context);
		},
		job: async (card: string) =>
			(await harness.snapshot(Dispatches, root.id, context))?.jobs.find((job) => job.card === card),
	};
}

async function entriesOf(root: Conversation, kind: string) {
	const page = await root.entries({}, 1000, undefined, context);
	return page.items.filter((entry) => entry.kind === kind);
}

/** Closes one core process, as a crash or a restart would. */
async function stop(soma: { harness: Harness }) {
	await soma.harness.close(context);
	open.splice(open.indexOf(soma.harness), 1);
}

/** `conversation`, with the id of every submission its submit returns pushed to `ids`. */
function watchSubmits(conversation: Conversation, ids: SubmissionId[]): Conversation {
	return new Proxy(conversation, {
		get(target, key) {
			if (key === "submit") {
				return async (...args: Parameters<Conversation["submit"]>) => {
					const submission = await target.submit(...args);
					ids.push(submission.id);
					return submission;
				};
			}
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

async function dispatched(db: string, agents: FakeAgentPort, card: string) {
	const soma = await core(db, agents);
	const submission = await soma.root.submit({ type: "input", content: `派 ${card}`, requestId: `t:${card}` }, context);
	expect((await submission.wait(context)).status).toBe("done");
	await soma.settle();
	return soma;
}

test("a finished agent updates the dispatch list without a model call", async () => {
	const agents = new FakeAgentPort();
	const soma = await dispatched(await database(), agents, "card-a");
	const before = soma.calls();

	agents.emit("card-a", { state: "idle" });
	await soma.settle();
	expect(agents.prompts).toEqual([{ agent: "card-a", text: expect.stringContaining("# card-a") }]);
	expect(await soma.job("card-a")).toMatchObject({ status: { state: "working" } });
	agents.finish("card-a", "結果：完成");
	await soma.settle();

	expect(soma.calls() - before).toBe(0);
	expect(await soma.job("card-a")).toMatchObject({ status: { state: "done" }, outcome: "完成" });
	expect((await soma.job("card-a"))?.launch).toBeUndefined();
	expect(await entriesOf(soma.root, JOB_DONE)).toMatchObject([
		{ data: { agent: "card-a", state: "done", outcome: "完成" } },
	]);
});

test("each finished turn records the outcome its reply states, and a reply without one is unknown", async () => {
	const agents = new FakeAgentPort();
	const soma = await dispatched(await database(), agents, "card-a");
	agents.emit("card-a", { state: "idle" });
	await soma.settle();

	agents.finish("card-a", "結果：需要你\n要用哪個 server？");
	await soma.settle();
	expect(await soma.job("card-a")).toMatchObject({ outcome: "需要你" });

	agents.emit("card-a", { state: "working" });
	agents.finish("card-a", "改好了。");
	await soma.settle();
	expect(await soma.job("card-a")).toMatchObject({ outcome: "未知" });
	const outcomes = (await entriesOf(soma.root, JOB_DONE)).map((entry) => (entry.data as { outcome: string }).outcome);
	expect(outcomes.sort()).toEqual(["未知", "需要你"].sort());
});

test("a blocked agent wakes the model once, however often the snapshot repeats it", async () => {
	const agents = new FakeAgentPort();
	const soma = await dispatched(await database(), agents, "card-a");
	const before = soma.calls();

	agents.emit("card-a", { state: "blocked", kind: "permission" }, 41);
	agents.emit("card-a", { state: "blocked", kind: "permission" }, 41);
	await soma.settle();
	agents.emit("card-a", { state: "blocked", kind: "permission" }, 41);
	await soma.settle();

	expect(soma.calls() - before).toBe(1);
	expect(await entriesOf(soma.root, AGENT_BLOCKED)).toHaveLength(1);
	expect(await soma.job("card-a")).toMatchObject({ seq: 41, status: { state: "blocked", kind: "permission" } });
});

test("the same blocked prompt re-reported under new seqs wakes the model once", async () => {
	const agents = new FakeAgentPort();
	const soma = await dispatched(await database(), agents, "card-a");
	const before = soma.calls();
	const prompt = { state: "blocked", kind: "question", msg: "answer: which?", fingerprint: "fp-1" } as const;

	agents.emit("card-a", prompt, 51);
	agents.emit("card-a", prompt, 52);
	await soma.settle();
	agents.emit("card-a", prompt, 53);
	await soma.settle();

	expect(soma.calls() - before).toBe(1);
	expect(await entriesOf(soma.root, AGENT_BLOCKED)).toMatchObject([{ data: { seq: 51 } }]);
	expect(await soma.job("card-a")).toMatchObject({ seq: 53, status: prompt });
});

test("blocked → working → blocked on the same prompt wakes the model twice", async () => {
	const agents = new FakeAgentPort();
	const soma = await dispatched(await database(), agents, "card-a");
	const before = soma.calls();
	const prompt = { state: "blocked", kind: "permission", msg: "approve Bash: ls", fingerprint: "fp-1" } as const;

	agents.emit("card-a", prompt);
	await soma.settle();
	agents.emit("card-a", { state: "working" });
	agents.emit("card-a", prompt);
	await soma.settle();

	expect(soma.calls() - before).toBe(2);
	expect(await entriesOf(soma.root, AGENT_BLOCKED)).toHaveLength(2);
});

test("a finished turn re-reported under new seqs is recorded once, and a new reply once more", async () => {
	const agents = new FakeAgentPort();
	const soma = await dispatched(await database(), agents, "card-a");
	agents.emit("card-a", { state: "idle" });
	await soma.settle();

	agents.finish("card-a", "結果：完成");
	agents.emit("card-a", { state: "idle" });
	agents.emit("card-a", { state: "idle" });
	await soma.settle();
	agents.emit("card-a", { state: "idle" });
	await soma.settle();
	expect(await entriesOf(soma.root, JOB_DONE)).toHaveLength(1);
	const first = (await soma.job("card-a"))?.resultId;
	expect(first).toEqual(expect.any(String));

	// A second turn between two samples: the reply changed, no working was seen.
	agents.finish("card-a", "結果：需要你\n要用哪個 server？");
	agents.emit("card-a", { state: "idle" });
	await soma.settle();

	const outcomes = (await entriesOf(soma.root, JOB_DONE)).map((entry) => (entry.data as { outcome: string }).outcome);
	expect(outcomes.sort()).toEqual(["完成", "需要你"].sort());
	expect((await soma.job("card-a"))?.resultId).not.toBe(first);
});

test("a block resent after a restart is handled once, by its requestId", async () => {
	const db = await database();
	const first = await dispatched(db, new FakeAgentPort(), "card-a");
	const beforeBlock = JSON.parse(JSON.stringify(await first.job("card-a"))) as Job;
	const blocked = { state: "blocked", kind: "permission" } as const;
	await eventBridge(first.root, new FakeAgentPort(), context).handle({ agent: "card-a", status: blocked, seq: 7 });
	await first.root.waitForIdle(context);
	const wake = await first.root.commit(
		async (tx) => (await tx.submissionByRequest(first.root.id, blockedRequestId("card-a", 7)))?.id,
		context,
	);
	expect(wake).toBeDefined();
	// The crash this stands in for: the wake was admitted, the commit of its seq never landed.
	await first.root.commit(async (tx) => {
		(await tx.doc(Dispatches, first.root.id)).jobs = [beforeBlock];
	}, context);
	await stop(first);

	const agents = new FakeAgentPort();
	agents.emit("card-a", blocked, 7);
	const second = await core(db, agents);
	const submitted: SubmissionId[] = [];
	await reconcileDispatches(watchSubmits(second.root, submitted), agents, context);
	await second.settle();

	// The redo submitted again, and the requestId handed back the first submission instead of a new run.
	expect(submitted).toEqual([wake]);
	expect(second.calls()).toBe(0);
	expect(await entriesOf(second.root, AGENT_BLOCKED)).toHaveLength(1);
	expect(await second.job("card-a")).toMatchObject({ seq: 7, status: blocked, handedOver: {} });
});

test("an agent gone at a restart is told to the human once, however often soma restarts", async () => {
	const db = await database();
	await stop(await dispatched(db, new FakeAgentPort(), "card-a"));

	for (let restart = 0; restart < 2; restart++) {
		const soma = await core(db, new FakeAgentPort());
		await reconcileDispatches(soma.root, new FakeAgentPort(), context);
		await soma.settle();
		expect(await soma.job("card-a")).toMatchObject({ status: { state: "error", msg: "agent is gone" } });
		expect(await entriesOf(soma.root, NOTICE)).toMatchObject([{ data: { kind: "report" } }]);
		// notified, so the digest does not report it a second time.
		expect(await entriesOf(soma.root, JOB_DONE)).toMatchObject([
			{ data: { agent: "card-a", state: "error", outcome: "失敗", notified: true } },
		]);
		expect(soma.calls()).toBe(0);
		await stop(soma);
	}
});

/** An agent side whose listings carry no seq, as herdr's do. */
class SeqlessAgentPort extends FakeAgentPort {
	override async list() {
		return (await super.list()).map(({ seq: _seq, ...listing }) => listing);
	}
}

/** Blocked while soma was down: the restart's reconcile writes the status, the first snapshot then reports it. */
async function blockedWhileDown(status: AgentState, agents: FakeAgentPort = new FakeAgentPort()) {
	const db = await database();
	await stop(await dispatched(db, agents, "card-a"));
	const restarted = new SeqlessAgentPort();
	restarted.emit("card-a", status, 11);
	const soma = await core(db, restarted);
	await reconcileDispatches(soma.root, restarted, context);
	await soma.settle();
	expect(await soma.job("card-a")).toMatchObject({ status });
	return { soma, agents: restarted };
}

test("a block first seen at a restart's reconcile wakes the model once at the first snapshot", async () => {
	const prompt = { state: "blocked", kind: "question", msg: "answer: which?", fingerprint: "fp-1" } as const;
	const { soma, agents } = await blockedWhileDown(prompt);
	expect(soma.calls()).toBe(0);

	agents.emit("card-a", prompt, 11);
	await soma.settle();
	agents.emit("card-a", prompt, 12);
	await soma.settle();

	expect(soma.calls()).toBe(1);
	expect(await entriesOf(soma.root, AGENT_BLOCKED)).toMatchObject([{ data: { seq: 11 } }]);
});

test("an auth block first seen at a restart's reconcile is told to the human once", async () => {
	const auth = { state: "blocked", kind: "auth", msg: "login required" } as const;
	const { soma, agents } = await blockedWhileDown(auth);

	agents.emit("card-a", auth, 11);
	await soma.settle();
	agents.emit("card-a", auth, 12);
	await soma.settle();

	expect(soma.calls()).toBe(0);
	expect(await entriesOf(soma.root, NOTICE)).toMatchObject([{ data: { kind: "question" } }]);
	expect((await soma.job("card-a"))?.decisions).toMatchObject([{ kind: "auth", action: "escalated" }]);
});

test("a fresh dispatch whose agent sits on the trust dialog at a restart's reconcile is woken", async () => {
	// The agent never reports idle, so the launch prompt is still held when soma goes down.
	const quiet = new (class extends FakeAgentPort {
		override async start(request: StartRequest) {
			this.started.push(request);
		}
	})();
	const trust = {
		state: "blocked",
		kind: "permission",
		msg: "Do you trust this folder?",
		fingerprint: "trust",
	} as const;
	const { soma, agents } = await blockedWhileDown(trust, quiet);
	expect((await soma.job("card-a"))?.launch).toBeDefined();

	agents.emit("card-a", trust, 11);
	await soma.settle();

	expect(soma.calls()).toBe(1);
	expect(await entriesOf(soma.root, AGENT_BLOCKED)).toHaveLength(1);
	expect((await soma.job("card-a"))?.launch).toBeDefined();
});

test("a turn whose last message has no text is recorded once, as unknown", async () => {
	const agents = new FakeAgentPort();
	const soma = await dispatched(await database(), agents, "card-a");
	agents.emit("card-a", { state: "idle" });
	await soma.settle();

	agents.finish("card-a", "");
	agents.emit("card-a", { state: "idle" });
	await soma.settle();
	agents.emit("card-a", { state: "idle" });
	await soma.settle();

	expect(await entriesOf(soma.root, JOB_DONE)).toMatchObject([{ data: { outcome: "未知", notified: false } }]);
	expect(await entriesOf(soma.root, NOTICE)).toEqual([]);
});

test("an agent soma did not dispatch is ignored", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(await database(), agents);

	agents.emit("stranger", { state: "blocked", kind: "auth" });
	await soma.settle();

	expect(soma.calls()).toBe(0);
	expect(await entriesOf(soma.root, AGENT_BLOCKED)).toEqual([]);
});

test("需要你 is told to the human at once, without a model call, and once however often the event repeats", async () => {
	const agents = new FakeAgentPort();
	const soma = await dispatched(await database(), agents, "card-a");
	agents.emit("card-a", { state: "idle" });
	await soma.settle();
	const before = soma.calls();

	agents.finish("card-a", "結果：需要你\n要用哪個 server？");
	const seq = (await agents.list()).find((agent) => agent.name === "card-a")?.seq;
	await soma.settle();
	agents.emit("card-a", { state: "done" }, seq);
	await soma.settle();

	expect(soma.calls() - before).toBe(0);
	expect(await entriesOf(soma.root, NOTICE)).toMatchObject([
		{
			data: { kind: "question", content: "agent card-a（卡片 card-a）這一輪結束了：\n結果：需要你\n要用哪個 server？" },
		},
	]);
	expect(await entriesOf(soma.root, JOB_DONE)).toMatchObject([{ data: { outcome: "需要你", notified: true } }]);
});

test("完成 waits for the report, unless the human touched the job just before", async () => {
	const agents = new FakeAgentPort();
	const soma = await dispatched(await database(), agents, "card-a");
	agents.emit("card-a", { state: "idle" });
	await soma.settle();

	agents.finish("card-a", "結果：完成");
	await soma.settle();
	expect(await entriesOf(soma.root, NOTICE)).toEqual([]);

	await soma.root.commit(async (tx) => {
		const doc = await tx.doc(Dispatches, soma.root.id);
		doc.jobs = doc.jobs.map((job) => ({
			...job,
			decisions: [{ at: new Date().toISOString(), kind: "permission", action: "answered", reason: HUMAN_CHOSEN }],
		}));
	}, context);
	agents.emit("card-a", { state: "working" });
	agents.finish("card-a", "結果：完成\n改好了。");
	await soma.settle();

	expect(await entriesOf(soma.root, NOTICE)).toMatchObject([{ data: { kind: "report" } }]);
	const notified = (await entriesOf(soma.root, JOB_DONE)).map(
		(entry) => (entry.data as { notified: boolean }).notified,
	);
	expect(notified.sort()).toEqual([false, true]);
});
