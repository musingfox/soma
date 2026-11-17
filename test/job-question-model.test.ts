import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { NO_JOB_QUESTIONS } from "../src/core/domain/dispatch.ts";
import { Questions } from "../src/core/extensions/ask/index.ts";
import { eventBridge } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHumanPort } from "../src/core/human-port.ts";

const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

type Message = { role: string; sections?: Record<string, string> };

/** The `job_questions` section as the model last had it in a request: sections are sent again only when they change. */
const shown = (messages: readonly Message[]) =>
	messages
		.flatMap((message) => (message.role === "system" ? [message.sections?.job_questions] : []))
		.filter((section) => section !== undefined)
		.at(-1);

/** soma's model with the dispatch tools, over a fake agent side with one idle job `pick` the event bridge watches. */
async function setup() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const agents = new FakeAgentPort();
	const registry = createRegistry();
	registry.install(dispatchExtension(agents, async (_repo, card) => `# ${card}`));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const human = await openHumanPort(harness, root, agents, context);
	cleanup.push(() => human.close());
	await root.commit(async (tx) => {
		const job = {
			card: "pick",
			agent: "pick-agent",
			sessionId: "s",
			status: { state: "idle" as const },
			decisions: [],
		};
		(await tx.doc(Dispatches, root.id)).jobs.push(job);
	}, context);
	const bridge = eventBridge(root, agents, context);
	const handled: Promise<void>[] = [];
	agents.onStatus((event) => handled.push(bridge.handle(event)));
	const requests: Message[][] = [];
	/** One round of the human typing `content`; resolves once it answered. */
	const type = async (content: string) => {
		faux.setResponses([
			(request) => {
				requests.push(JSON.parse(JSON.stringify(request.messages)) as Message[]);
				return fauxAssistantMessage("好。");
			},
		]);
		await (await root.submit({ type: "input", content }, context)).wait(context);
		return shown(requests.at(-1) ?? []);
	};
	const turn = async (reply: string) => {
		agents.emit("pick-agent", { state: "working" });
		agents.finish("pick-agent", reply);
		await Promise.all(handled);
	};
	const questions = async () => (await harness.snapshot(Questions, root.id, context))?.questions ?? {};
	return { human, type, turn, questions };
}

test("a typed answer reaches a model shown the job, its reply and the numbered options, until the job stops waiting", async () => {
	const { human, type, turn, questions } = await setup();
	expect(await type("在嗎")).toBe(`<job_questions>\n${NO_JOB_QUESTIONS}\n</job_questions>`);

	await turn("結果：需要你\n選 A 還是 B？\n**選項：**\n1) **A**\n2) **B**");
	const section = await type("B");
	expect(section).toContain(
		"- 卡片 pick（agent pick-agent）\n  回覆：\n  > 結果：需要你\n  > 選 A 還是 B？\n  選項：\n  1. A\n  2. B",
	);
	expect(section).toContain("用 reply 工具");

	const [question] = Object.keys(await questions());
	await human.say(question ?? "", "2", { entry: { kind: "chat.terminal" }, requestId: "terminal:1" });
	expect(await type("好了嗎")).toBe(`<job_questions>\n${NO_JOB_QUESTIONS}\n</job_questions>`);
});
