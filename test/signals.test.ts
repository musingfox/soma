import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { SIGNAL } from "../src/core/domain/signal.ts";
import { eventBridge, JOB_DONE } from "../src/core/extensions/dispatch/bridge.ts";
import { dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { Facts, memory } from "../src/core/extensions/memory/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";

const context = BACKGROUND_CONTEXT;
const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const each of open.splice(0).reverse()) await each.close();
});

type Request = { messages: { role: string; content: unknown }[] };

/**
 * A core with the memory and dispatch extensions, the event bridge and the human port. The faux model dispatches on
 * 「派 <card>」, answers a wake by pressing option 1 on the fingerprint it names, denies on 「不對」, throws on
 * 「壞掉」 and says 「好。」 otherwise.
 */
async function core(agents = new FakeAgentPort()) {
	const directory = await mkdtemp(join(tmpdir(), "soma-signals-"));
	const faux = fauxProvider();
	faux.setResponses(
		Array.from({ length: 40 }, () => (request: Request) => {
			const last = request.messages.at(-1);
			const said = JSON.stringify(last?.content ?? "");
			if (last?.role === "toolResult") return fauxAssistantMessage("好。");
			if (said.includes("壞掉")) throw new Error("401 invalid x-api-key");
			if (said.includes("不對")) {
				const turnsAgo = /往回 (\d)/.exec(said)?.[1];
				const args: { turns_ago?: number } = turnsAgo === undefined ? {} : { turns_ago: Number(turnsAgo) };
				return fauxAssistantMessage([fauxToolCall("mark_denied", args)], { stopReason: "toolUse" });
			}
			if (said.includes("天氣")) return fauxAssistantMessage("台北今天晴天。");
			const card = /派 ([a-z0-9-]+)/.exec(said)?.[1];
			if (card !== undefined) {
				return fauxAssistantMessage([fauxToolCall("dispatch", { card, repo: "/repo" })], { stopReason: "toolUse" });
			}
			const [, blocked = "", fingerprint = ""] = /卡片 ([a-z0-9-]+)）卡住了.*?fingerprint=([0-9a-z]+)/.exec(said) ?? [];
			if (blocked === "") return fauxAssistantMessage("好。");
			const call = fauxToolCall("respond", { card: blocked, option: "1", fingerprint, reason: "建空檔" });
			return fauxAssistantMessage([call], { stopReason: "toolUse" }) as AssistantMessage;
		}),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const harness: Harness = await openHarness(
		join(directory, "soma.sqlite"),
		[memory, dispatchExtension(agents, async (_repo, card) => `# ${card}`)],
		context,
		{ models },
	);
	open.push({ close: () => rm(directory, { recursive: true, force: true }) });
	open.push({ close: () => harness.close(context) });
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const human = await openHumanPort(harness, root, context);
	open.push(human);
	const bridge = eventBridge(root, agents, context);
	const handled: Promise<void>[] = [];
	agents.onStatus((event) => handled.push(bridge.handle(event)));
	const settle = async () => {
		for (let seen = -1; seen !== handled.length; ) {
			seen = handled.length;
			await Promise.all(handled);
		}
		await root.waitForIdle(context);
	};
	const ask = async (content: string, requestId: string) => {
		await human.submit({ content, entry: { kind: "chat.terminal" }, requestId });
		await settle();
	};
	return {
		agents,
		harness,
		root,
		ask,
		settle,
		calls: () => faux.state.callCount,
		signals: async () =>
			((await harness.snapshot(Facts, context))?.rows ?? []).filter((row) => row.kind.startsWith("signal.")),
	};
}

const prompt = { state: "blocked", kind: "permission", msg: "Bash command\ntouch x\n1. Yes\n2. No" } as const;

test.each([
	{ again: "f00d", recorded: 1 },
	{ again: "beef", recorded: 0 },
])(
	"a block on prompt $again after answering f00d records $recorded signals and costs no extra model call",
	async ({ again, recorded }) => {
		const soma = await core();
		await soma.ask("派 card-a", "terminal:1");

		soma.agents.emit("card-a", { ...prompt, fingerprint: "f00d" });
		await soma.settle();
		expect(soma.agents.responses).toHaveLength(1);
		const before = soma.calls();
		soma.agents.emit("card-a", { ...prompt, fingerprint: again });
		await soma.settle();

		// Both wakes go the same way: one request to answer, one after the tool result.
		expect(soma.calls() - before).toBe(2);
		const signals = await soma.signals();
		expect(signals).toHaveLength(recorded);
		if (recorded === 1) {
			expect(signals[0]).toMatchObject({
				kind: SIGNAL.reblocked,
				refs: { card: "card-a", agent: "card-a", decision: 0 },
				text: expect.stringContaining("fingerprint=f00d"),
			});
		}
	},
);

test("a dispatch that ends failed or without a result line records one signal each, one that ends done none", async () => {
	const soma = await core();
	for (const card of ["card-f", "card-u", "card-d"]) await soma.ask(`派 ${card}`, `terminal:${card}`);

	soma.agents.finish("card-f", "結果：失敗\n測試沒過。");
	soma.agents.finish("card-u", "做好了。");
	soma.agents.finish("card-d", "結果：完成\n好了。");
	await soma.settle();

	const done = (await soma.root.entries({}, 1000, undefined, context)).items.filter((entry) => entry.kind === JOB_DONE);
	const entryOf = (card: string) => done.find((entry) => (entry.data as { card: string }).card === card)?.id;
	expect(await soma.signals()).toEqual([
		expect.objectContaining({
			kind: SIGNAL.dispatchFailed,
			refs: expect.objectContaining({ card: "card-f", entry: entryOf("card-f") }),
		}),
		expect.objectContaining({
			kind: SIGNAL.dispatchUnknown,
			refs: expect.objectContaining({ card: "card-u", entry: entryOf("card-u") }),
		}),
	]);
});

test("a failed round records one signal with its submission id", async () => {
	const soma = await core();

	await soma.ask("壞掉", "terminal:1");

	const submission = await soma.root.commit((tx) => tx.submissionByRequest(soma.root.id, "terminal:1"), context);
	expect(submission?.status).toBe("unanswered");
	await vi.waitFor(async () => expect(await soma.signals()).toHaveLength(1));
	expect((await soma.signals())[0]).toMatchObject({
		kind: SIGNAL.turnFailed,
		key: `turn:${submission?.id}`,
		refs: { submission: submission?.id, requestId: "terminal:1", entry: submission?.entry },
		text: expect.stringContaining("401 invalid x-api-key"),
	});
});

const answerTo = async (soma: Awaited<ReturnType<typeof core>>, requestId: string) => {
	const submission = await soma.root.commit((tx) => tx.submissionByRequest(soma.root.id, requestId), context);
	return submission?.status === "done" ? submission.answer : undefined;
};

test("the model marks the previous round as denied, and the signal points at that round's answer", async () => {
	const soma = await core();
	await soma.ask("台北天氣如何", "terminal:1");
	await soma.ask("不對，外面在下雨", "terminal:2");

	const denied = await answerTo(soma, "terminal:1");
	const by = (await soma.root.commit((tx) => tx.submissionByRequest(soma.root.id, "terminal:2"), context))?.entry;
	expect(denied).toBeDefined();
	expect(await soma.signals()).toEqual([
		expect.objectContaining({
			kind: SIGNAL.denied,
			key: `denied:${denied}`,
			refs: { entry: denied },
			text: expect.stringContaining(`紀錄 ${by} 的輸入`),
		}),
	]);
});

test("a denial two rounds back points at that round, and marking the same answer twice records it once", async () => {
	const soma = await core();
	await soma.ask("台北天氣如何", "terminal:1");
	await soma.ask("謝謝", "terminal:2");
	await soma.ask("不對，往回 2 那個天氣", "terminal:3");
	await soma.ask("不對，往回 3 那個天氣，我再說一次", "terminal:4");

	const denied = await answerTo(soma, "terminal:1");
	expect(await soma.signals()).toEqual([expect.objectContaining({ kind: SIGNAL.denied, refs: { entry: denied } })]);
});
