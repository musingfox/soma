import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	LiveDoc,
	MemoryStorage,
	type SubmissionId,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { PRESETS } from "../src/core/domain/push.ts";
import { askExtension } from "../src/core/extensions/ask/index.ts";
import { inspectExtension } from "../src/core/extensions/inspect/index.ts";
import { Facts, memory } from "../src/core/extensions/memory/index.ts";
import { KEPT_STOPS, Stops, settleStops, stopGuard } from "../src/core/extensions/stop/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";
import type { SomaEvent } from "../src/ports/human.ts";
import { steppedModel } from "./stepped-model.ts";

const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

/**
 * A tool that runs until the test lets it end, and says when it started. With `nested`, it then calls the tool `inner`,
 * as a tool calls another through `executeTool`, before it ends.
 */
function slowTool({ nested = false } = {}) {
	let begun = false;
	let started = () => {};
	const running = new Promise<void>((resolve) => {
		started = () => {
			begun = true;
			resolve();
		};
	});
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let finished = false;
	let innerRan = false;
	const inner = defineTool({
		name: "inner",
		description: "Called by slow.",
		parameters: obj({}),
		replay: "safe",
		execute: async () => {
			innerRan = true;
			return { output: [{ type: "text" as const, text: "裡面" }], isError: false };
		},
	});
	const tool = defineTool({
		name: "slow",
		description: "Takes as long as the test says.",
		parameters: obj({}),
		replay: "safe",
		// Ends when its run is cut off, as when the process closes, as a real tool does.
		execute: async (_args, api, callContext) => {
			const { abortSignal } = callContext;
			started();
			await new Promise<void>((resolve, reject) => {
				gate.then(resolve);
				abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
			});
			if (nested) await api.executeTool("inner", {}, callContext);
			finished = true;
			return { output: [{ type: "text" as const, text: "查好了" }], isError: false };
		},
	});
	return {
		tools: [tool, inner],
		running,
		release,
		started: () => begun,
		finished: () => finished,
		innerRan: () => innerRan,
	};
}

/**
 * A real core over a model the test writes in steps, with the stop guard as main.ts installs it; `slow` makes the root
 * and `gated` the Harness the HumanPort is given.
 */
async function setup(
	options: {
		tool?: ReturnType<typeof slowTool>;
		slow?: (root: Conversation) => Conversation;
		gated?: (harness: Harness) => Harness;
		inspect?: boolean;
		/** The ask tool and push options, Telegram the default target at `summary`, so a reply's question rings there. */
		ask?: boolean;
	} = {},
) {
	const stepped = steppedModel();
	const storage = new MemoryStorage();
	const registry = createRegistry();
	registry.install(memory);
	registry.install(stopGuard);
	if (options.inspect === true) registry.install(inspectExtension(storage));
	if (options.ask === true) registry.install(askExtension({ storage, interfaces: ["chat.telegram"] }));
	if (options.tool !== undefined) registry.install(defineExtension({ name: "test.slow", tools: options.tool.tools }));
	const harness = await Harness.open(storage, { models: stepped.models, registry }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: stepped.model } });
	harness.resume();
	const human = await openHumanPort(
		options.gated?.(harness) ?? harness,
		options.slow?.(root) ?? root,
		new FakeAgentPort(),
		context,
		options.ask === true
			? { defaultTarget: "chat.telegram", policies: { "chat.telegram": PRESETS.summary }, storage }
			: undefined,
	);
	cleanup.push(() => human.close());
	const seen: SomaEvent[] = [];
	human.subscribe((event) => seen.push(event));
	const outcomes = () => seen.filter((event) => ["partial", "answer", "failure", "stopped"].includes(event.type));
	const signals = async () =>
		((await harness.snapshot(Facts, context))?.rows ?? []).filter((row) => row.kind.startsWith("signal."));
	return { stepped, harness, root, human, seen, outcomes, signals };
}

// Longer than pi-durable's 100 ms partial interval, so a partial that was coming has come.
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: (content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");

test("a stop while the model writes ends the round at once, told as stopped, and the next round sees the input without the partial", async () => {
	const { stepped, root, human, seen, outcomes, signals } = await setup();
	const [first, second] = [stepped.reply(), stepped.reply()];

	await human.submit({ content: "寫長一點", entry: { kind: "chat.telegram" }, requestId: "telegram:7" });
	await first.write("寫到一半");
	await vi.waitFor(() => expect(outcomes()).toHaveLength(1));
	expect(await human.stop("telegram:7")).toBe(true);
	await root.waitForIdle(context);
	await vi.waitFor(() => expect(seen).toContainEqual({ type: "stopped", requestId: "telegram:7" }));
	// The model's request was cancelled, not let run to its end.
	expect(first.aborted).toBe(true);
	await settle();
	expect(outcomes()).toEqual([
		{ type: "partial", requestIds: ["telegram:7"], content: "寫到一半" },
		{ type: "stopped", requestId: "telegram:7" },
	]);
	expect(seen).toContainEqual({ type: "run", state: "idle" });
	expect(await signals()).toEqual([]);
	// The stopped round is over: a second press stops nothing.
	expect(await human.stop("telegram:7")).toBe(false);

	await human.submit({ content: "換個問題", entry: { kind: "chat.telegram" }, requestId: "telegram:8" });
	await second.write("好");
	await second.end();
	await root.waitForIdle(context);
	await vi.waitFor(() => expect(seen).toContainEqual({ type: "answer", requestId: "telegram:8", content: "好" }));
	const messages = (second.messages ?? []).filter((message) => message.role !== "system");
	expect(messages.map((message) => [message.role, textOf(message.content)])).toEqual([
		["user", "寫長一點"],
		["user", "換個問題"],
	]);
	expect(await signals()).toEqual([]);
});

test("an abort the human did not ask for is still a failure with a signal", async () => {
	const { stepped, harness, root, human, outcomes, signals } = await setup();
	const reply = stepped.reply();

	await human.submit({ content: "寫", entry: { kind: "chat.telegram" }, requestId: "telegram:7" });
	await reply.write("寫到一半");
	await vi.waitFor(() => expect(outcomes()).toHaveLength(1));
	const run = (await harness.snapshot(LiveDoc, root.id, context))?.run;
	if (run === undefined) throw new Error("no run");
	await harness.abortTask(run.taskId, context);
	await root.waitForIdle(context);
	await vi.waitFor(() => expect(outcomes()).toHaveLength(2));
	expect(outcomes()[1]).toEqual({ type: "failure", requestId: "telegram:7", reason: "這一輪被中止" });
	await vi.waitFor(async () => expect(await signals()).toHaveLength(1));
});

test("a stop while a tool runs lets the tool finish, its own nested call included, and keeps its result, then ends the round before the model is asked again", async () => {
	const tool = slowTool({ nested: true });
	const { stepped, root, human, seen, outcomes, signals } = await setup({ tool });
	const [first, second] = [stepped.reply(), stepped.reply()];

	await human.submit({ content: "查一下", entry: { kind: "chat.telegram" }, requestId: "telegram:7" });
	await first.write("我先查");
	await vi.waitFor(() => expect(outcomes()).toHaveLength(1));
	await first.end(fauxToolCall("slow", {}));
	await tool.running;
	await vi.waitFor(() => expect(outcomes()).toHaveLength(2));
	expect(await human.stop("telegram:7")).toBe(true);
	// The tool is not aborted: the round waits for it.
	await settle();
	expect(seen.some((event) => event.type === "stopped")).toBe(false);
	// A second press while it waits takes nothing more.
	expect(await human.stop("telegram:7")).toBe(false);
	tool.release();
	await root.waitForIdle(context);
	await vi.waitFor(() => expect(seen).toContainEqual({ type: "stopped", requestId: "telegram:7" }));
	await settle();
	expect(tool.finished()).toBe(true);
	// The call the running tool made after the stop is its work, which the stop lets finish.
	expect(tool.innerRan()).toBe(true);
	// The model was never asked again, so nothing past the tool round's own text was shown.
	expect(second.messages).toBeUndefined();
	expect(outcomes()).toEqual([
		{ type: "partial", requestIds: ["telegram:7"], content: "我先查" },
		{ type: "partial", requestIds: ["telegram:7"], content: "" },
		{ type: "stopped", requestId: "telegram:7" },
	]);
	const { messages } = await root.context(context);
	expect(messages.find((message) => message.role === "toolResult")).toMatchObject({
		toolName: "slow",
		isError: false,
		content: [{ type: "text", text: "查好了" }],
	});
	expect(await signals()).toEqual([]);
});

test("inputs queued behind a stopped round run next with no further input; a stop of a queued, settled or unknown input stops nothing", async () => {
	const { stepped, harness, root, human, seen, outcomes } = await setup();
	const [first, second, third] = [stepped.reply(), stepped.reply(), stepped.reply()];

	await human.submit({ content: "一", entry: { kind: "chat.telegram" }, requestId: "telegram:1" });
	await first.write("一的");
	await vi.waitFor(() => expect(outcomes()).toHaveLength(1));
	await human.submit({ content: "二", entry: { kind: "chat.terminal" }, requestId: "terminal:2" });
	await human.submit({ content: "三", entry: { kind: "chat.telegram" }, requestId: "telegram:3" });
	expect(await human.stop("terminal:2")).toBe(false);
	expect(await human.stop("telegram:404")).toBe(false);
	expect(await human.stop("telegram:1")).toBe(true);
	// The queued inputs were not withdrawn: the next one runs without anyone typing.
	await second.write("二的");
	await vi.waitFor(() => expect(seen).toContainEqual({ type: "partial", requestIds: ["terminal:2"], content: "二的" }));
	// A late press for the stopped round does not stop the one running now.
	expect(await human.stop("telegram:1")).toBe(false);
	await second.end();
	await third.end();
	await root.waitForIdle(context);
	await vi.waitFor(() =>
		expect(seen).toContainEqual(expect.objectContaining({ type: "answer", requestId: "telegram:3" })),
	);
	expect(await human.stop("terminal:2")).toBe(false);
	expect(outcomes()).toEqual([
		{ type: "partial", requestIds: ["telegram:1"], content: "一的" },
		{ type: "stopped", requestId: "telegram:1" },
		{ type: "partial", requestIds: ["terminal:2"], content: "二的" },
		{ type: "answer", requestId: "terminal:2", content: "二的" },
		{ type: "answer", requestId: "telegram:3", content: "" },
	]);
	expect(
		second.messages?.filter((message) => message.role === "user").map((message) => textOf(message.content)),
	).toEqual(["一", "二"]);
	// The stop is recorded with its round, and settled once the round ended: nothing of it stays pending.
	const stopped = await root.commit((tx) => tx.submissionByRequest(root.id, "telegram:1"), context);
	expect((await harness.snapshot(Stops, root.id, context))?.stops).toEqual([
		{ round: stopped?.id, inputs: [stopped?.id], at: expect.any(Number), settled: true },
	]);
});

test("no partial of a stopped round is emitted, even one the watch saw before the stop and handled after it", async () => {
	// While `gate` is shut, reading a round's entries waits, and so do the commits and partials behind it.
	let open = () => {};
	let gate: Promise<void> | undefined;
	const { stepped, root, human, outcomes } = await setup({
		slow: (real) =>
			new Proxy(real, {
				get(target, key) {
					const value: unknown = Reflect.get(target, key, target);
					if (typeof value !== "function") return value;
					if (key !== "entries") return value.bind(target);
					return async (...args: unknown[]) => {
						await gate;
						return value.apply(target, args);
					};
				},
			}),
	});
	const [first, second] = [stepped.reply(), stepped.reply()];

	await human.submit({ content: "一", entry: { kind: "chat.terminal" }, requestId: "terminal:1" });
	await first.write("一的");
	await vi.waitFor(() => expect(outcomes()).toHaveLength(1));
	await human.submit({ content: "二", entry: { kind: "chat.telegram" }, requestId: "telegram:2" });
	gate = new Promise((resolve) => {
		open = resolve;
	});
	cleanup.push(async () => open());
	await first.end();
	// The second round streams while the first one's answer is still being handled, then is stopped.
	await second.write("二的");
	await settle();
	expect(await human.stop("telegram:2")).toBe(true);
	await root.waitForIdle(context);
	open();
	await vi.waitFor(() => expect(outcomes()).toHaveLength(3));
	await settle();
	expect(outcomes()).toEqual([
		{ type: "partial", requestIds: ["terminal:1"], content: "一的" },
		{ type: "answer", requestId: "terminal:1", content: "一的" },
		{ type: "stopped", requestId: "telegram:2" },
	]);
});

/**
 * soma's processes one after another on one database, each started as main.ts does: the HumanPort opens before the
 * tasks resume (`start`). Each process has its own stepped model and, with `tool`, its own slow tool.
 */
async function restartable() {
	const directory = await mkdtemp(join(tmpdir(), "soma-stop-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const db = join(directory, "soma.sqlite");
	return async (tool?: ReturnType<typeof slowTool>) => {
		const stepped = steppedModel();
		const slow = tool === undefined ? [] : [defineExtension({ name: "test.slow", tools: tool.tools })];
		const harness = await openHarness(db, [memory, stopGuard, ...slow], context, { models: stepped.models });
		const root = await harness.root(context, { agent: { model: stepped.model } });
		const human = await openHumanPort(harness, root, new FakeAgentPort(), context);
		const seen: SomaEvent[] = [];
		human.subscribe((event) => seen.push(event));
		let closed = false;
		const close = async () => {
			if (closed) return;
			closed = true;
			await human.close();
			await harness.close(context);
		};
		cleanup.push(close);
		const outcomes = () => seen.filter((event) => ["partial", "answer", "failure", "stopped"].includes(event.type));
		const signals = async () =>
			((await harness.snapshot(Facts, context))?.rows ?? []).filter((row) => row.kind.startsWith("signal."));
		return { stepped, harness, root, human, outcomes, signals, close, start: () => harness.resume() };
	};
}

test("a stop taken while a tool runs holds across a restart: the tool finishes, and the round ends stopped before the model is asked again", async () => {
	const process = await restartable();
	const firstTool = slowTool();
	const one = await process(firstTool);
	one.start();
	const reply = one.stepped.reply();
	await one.human.submit({ content: "查一下", entry: { kind: "chat.telegram" }, requestId: "telegram:7" });
	await reply.end(fauxToolCall("slow", {}));
	await firstTool.running;
	expect(await one.human.stop("telegram:7")).toBe(true);
	await one.close();

	// The tool is safe to run again, so the next process runs it again; the round still waits on it.
	const tool = slowTool();
	const two = await process(tool);
	const next = two.stepped.reply();
	two.start();
	await tool.running;
	await settle();
	expect(two.outcomes()).toEqual([]);
	tool.release();
	await vi.waitFor(() => expect(two.outcomes()).toEqual([{ type: "stopped", requestId: "telegram:7" }]));
	await two.root.waitForIdle(context);
	await settle();
	expect(tool.finished()).toBe(true);
	expect(next.messages).toBeUndefined();
	expect(two.outcomes()).toEqual([{ type: "stopped", requestId: "telegram:7" }]);
	expect(await two.signals()).toEqual([]);
});

test("a round whose stop was marked before a restart, and which settles after it, is told as stopped, not as a failure", async () => {
	const process = await restartable();
	const one = await process();
	one.start();
	const reply = one.stepped.reply();
	await one.human.submit({ content: "寫長一點", entry: { kind: "chat.telegram" }, requestId: "telegram:7" });
	await reply.write("寫到一半");
	await vi.waitFor(() => expect(one.outcomes()).toHaveLength(1));
	const run = (await one.harness.snapshot(LiveDoc, one.root.id, context))?.run;
	if (run === undefined) throw new Error("no run");
	expect(await one.human.stop("telegram:7")).toBe(true);
	// The abort is marked, and the process goes before its abort handler settles the round.
	expect(await one.harness.abortTask(run.taskId, context)).toBe("marked");
	await one.close();

	const two = await process();
	const input = await two.root.commit((tx) => tx.submissionByRequest(two.root.id, "telegram:7"), context);
	expect(input?.status).toBe("placed");
	two.start();
	await two.root.waitForIdle(context);
	await vi.waitFor(() => expect(two.outcomes()).toEqual([{ type: "stopped", requestId: "telegram:7" }]));
	await settle();
	expect(two.outcomes()).toEqual([{ type: "stopped", requestId: "telegram:7" }]);
	expect(await two.signals()).toEqual([]);
	expect((await two.harness.snapshot(Stops, two.root.id, context))?.stops).toEqual([
		{ round: input?.id, inputs: [input?.id], at: expect.any(Number), settled: true },
	]);
});

test("settled stops are kept up to a bound, the oldest dropped first; a pending one is always kept", async () => {
	const { models } = steppedModel();
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, {});
	const id = (n: number) => n as SubmissionId;
	await root.commit(async (tx) => {
		const doc = await tx.doc(Stops, root.id);
		doc.stops.push({ round: id(1), inputs: [id(1)], at: 1 });
		for (let n = 2; n <= KEPT_STOPS + 2; n++) doc.stops.push({ round: id(n), inputs: [id(n)], at: n, settled: true });
		doc.stops.push({ round: id(KEPT_STOPS + 3), inputs: [id(KEPT_STOPS + 3)], at: KEPT_STOPS + 3 });
	}, context);
	await root.commit((tx) => settleStops(tx, root.id, new Set([id(KEPT_STOPS + 3)])), context);
	const rounds = (await harness.snapshot(Stops, root.id, context))?.stops.map((stop) => stop.round);
	expect(rounds).toEqual([1, ...Array.from({ length: KEPT_STOPS }, (_, index) => index + 4)]);
});

test("a tool call the model makes after a stop was taken never runs, even when the abort lands only after the call was made", async () => {
	const tool = slowTool();
	// The abort mark waits until the test opens the gate, as when the model's tool round commits first.
	let open = () => {};
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	cleanup.push(async () => open());
	const { stepped, root, human, seen, outcomes, signals } = await setup({
		tool,
		gated: (real) =>
			new Proxy(real, {
				get(target, key) {
					const value: unknown = Reflect.get(target, key, target);
					if (typeof value !== "function") return value;
					if (key !== "abortTask") return value.bind(target);
					return async (...args: unknown[]) => {
						await gate;
						return value.apply(target, args);
					};
				},
			}),
	});
	const first = stepped.reply();
	stepped.reply();

	await human.submit({ content: "查一下", entry: { kind: "chat.telegram" }, requestId: "telegram:7" });
	await first.write("我先查");
	await vi.waitFor(() => expect(outcomes()).toHaveLength(1));
	expect(await human.stop("telegram:7")).toBe(true);
	// The model ends with a tool call before the abort is marked: the round's tool calls start.
	await first.end(fauxToolCall("slow", {}));
	await vi.waitFor(async () =>
		expect((await root.context(context)).messages.some((message) => message.role === "toolResult")).toBe(true),
	);
	expect(tool.started()).toBe(false);
	open();
	await root.waitForIdle(context);
	await vi.waitFor(() => expect(seen).toContainEqual({ type: "stopped", requestId: "telegram:7" }));
	await settle();
	expect(tool.started()).toBe(false);
	expect(outcomes()).toEqual([
		{ type: "partial", requestIds: ["telegram:7"], content: "我先查" },
		{ type: "stopped", requestId: "telegram:7" },
	]);
	const { messages } = await root.context(context);
	expect(messages.find((message) => message.role === "toolResult")).toMatchObject({ toolName: "slow", isError: true });
	expect(await signals()).toEqual([]);
});

test("the inspect tool's failures leave out a round the human stopped, and still list an abort the human did not ask for", async () => {
	const { stepped, harness, root, human, outcomes } = await setup({ inspect: true });
	const [stopped, aborted, asking, answering] = [stepped.reply(), stepped.reply(), stepped.reply(), stepped.reply()];
	const idOf = async (requestId: string) =>
		(await root.commit((tx) => tx.submissionByRequest(root.id, requestId), context))?.id;

	await human.submit({ content: "一", entry: { kind: "chat.telegram" }, requestId: "telegram:1" });
	await stopped.write("一的");
	await vi.waitFor(() => expect(outcomes()).toHaveLength(1));
	expect(await human.stop("telegram:1")).toBe(true);
	await root.waitForIdle(context);
	await human.submit({ content: "二", entry: { kind: "chat.telegram" }, requestId: "telegram:2" });
	await aborted.write("二的");
	await vi.waitFor(() => expect(outcomes()).toHaveLength(3));
	const run = (await harness.snapshot(LiveDoc, root.id, context))?.run;
	if (run === undefined) throw new Error("no run");
	await harness.abortTask(run.taskId, context);
	await root.waitForIdle(context);
	await vi.waitFor(() => expect(outcomes()).toHaveLength(4));
	expect(outcomes().map((event) => event.type)).toEqual(["partial", "stopped", "partial", "failure"]);

	await human.submit({ content: "哪幾輪失敗了", entry: { kind: "chat.telegram" }, requestId: "telegram:3" });
	await asking.end(fauxToolCall("inspect", { what: "failures" }));
	await answering.end();
	await root.waitForIdle(context);
	const result = (await root.context(context)).messages.find((message) => message.role === "toolResult");
	const found = JSON.parse(textOf(result?.content)) as { total: number; items: Record<string, unknown>[] };
	expect(found).toMatchObject({
		total: 1,
		items: [{ evidence: `submission:${await idOf("telegram:2")}`, reason: "aborted" }],
	});
	expect(found.items[0]).not.toHaveProperty("submission");
});

for (const next of ["asks", "only writes"] as const)
	test(`a round after a stopped one that asked in reply counts none of its entries: one that ${next}`, async () => {
		const { stepped, root, human, seen } = await setup({ ask: true });
		const [asking, writing, after, last] = [stepped.reply(), stepped.reply(), stepped.reply(), stepped.reply()];
		const question = (text: string) => fauxToolCall("ask", { question: text, options: ["好", "不用"] });
		const asked = () => seen.filter((event) => event.type === "notice" && event.kind === "question");

		await human.submit({ content: "一", entry: { kind: "chat.telegram" }, requestId: "telegram:1" });
		await asking.end(question("要先備份嗎？"));
		await vi.waitFor(() => expect(asked()).toHaveLength(1));
		expect(asked()[0]).toMatchObject({ delivery: { "chat.telegram": "ring" } });
		await writing.write("我在等");
		await vi.waitFor(() =>
			expect(seen).toContainEqual(expect.objectContaining({ type: "partial", content: "我在等" })),
		);
		await human.submit({ content: "二", entry: { kind: "chat.telegram" }, requestId: "telegram:2" });
		expect(await human.stop("telegram:1")).toBe(true);

		if (next === "asks") {
			await after.end(question("要重新部署嗎？"));
			await vi.waitFor(() => expect(asked()).toHaveLength(2));
			// The round's first question to the chat rings, as the stopped round's did.
			expect(asked()[1]).toMatchObject({ delivery: { "chat.telegram": "ring" } });
			await last.end();
		} else {
			await after.write("好");
			await after.end();
		}
		await root.waitForIdle(context);
		const answer = await vi.waitFor(() => {
			const found = seen.find((event) => event.type === "answer" && event.requestId === "telegram:2");
			expect(found).toBeDefined();
			return found;
		});
		// Only a question of its own round makes the answer one that asked.
		if (next === "asks") expect(answer).toMatchObject({ asked: true });
		else expect(answer).not.toHaveProperty("asked");
	});

test("a stop a restart left pending is enforced at open, though the round's live document does not change after it", async () => {
	const stepped = steppedModel();
	const registry = createRegistry();
	registry.install(stopGuard);
	const harness = await Harness.open(new MemoryStorage(), { models: stepped.models, registry }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: stepped.model } });
	harness.resume();
	const reply = stepped.reply();
	stepped.reply();
	await root.submit(
		{ type: "input", content: "寫長一點", entry: { kind: "chat.telegram" }, requestId: "telegram:7" },
		context,
	);
	await reply.write("寫到一半");
	await vi.waitFor(async () =>
		expect((await harness.snapshot(LiveDoc, root.id, context))?.generation?.message).toBeDefined(),
	);
	// The stop a HumanPort took and recorded before it went, before it asked for the abort.
	await root.commit(async (tx) => {
		const { run } = await tx.doc(LiveDoc, root.id);
		if (run === undefined) throw new Error("no run");
		(await tx.doc(Stops, root.id)).stops.push({ round: run.inputs[0] as SubmissionId, inputs: [...run.inputs], at: 1 });
	}, context);

	const human = await openHumanPort(harness, root, new FakeAgentPort(), context);
	cleanup.push(() => human.close());
	const seen: SomaEvent[] = [];
	human.subscribe((event) => seen.push(event));
	await vi.waitFor(() => expect(seen).toContainEqual({ type: "stopped", requestId: "telegram:7" }));
	await root.waitForIdle(context);
	expect(reply.aborted).toBe(true);
	expect(seen.filter((event) => event.type === "failure")).toEqual([]);
});

test("the inspect tool's failures still list a round a stop named that ended as a real failure", async () => {
	const { stepped, root, human, outcomes } = await setup({ inspect: true });
	const stopped = stepped.reply();
	const idOf = async (requestId: string) =>
		(await root.commit((tx) => tx.submissionByRequest(root.id, requestId), context))?.id;

	await human.submit({ content: "一", entry: { kind: "chat.telegram" }, requestId: "telegram:1" });
	await stopped.write("一的");
	await vi.waitFor(() => expect(outcomes()).toHaveLength(1));
	expect(await human.stop("telegram:1")).toBe(true);
	await root.waitForIdle(context);
	// No reply is queued, so the model fails; the round is one a stop named, as when the model failed before the abort.
	await human.submit({ content: "二", entry: { kind: "chat.telegram" }, requestId: "telegram:2" });
	await root.waitForIdle(context);
	await vi.waitFor(() => expect(outcomes().map((event) => event.type)).toEqual(["partial", "stopped", "failure"]));
	const failed = await idOf("telegram:2");
	if (failed === undefined) throw new Error("no submission");
	await root.commit(async (tx) => {
		(await tx.doc(Stops, root.id)).stops.push({ round: failed, inputs: [failed], at: 2, settled: true });
	}, context);

	const [asking, answering] = [stepped.reply(), stepped.reply()];
	await human.submit({ content: "哪幾輪失敗了", entry: { kind: "chat.telegram" }, requestId: "telegram:3" });
	await asking.end(fauxToolCall("inspect", { what: "failures" }));
	await answering.end();
	await root.waitForIdle(context);
	const result = (await root.context(context)).messages.find((message) => message.role === "toolResult");
	const found = JSON.parse(textOf(result?.content)) as { total: number; items: Record<string, unknown>[] };
	expect(found).toMatchObject({ total: 1, items: [{ evidence: `submission:${failed}`, reason: "model_error" }] });
});

test("a stopped round found settled at open, its continue not sent, has its stop end as a live one does: the queued input runs", async () => {
	const stepped = steppedModel();
	const registry = createRegistry();
	registry.install(stopGuard);
	const harness = await Harness.open(new MemoryStorage(), { models: stepped.models, registry }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: stepped.model } });
	harness.resume();
	const [first, second] = [stepped.reply(), stepped.reply()];
	const input = (content: string, requestId: string) =>
		root.submit({ type: "input", content, entry: { kind: "chat.telegram" }, requestId, whenBusy: "followUp" }, context);
	await input("一", "telegram:1");
	await first.write("一的");
	await vi.waitFor(async () =>
		expect((await harness.snapshot(LiveDoc, root.id, context))?.generation?.message).toBeDefined(),
	);
	const queued = await input("二", "telegram:2");
	// The stop recorded and its abort settled while no HumanPort listened, as a crash before the continue leaves it.
	const run = (await harness.snapshot(LiveDoc, root.id, context))?.run;
	if (run === undefined) throw new Error("no run");
	await root.commit(async (tx) => {
		(await tx.doc(Stops, root.id)).stops.push({ round: run.inputs[0] as SubmissionId, inputs: [...run.inputs], at: 1 });
	}, context);
	await harness.abortTask(run.taskId, context);
	await root.waitForIdle(context);
	expect((await queued.status(context)).status).toBe("queued");
	const last = await root.commit((tx) => tx.latestEntryId(root.id), context);

	const human = await openHumanPort(harness, root, new FakeAgentPort(), context);
	cleanup.push(() => human.close());
	const seen: SomaEvent[] = [];
	human.subscribe((event) => seen.push(event));
	await second.write("二的");
	await second.end();
	await vi.waitFor(() => expect(seen).toContainEqual({ type: "answer", requestId: "telegram:2", content: "二的" }));
	expect((await harness.snapshot(Stops, root.id, context))?.stops).toEqual([
		{ round: run.inputs[0], inputs: run.inputs, at: 1, settled: true },
	]);
	expect((await harness.snapshot(Stops, root.id, context))?.after).toBe(last);
});

test("a stopped round found at open that ended as a real failure leaves the input queued behind it queued, as any failure does", async () => {
	const stepped = steppedModel();
	const registry = createRegistry();
	registry.install(stopGuard);
	const harness = await Harness.open(new MemoryStorage(), { models: stepped.models, registry }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: stepped.model } });
	harness.resume();
	const first = stepped.reply();
	const input = (content: string, requestId: string) =>
		root.submit({ type: "input", content, entry: { kind: "chat.telegram" }, requestId, whenBusy: "followUp" }, context);
	const stopped = await input("一", "telegram:1");
	await first.write("一的");
	await vi.waitFor(async () =>
		expect((await harness.snapshot(LiveDoc, root.id, context))?.generation?.message).toBeDefined(),
	);
	const queued = await input("二", "telegram:2");
	const run = (await harness.snapshot(LiveDoc, root.id, context))?.run;
	if (run === undefined) throw new Error("no run");
	await root.commit(async (tx) => {
		(await tx.doc(Stops, root.id)).stops.push({ round: run.inputs[0] as SubmissionId, inputs: [...run.inputs], at: 1 });
	}, context);
	// The model fails before any abort: the round ends unanswered, not aborted.
	await first.fail("503 overloaded");
	await root.waitForIdle(context);
	expect(await stopped.status(context)).toMatchObject({ status: "unanswered", reason: "model_error" });

	const human = await openHumanPort(harness, root, new FakeAgentPort(), context);
	cleanup.push(() => human.close());
	await settle();
	await root.waitForIdle(context);
	expect((await queued.status(context)).status).toBe("queued");
	expect((await harness.snapshot(Stops, root.id, context))?.stops).toMatchObject([{ settled: true }]);
});
