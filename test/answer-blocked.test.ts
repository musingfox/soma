import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { AGENT_BLOCKED, eventBridge } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";
import type { SomaEvent } from "../src/ports/human.ts";

const context = BACKGROUND_CONTEXT;
const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const each of open.splice(0).reverse()) await each.close();
});

type Plan = { tool: "respond"; fingerprint?: string } | { tool: "escalate" };

/** A core whose faux model dispatches on 「派 <card>」 and handles a wake as `plan` says. */
async function core(agents: FakeAgentPort, plan: Plan) {
	const directory = await mkdtemp(join(tmpdir(), "soma-answer-"));
	const faux = fauxProvider();
	const results: unknown[] = [];
	faux.setResponses(
		Array.from({ length: 20 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
			const last = request.messages.at(-1);
			const said = JSON.stringify(last?.content ?? "");
			if (last?.role === "toolResult") {
				results.push(JSON.parse(JSON.parse(said)[0].text));
				return fauxAssistantMessage("好。");
			}
			const card = /派 ([a-z0-9-]+)/.exec(said)?.[1];
			if (card !== undefined) {
				return fauxAssistantMessage([fauxToolCall("dispatch", { card, repo: "/repo" })], { stopReason: "toolUse" });
			}
			const wake = /卡片 ([a-z0-9-]+)）卡住了.*?(?:fingerprint=([0-9a-z]+))?/.exec(said);
			if (wake?.[1] === undefined) return fauxAssistantMessage("好。");
			const call =
				plan.tool === "respond"
					? fauxToolCall("respond", {
							card: wake[1],
							option: "1",
							fingerprint: plan.fingerprint ?? /fingerprint=([0-9a-z]+)/.exec(said)?.[1] ?? "",
							reason: "只是建立一個空檔",
						})
					: fauxToolCall("escalate", { card: wake[1], question: "要讓它執行嗎？", reason: "會動到正式資料" });
			return fauxAssistantMessage([call], { stopReason: "toolUse" }) as AssistantMessage;
		}),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const harness: Harness = await openHarness(
		join(directory, "soma.sqlite"),
		[dispatchExtension(agents, async (_repo, card) => `# ${card}`)],
		context,
		{ models },
	);
	open.push({ close: () => rm(directory, { recursive: true, force: true }) });
	open.push({ close: () => harness.close(context) });
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const human = await openHumanPort(harness, root, agents, context);
	open.push(human);
	const notices: SomaEvent[] = [];
	human.subscribe((event) => {
		if (event.type === "notice") notices.push(event);
	});
	const bridge = eventBridge(root, agents, context);
	const handled: Promise<void>[] = [];
	agents.onStatus((event) => handled.push(bridge.handle(event)));

	const submission = await root.submit({ type: "input", content: "派 card-a", requestId: "t:card-a" }, context);
	await submission.wait(context);
	const settle = async () => {
		for (let seen = -1; seen !== handled.length; ) {
			seen = handled.length;
			await Promise.all(handled);
		}
		await root.waitForIdle(context);
	};
	await settle();
	return {
		calls: () => faux.state.callCount,
		human,
		results,
		notices,
		settle,
		job: async () => (await harness.snapshot(Dispatches, root.id, context))?.jobs.find((job) => job.card === "card-a"),
		wakes: async () =>
			(await root.entries({}, 1000, undefined, context)).items.filter((entry) => entry.kind === AGENT_BLOCKED),
	};
}

const prompt = { state: "blocked", kind: "permission", msg: "Bash command\ntouch x\n1. Yes\n2. No" } as const;

test("the model answers a permission prompt by its fingerprint, and the decision is recorded", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(agents, { tool: "respond" });

	agents.emit("card-a", { ...prompt, fingerprint: "f00d" });
	await soma.settle();

	expect(agents.responses).toEqual([{ agent: "card-a", answer: { option: "1", fingerprint: "f00d" } }]);
	expect(soma.results.at(-1)).toEqual({ sent: true });
	expect((await soma.job())?.decisions).toMatchObject([
		{ kind: "permission", action: "answered", option: "1", reason: "只是建立一個空檔" },
	]);
});

test("an answer decided on a screen that has since changed is refused and reported to the model", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(agents, { tool: "respond", fingerprint: "0ld" });

	agents.emit("card-a", { ...prompt, fingerprint: "f00d" });
	await soma.settle();

	expect(agents.responses).toEqual([]);
	expect(soma.results.at(-1)).toEqual({ sent: false, refusal: "stale" });
	expect((await soma.job())?.decisions).toEqual([]);
});

test("an auth block reaches the human as a notice without waking the model", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(agents, { tool: "respond" });
	const before = soma.calls();

	agents.emit("card-a", {
		state: "blocked",
		kind: "auth",
		msg: "Do you want to use this API key?",
		fingerprint: "k3y",
	});
	await soma.settle();

	expect(soma.calls() - before).toBe(0);
	expect(await soma.wakes()).toEqual([]);
	expect(agents.responses).toEqual([]);
	expect(soma.notices).toEqual([
		{
			type: "notice",
			kind: "question",
			class: "action",
			content: expect.stringContaining("Do you want to use this API key?"),
		},
	]);
	expect((await soma.job())?.decisions).toMatchObject([{ kind: "auth", action: "escalated" }]);
});

test("the model can hand a prompt to the human, with its reason recorded", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(agents, { tool: "escalate" });

	agents.emit("card-a", { ...prompt, fingerprint: "f00d" });
	await soma.settle();

	expect(agents.responses).toEqual([]);
	expect(soma.notices).toEqual([
		{ type: "notice", kind: "question", class: "action", content: "agent card-a（卡片 card-a）：要讓它執行嗎？" },
	]);
	expect((await soma.job())?.decisions).toMatchObject([
		{ kind: "permission", action: "escalated", reason: "會動到正式資料" },
	]);
});

const options = [
	{ id: "1", label: "Yes" },
	{ id: "2", label: "No" },
];

test("a prompt handed to the human carries its options and fingerprint, so a client can offer them", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(agents, { tool: "escalate" });

	agents.emit("card-a", { ...prompt, fingerprint: "f00d", options });
	await soma.settle();

	expect(soma.notices).toEqual([
		{
			type: "notice",
			kind: "question",
			class: "action",
			content: "agent card-a（卡片 card-a）：要讓它執行嗎？",
			choices: { card: "card-a", fingerprint: "f00d", options },
		},
	]);
});

test("the human's own choice reaches the agent without a model round, and the decision is recorded", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(agents, { tool: "escalate" });
	agents.emit("card-a", { ...prompt, fingerprint: "f00d", options });
	await soma.settle();
	const before = soma.calls();

	expect(await soma.human.respond("card-a", { option: "2", fingerprint: "f00d" })).toEqual({ sent: true });
	await soma.settle();

	expect(soma.calls() - before).toBe(0);
	expect(agents.responses).toEqual([{ agent: "card-a", answer: { option: "2", fingerprint: "f00d" } }]);
	expect((await soma.job())?.decisions).toMatchObject([
		{ kind: "permission", action: "escalated" },
		{ kind: "permission", action: "answered", option: "2", fingerprint: "f00d", reason: "人親自選的選項" },
	]);
});

test("the human's choice on a prompt that has since changed is refused, and nothing is recorded", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(agents, { tool: "escalate" });
	agents.emit("card-a", { ...prompt, fingerprint: "f00d", options });
	await soma.settle();

	expect(await soma.human.respond("card-a", { option: "1", fingerprint: "0ld" })).toEqual({
		sent: false,
		refusal: "stale",
	});
	expect(await soma.human.respond("card-b", { option: "1", fingerprint: "f00d" })).toEqual({
		sent: false,
		refusal: "no_job",
	});
	expect(agents.responses).toEqual([]);
	expect((await soma.job())?.decisions).toMatchObject([{ action: "escalated" }]);
});
