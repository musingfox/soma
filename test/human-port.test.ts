import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHumanPort } from "../src/core/human-port.ts";
import type { SomaEvent } from "../src/ports/human.ts";

const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(dispatchExtension(new FakeAgentPort(), async (_repo, card) => `# ${card}`));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const human = await openHumanPort(harness, root, context);
	cleanup.push(() => human.close());
	const seen: SomaEvent[] = [];
	human.subscribe((event) => seen.push(event));
	return { faux, harness, root, human, seen };
}

// One commit ends the run and settles its input; the event order puts run_end before the submission.
test("a submitted input shows the run working, then idle with its answer", async () => {
	const { faux, root, human, seen } = await setup();
	faux.setResponses([fauxAssistantMessage("已派工。")]);

	await human.submit({ content: "派 a", entry: { kind: "chat.terminal" }, requestId: "terminal:1" });
	await root.waitForIdle(context);

	const answer = { type: "answer", requestId: "terminal:1", content: "已派工。" };
	await vi.waitFor(() => expect(seen.at(-1)).toEqual(answer));
	expect(seen).toEqual([
		{ type: "run", state: "idle" },
		{ type: "run", state: "working" },
		{ type: "run", state: "idle" },
		answer,
	]);
});

test("notify delivers a notice with its kind and starts no run", async () => {
	const { human, seen } = await setup();

	await human.notify("job a needs a password", "question");

	await vi.waitFor(() =>
		expect(seen).toContainEqual({ type: "notice", kind: "question", content: "job a needs a password" }),
	);
	expect(seen.filter((event) => event.type === "run")).toEqual([{ type: "run", state: "idle" }]);
});

test("a job state written to the dispatch list reaches subscribers once, and new subscribers get it at once", async () => {
	const { root, human, seen } = await setup();
	const write = (state: "idle" | "blocked") =>
		root.commit(async (tx) => {
			const status = state === "blocked" ? { state, kind: "question" as const } : { state };
			(await tx.doc(Dispatches, root.id)).jobs = [{ card: "a", agent: "a", sessionId: "s", status, decisions: [] }];
		}, context);

	await write("idle");
	await write("idle");
	await write("blocked");

	const blocked = { type: "job", card: "a", agent: "a", status: { state: "blocked", kind: "question" } };
	await vi.waitFor(() => expect(seen.at(-1)).toEqual(blocked));
	expect(seen.filter((event) => event.type === "job")).toEqual([
		{ type: "job", card: "a", agent: "a", status: { state: "idle" } },
		blocked,
	]);
	const late: SomaEvent[] = [];
	human.subscribe((event) => late.push(event));
	expect(late).toEqual([{ type: "run", state: "idle" }, blocked]);
});
