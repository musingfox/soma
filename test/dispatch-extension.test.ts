import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { reconcileDispatches } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";

const context = BACKGROUND_CONTEXT;
const open: Harness[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
});

async function setup() {
	const agents = new FakeAgentPort();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(
		dispatchExtension(agents, async (_repo, card) => {
			if (card === "missing") throw new Error(`no card ${card}`);
			return `# ${card}`;
		}),
	);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();

	async function dispatch(card: string, requestId: string) {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("dispatch", { card, repo: "/repo" }, { id: requestId })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok"),
		]);
		const submission = await root.submit({ type: "input", content: `派 ${card}`, requestId }, context);
		expect((await submission.wait(context)).status).toBe("done");
	}
	const jobs = async () => (await harness.snapshot(Dispatches, root.id, context))?.jobs ?? [];
	return { agents, faux, root, dispatch, jobs };
}

test("dispatch starts an agent named after the card and records the job with its session id", async () => {
	const { agents, dispatch, jobs } = await setup();

	await dispatch("card-a", "r1");

	expect(agents.started).toHaveLength(1);
	const [started] = agents.started;
	expect(started).toMatchObject({ name: "card-a", card: "card-a", cwd: "/repo" });
	expect(await jobs()).toEqual([
		{
			card: "card-a",
			agent: "card-a",
			sessionId: started?.sessionId,
			status: { state: "idle" },
			launch: expect.stringMatching(/以下是任務卡：\n\n# card-a$/),
			decisions: [],
		},
	]);
});

test("a card already in the dispatch list is not started again", async () => {
	const { agents, dispatch, jobs } = await setup();

	await dispatch("card-a", "r1");
	await dispatch("card-a", "r2");

	expect(agents.started).toHaveLength(1);
	expect(await jobs()).toHaveLength(1);
});

test("a card whose agent is already listed is recorded without starting it", async () => {
	const { agents, dispatch, jobs } = await setup();
	agents.emit("card-a", { state: "working" });

	await dispatch("card-a", "r1");

	expect(agents.started).toEqual([]);
	expect(await jobs()).toMatchObject([{ card: "card-a", status: { state: "working" } }]);
});

test("reconcile writes what changed while the core was down", async () => {
	const { agents, root, dispatch, jobs } = await setup();
	await dispatch("card-a", "r1");
	agents.finish("card-a", "結果：完成");

	await reconcileDispatches(root, agents, context);

	expect(await jobs()).toMatchObject([{ card: "card-a", status: { state: "done" } }]);
});

test("jobs lists the dispatched jobs", async () => {
	const { faux, root, dispatch } = await setup();
	await dispatch("card-a", "r1");
	let result = "";
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("jobs", {})], { stopReason: "toolUse" }),
		(request) => {
			result = JSON.stringify(request.messages.at(-1));
			return fauxAssistantMessage("ok");
		},
	]);

	const submission = await root.submit({ type: "input", content: "列出派工清單", requestId: "r2" }, context);
	expect((await submission.wait(context)).status).toBe("done");

	expect(JSON.parse(result)).toMatchObject({ role: "toolResult", toolName: "jobs", isError: false });
	expect(JSON.parse(JSON.parse(result).content[0].text)).toMatchObject([{ card: "card-a", agent: "card-a" }]);
});

test("a card that cannot be read starts nothing", async () => {
	const { agents, dispatch, jobs } = await setup();

	await dispatch("missing", "r1");

	expect(agents.started).toEqual([]);
	expect(await jobs()).toEqual([]);
});
