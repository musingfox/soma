import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, type Harness, type JsonObject, ToolResultEntry } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, test } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { addTokens, NO_TOKENS, rounds, type Tokens } from "../src/core/domain/inspect.ts";
import { EVIDENCE_ID } from "../src/core/domain/memory.ts";
import { eventBridge, JOB_DONE } from "../src/core/extensions/dispatch/bridge.ts";
import { dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { inspectExtension } from "../src/core/extensions/inspect/index.ts";
import { openHarness, openStorage } from "../src/core/harness.ts";

const context = BACKGROUND_CONTEXT;
const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const each of open.splice(0).reverse()) await each.close();
});

type Window = { total: number; items: Record<string, unknown>[]; truncated?: string };

/**
 * A core whose faux model fails on 「壞掉」, dispatches on 「派 <card>」, answers card-a's wake and escalates
 * card-b's, and on 「自我檢視」 calls inspect with the arguments `ask` was given.
 */
async function core() {
	const directory = await mkdtemp(join(tmpdir(), "soma-inspect-"));
	const faux = fauxProvider();
	const results: unknown[] = [];
	let asked: JsonObject = {};
	faux.setResponses(
		Array.from({ length: 40 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
			const last = request.messages.at(-1);
			const said = JSON.stringify(last?.content ?? "");
			if (last?.role === "toolResult") {
				results.push(JSON.parse(JSON.parse(said)[0].text));
				return fauxAssistantMessage("好。");
			}
			if (said.includes("壞掉")) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "faux 壞了" });
			if (said.includes("自我檢視"))
				return fauxAssistantMessage([fauxToolCall("inspect", asked)], { stopReason: "toolUse" });
			const card = /派 ([a-z0-9-]+)/.exec(said)?.[1];
			if (card !== undefined)
				return fauxAssistantMessage([fauxToolCall("dispatch", { card, repo: "/repo" })], { stopReason: "toolUse" });
			const wake = /卡片 ([a-z0-9-]+)）卡住了/.exec(said)?.[1];
			if (wake === undefined) return fauxAssistantMessage("好的，收到。");
			const call =
				wake === "card-a"
					? fauxToolCall("respond", {
							card: wake,
							option: "1",
							fingerprint: /fingerprint=([0-9a-z]+)/.exec(said)?.[1] ?? "",
							reason: "只是建立一個空檔",
						})
					: fauxToolCall("escalate", { card: wake, question: "要讓它執行嗎？", reason: "會動到正式資料" });
			return fauxAssistantMessage([call], { stopReason: "toolUse" }) as AssistantMessage;
		}),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const agents = new FakeAgentPort();
	const storage = await openStorage(join(directory, "soma.sqlite"));
	const harness: Harness = await openHarness(
		storage,
		[dispatchExtension(agents, async (_repo, card) => `# ${card}`), inspectExtension(storage)],
		context,
		{ models },
	);
	open.push({ close: () => rm(directory, { recursive: true, force: true }) });
	open.push({ close: () => harness.close(context) });
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
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
	let requests = 0;
	const say = async (content: string) => {
		const submission = await root.submit({ type: "input", content, requestId: `t:${requests++}` }, context);
		return { id: submission.id, settled: await submission.wait(context) };
	};
	return {
		agents,
		root,
		say,
		settle,
		ask: async (args: JsonObject) => {
			asked = args;
			await say("自我檢視");
			const found = results.at(-1) as Window;
			// Every row of every query can be cited as memory-revision evidence.
			for (const row of found.items) expect(row.evidence).toMatch(EVIDENCE_ID);
			return found;
		},
	};
}

describe("rounds", () => {
	const tokens = (n: number): Tokens => ({ ...NO_TOKENS, input: n, totalTokens: n });

	test("answers are grouped under the input before them, and those out of range are dropped", () => {
		const steps = [
			{ type: "input", entry: 1, submission: 100 },
			{ type: "answer", entry: 2, at: 10, tokens: tokens(1) },
			{ type: "answer", entry: 3, at: 20, tokens: tokens(2) },
			{ type: "input", entry: 4, submission: 101 },
			{ type: "answer", entry: 5, at: 30, tokens: tokens(4) },
		] as const;
		expect(rounds(steps, {})).toEqual([
			{ entry: 1, submission: 100, at: 10, answers: [2, 3], tokens: addTokens(tokens(1), tokens(2)) },
			{ entry: 4, submission: 101, at: 30, answers: [5], tokens: tokens(4) },
		]);
		expect(rounds(steps, { since: 15, until: 25 })).toEqual([
			{ entry: 1, submission: 100, at: 20, answers: [3], tokens: tokens(2) },
		]);
	});
});

describe("inspect on the real harness", () => {
	test("a round that failed is found with its reason and submission id", async () => {
		const soma = await core();
		const failed = await soma.say("壞掉");
		expect(failed.settled).toMatchObject({ status: "unanswered", reason: "model_error" });

		const found = await soma.ask({ what: "failures" });

		expect(found).toMatchObject({
			total: 1,
			items: [{ evidence: `submission:${failed.id}`, reason: "model_error", detail: "faux 壞了" }],
		});
		expect(found.truncated).toBeUndefined();
	});

	test("each round's usage is the sum of its answers' usage in the entries", async () => {
		const soma = await core();
		await soma.say("你好");
		await soma.say("派 card-a");

		const found = await soma.ask({ what: "usage" });

		const answers = (await soma.root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter(
			AssistantEntry.is,
		);
		const raw = new Map<number, Tokens>(
			answers.map((entry) => {
				const message = entry.model?.[0] as AssistantMessage;
				const { input, output, cacheRead, cacheWrite, totalTokens } = message.usage;
				return [entry.id, { input, output, cacheRead, cacheWrite, totalTokens, cost: message.usage.cost.total }];
			}),
		);
		// The last answer, 「好。」 after the tool result, was written after inspect read the entries.
		const counted = found.items.flatMap((round) => round.answers as number[]);
		expect(counted.sort((a, b) => a - b)).toEqual(answers.slice(0, -1).map((entry) => entry.id));
		// 你好, 派 card-a (tool call + answer), 自我檢視 (the tool call so far).
		expect(found.total).toBe(3);
		for (const round of found.items) {
			const sum = (round.answers as number[]).reduce(
				(total, id) => addTokens(total, raw.get(id) ?? NO_TOKENS),
				NO_TOKENS,
			);
			expect(round.tokens).toEqual(sum);
		}
		expect(found.items.some((round) => (round.tokens as Tokens).totalTokens > 0)).toBe(true);
	});

	test("answers and escalations are found with their reasons, and each job with its last state", async () => {
		const soma = await core();
		await soma.say("派 card-a");
		await soma.say("派 card-b");
		const prompt = { state: "blocked", kind: "permission", msg: "Bash command\ntouch x\n1. Yes\n2. No" } as const;
		soma.agents.emit("card-a", { ...prompt, fingerprint: "f00d" });
		await soma.settle();
		await new Promise((resolve) => setTimeout(resolve, 5));
		soma.agents.emit("card-b", { ...prompt, fingerprint: "beef" });
		await soma.settle();
		soma.agents.finish("card-a", "結果：完成");
		await soma.settle();
		const entries = (await soma.root.entries({ order: "ascending" }, 1000, undefined, context)).items;
		const done = entries.find((entry) => entry.kind === JOB_DONE);
		const dispatched = entries.filter((entry) => {
			const message = ToolResultEntry.is(entry) ? entry.model?.[0] : undefined;
			if (message?.role !== "toolResult" || message.toolName !== "dispatch") return false;
			const [block] = message.content;
			return block?.type === "text" && JSON.parse(block.text).card === "card-b";
		});

		expect(await soma.ask({ what: "decisions" })).toMatchObject({
			total: 2,
			items: [
				{ evidence: "decision:card-b#0", card: "card-b", action: "escalated", reason: "會動到正式資料" },
				{ evidence: "decision:card-a#0", card: "card-a", action: "answered", option: "1", reason: "只是建立一個空檔" },
			],
		});
		expect(await soma.ask({ what: "jobs" })).toMatchObject({
			total: 2,
			items: [
				// Not finished: cited by the dispatch call that recorded its job.
				{ card: "card-b", evidence: `entry:${dispatched[0]?.id}`, status: "blocked", decisions: 1 },
				// Finished: cited by its result entry.
				{ card: "card-a", evidence: `entry:${done?.id}`, status: "done", outcome: "完成", decisions: 1 },
			],
		});
	});

	test("past the limit only the newest rows come back, with a note of how many there are", async () => {
		const soma = await core();
		const ids = [];
		for (let n = 0; n < 3; n++) ids.push((await soma.say("壞掉")).id);

		const found = await soma.ask({ what: "failures", limit: 2 });

		expect(found.total).toBe(3);
		expect(found.items.map((row) => row.evidence)).toEqual([`submission:${ids[2]}`, `submission:${ids[1]}`]);
		expect(found.truncated).toContain("共 3 筆");
	});
});
