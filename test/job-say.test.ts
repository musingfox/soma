import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { askForJob, Questions } from "../src/core/extensions/ask/index.ts";
import { Dispatches } from "../src/core/extensions/dispatch/index.ts";
import { openHumanPort } from "../src/core/human-port.ts";
import { PromptRefused } from "../src/ports/agent.ts";
import type { SomaEvent } from "../src/ports/human.ts";

const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

/** An agent side whose prompts fail with `failure`, when set, after counting them. */
class FailingAgents extends FakeAgentPort {
	failure: Error | undefined;
	override async prompt(agent: string, text: string): Promise<void> {
		if (this.failure !== undefined) {
			this.prompts.push({ agent, text });
			throw this.failure;
		}
		await super.prompt(agent, text);
	}
}

/** A core holding job `pick` at rest on turn `msg_1`, which listed options A and B. */
async function setup() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const agents = new FailingAgents();
	const human = await openHumanPort(harness, root, agents, context);
	cleanup.push(() => human.close());
	const seen: SomaEvent[] = [];
	human.subscribe((event) => seen.push(event));
	const { question } = await root.commit(async (tx) => {
		(await tx.doc(Dispatches, root.id)).jobs.push({
			card: "pick",
			agent: "pick-agent",
			sessionId: "s",
			status: { state: "done" },
			resultId: "msg_1",
			decisions: [],
		});
		const asked = { card: "pick", turn: "msg_1", at: new Date().toISOString(), text: "結果：需要你\n選 A 還是 B？" };
		return askForJob(tx, root.id, asked, ["A", "B"]);
	}, context);
	const said = async () => (await harness.snapshot(Questions, root.id, context))?.questions[question]?.said;
	const press = (option: string) =>
		human.say(question, option, { entry: { kind: "chat.terminal" }, requestId: `terminal:${option}` });
	return { harness, root, agents, seen, question, said, press };
}

test("a press on a job's question sends the label to its agent, settles it everywhere, and starts no round", async () => {
	const { root, agents, seen, question, said, press } = await setup();

	expect(await press("1")).toEqual({ said: true, label: "A", job: "pick" });
	expect(agents.prompts).toEqual([{ agent: "pick-agent", text: "A" }]);
	expect(await said()).toBe("1");
	expect(seen.filter((event) => event.type === "said")).toEqual([{ type: "said", question, label: "A" }]);
	const { items } = await root.entries({ order: "ascending" }, 100, undefined, context);
	expect(items.filter((entry) => entry.kind === "chat.terminal")).toEqual([]);
});

test("a press the agent refuses for being busy sends nothing, says the job no longer waits, and leaves the question open", async () => {
	const { agents, seen, said, press } = await setup();
	agents.failure = new PromptRefused("acp agent pick-agent is working: a prompt goes only between turns", {
		busy: true,
	});

	expect(await press("1")).toEqual({ said: false, refusal: "not_waiting" });
	expect(await said()).toBeUndefined();
	expect(seen.filter((event) => event.type === "said")).toEqual([]);
});

test("a press the agent side refuses for another reason is unsent with that reason, and a later press goes through", async () => {
	const { agents, seen, said, press } = await setup();
	const reason = "acp agent pick-agent is dormant: hangar is full: 3 of 3 agents running";
	agents.failure = new PromptRefused(reason);

	expect(await press("1")).toEqual({ said: false, refusal: "unsent", reason });
	expect(await said()).toBeUndefined();
	expect(seen.filter((event) => event.type === "said")).toEqual([]);

	agents.failure = undefined;
	expect(await press("2")).toEqual({ said: true, label: "B", job: "pick" });
	expect(agents.prompts.map(({ text }) => text)).toEqual(["A", "B"]);
});

test("a press whose prompt fails after it may have typed stays settled, so the label is never sent twice", async () => {
	const { agents, seen, said, press } = await setup();
	agents.failure = new Error("socket closed");

	expect(await press("1")).toEqual({ said: false, refusal: "unsure", label: "A" });
	expect(await said()).toBe("1");
	expect(await press("2")).toEqual({ said: false, refusal: "settled", label: "A" });
	expect(agents.prompts).toHaveLength(1);
	expect(seen.filter((event) => event.type === "said")).toEqual([]);
});
