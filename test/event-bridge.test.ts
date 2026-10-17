import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import {
	AGENT_BLOCKED,
	blockedRequestId,
	eventBridge,
	JOB_DONE,
	reconcileDispatches,
} from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";

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

test("a block resent after a restart is handled once, by its requestId", async () => {
	const db = await database();
	const first = await dispatched(db, new FakeAgentPort(), "card-a");
	const blocked = { state: "blocked", kind: "permission" } as const;
	await eventBridge(first.root, new FakeAgentPort(), context).handle({ agent: "card-a", status: blocked, seq: 7 });
	await first.root.waitForIdle(context);
	expect(await entriesOf(first.root, AGENT_BLOCKED)).toHaveLength(1);
	// The crash this stands in for: the wake was admitted, the job's seq never committed.
	await first.root.commit(async (tx) => {
		const doc = await tx.doc(Dispatches, first.root.id);
		doc.jobs = doc.jobs.map(({ seq: _seq, ...job }) => job);
	}, context);
	await first.harness.close(context);
	open.splice(open.indexOf(first.harness), 1);

	const agents = new FakeAgentPort();
	agents.emit("card-a", blocked, 7);
	const second = await core(db, agents);
	await reconcileDispatches(second.root, agents, context);
	await second.settle();

	expect(second.calls()).toBe(0);
	expect(await entriesOf(second.root, AGENT_BLOCKED)).toHaveLength(1);
	const admitted = await second.root.commit(
		async (tx) => (await tx.submissionByRequest(second.root.id, blockedRequestId("card-a", 7)))?.status,
		context,
	);
	expect(admitted).toBe("done");
	expect(await second.job("card-a")).toMatchObject({ seq: 7 });
});

test("an agent soma did not dispatch is ignored", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(await database(), agents);

	agents.emit("stranger", { state: "blocked", kind: "auth" });
	await soma.settle();

	expect(soma.calls()).toBe(0);
	expect(await entriesOf(soma.root, AGENT_BLOCKED)).toEqual([]);
});
