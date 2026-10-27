import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { runTerminal } from "../src/adapters/terminal/index.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { schedule } from "../src/core/extensions/schedule/index.ts";
import { openHarness } from "../src/core/harness.ts";
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
	const human = await openHumanPort(harness, root, new FakeAgentPort(), context);
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

const seedJob = (root: Awaited<ReturnType<typeof setup>>["root"]) =>
	root.commit(async (tx) => {
		(await tx.doc(Dispatches, root.id)).jobs = [
			{ card: "a", agent: "a", sessionId: "s", status: { state: "idle" }, decisions: [] },
		];
	}, context);

test("a reply that reaches the agent shows the round's input forwarded, before its answer", async () => {
	const { faux, root, human, seen } = await setup();
	await seedJob(root);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("reply", { card: "a", text: "hi", reason: "人說 hi" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("已轉給 a。"),
	]);

	await human.submit({ content: "跟 a 說 hi", entry: { kind: "chat.terminal" }, requestId: "terminal:1" });
	await root.waitForIdle(context);

	await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ type: "answer", requestId: "terminal:1" }));
	const progress = seen.filter((event) => event.type === "notice" || event.type === "answer");
	expect(progress).toEqual([
		{ type: "notice", kind: "forwarded", requestId: "terminal:1" },
		{ type: "answer", requestId: "terminal:1", content: "已轉給 a。" },
	]);
});

test("a reply to a card with no job forwards nothing", async () => {
	const { faux, root, human, seen } = await setup();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("reply", { card: "a", text: "hi", reason: "人說 hi" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("沒有這張卡片。"),
	]);

	await human.submit({ content: "跟 a 說 hi", entry: { kind: "chat.terminal" }, requestId: "terminal:1" });
	await root.waitForIdle(context);

	await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ type: "answer", requestId: "terminal:1" }));
	expect(seen.filter((event) => event.type === "notice")).toEqual([]);
});

test("notify delivers a notice with its kind and starts no run", async () => {
	const { human, seen } = await setup();

	await human.notify("job a needs a password", "question");

	await vi.waitFor(() =>
		expect(seen).toContainEqual({ type: "notice", kind: "question", content: "job a needs a password" }),
	);
	expect(seen.filter((event) => event.type === "run")).toEqual([{ type: "run", state: "idle" }]);
});

test("a notice appended before anyone subscribed reaches the first subscriber once", async () => {
	const { harness, root } = await setup();
	const human = await openHumanPort(harness, root, new FakeAgentPort(), context);
	cleanup.push(() => human.close());
	await human.notify("agent a is gone", "report");
	await root.waitForIdle(context);
	await new Promise((resolve) => setTimeout(resolve, 50));

	const first: SomaEvent[] = [];
	human.subscribe((event) => first.push(event));
	const second: SomaEvent[] = [];
	human.subscribe((event) => second.push(event));

	const gone = { type: "notice", kind: "report", content: "agent a is gone" };
	expect(first).toContainEqual(gone);
	expect(second).not.toContainEqual(gone);
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

const boom = () => {
	throw new Error("401 invalid x-api-key");
};

test("a round whose model throws reaches subscribers as one failure with its requestId and the reason", async () => {
	const { faux, root, human, seen } = await setup();
	faux.setResponses([boom]);

	await human.submit({ content: "你好", entry: { kind: "chat.terminal" }, requestId: "terminal:1" });
	await root.waitForIdle(context);

	await vi.waitFor(() => expect(seen.some((event) => event.type === "failure")).toBe(true));
	await new Promise((resolve) => setTimeout(resolve, 100));
	const failures = seen.filter((event) => event.type === "failure");
	expect(failures).toEqual([{ type: "failure", requestId: "terminal:1", reason: expect.stringMatching(/\S/) }]);
	expect(failures[0]?.reason).toContain("401 invalid x-api-key");
	expect(seen.filter((event) => event.type === "answer")).toEqual([]);
});

// The schedule extension starts the round, so no client owns it; the terminal shows it the way it shows a notice.
test("a scheduled round that fails is shown to the human through the terminal", { timeout: 15_000 }, async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("schedule", { at: "PT1S", instruction: "喝水" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("好。"),
		boom,
	]);
	const registry = createRegistry();
	registry.install(schedule((id, c) => harness.abortTask(id, c)));
	const harness: Harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const human = await openHumanPort(harness, root, new FakeAgentPort(), context);
	cleanup.push(() => human.close());
	const input = new PassThrough();
	const output = new PassThrough();
	let written = "";
	output.on("data", (chunk: Buffer) => {
		written += chunk.toString();
	});
	const terminal = runTerminal({ human, input, output, programStatus: false });
	cleanup.push(() => {
		input.end();
		return terminal;
	});

	input.write("提醒我 喝水\n");

	await vi.waitFor(() => expect(written).toMatch(/\[失敗\] schedule:\d+ 那一輪：模型出錯：401 invalid x-api-key\n/), {
		timeout: 10_000,
	});
});

test("a failure settled before a restart is not delivered again", async () => {
	const directory = await mkdtemp(join(tmpdir(), "soma-failure-restart-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const open = async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([boom]);
		const harness = await openHarness(join(directory, "soma.sqlite"), [], context, { models });
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		harness.resume();
		const human = await openHumanPort(harness, root, new FakeAgentPort(), context);
		const seen: SomaEvent[] = [];
		human.subscribe((event) => seen.push(event));
		const close = async () => {
			await human.close();
			await harness.close(context);
		};
		return { root, human, seen, close };
	};

	const first = await open();
	await first.human.submit({ content: "你好", entry: { kind: "chat.terminal" }, requestId: "terminal:1" });
	await first.root.waitForIdle(context);
	await vi.waitFor(() => expect(first.seen.filter((event) => event.type === "failure")).toHaveLength(1));
	await first.close();

	const second = await open();
	cleanup.push(second.close);
	await second.root.waitForIdle(context);
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(second.seen.filter((event) => event.type === "failure")).toEqual([]);
});

describe("push target and escalation", () => {
	const MIN = 60_000;
	const TELEGRAM = "chat.telegram";
	const TERMINAL = "chat.terminal";

	/** A HumanPort with a push target, on a clock the test moves; `open` reopens it on the same store, as a restart. */
	async function pushing() {
		const faux = fauxProvider();
		faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("好。")));
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		registry.install(dispatchExtension(new FakeAgentPort(), async (_repo, card) => `# ${card}`));
		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		cleanup.push(() => harness.close(context));
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		harness.resume();
		let clock = 100 * MIN;
		const open = async () => {
			const human = await openHumanPort(harness, root, new FakeAgentPort(), context, {
				defaultTarget: TELEGRAM,
				now: () => clock,
				checkMs: 10,
			});
			cleanup.push(() => human.close());
			const seen: SomaEvent[] = [];
			human.subscribe((event) => seen.push(event));
			return { human, seen };
		};
		const notices = (seen: SomaEvent[]) =>
			seen.flatMap((event) => (event.type === "notice" && event.kind !== "forwarded" ? [event] : []));
		const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
		return {
			root,
			open,
			notices,
			settle,
			advance: (ms: number) => {
				clock += ms;
			},
		};
	}

	test("a notice goes to the interface typed on last within 15 minutes, else to the default", async () => {
		const { root, open, notices, advance } = await pushing();
		const { human, seen } = await open();
		await human.notify("before any input", "report");
		await human.submit({ content: "嗨", entry: { kind: TERMINAL }, requestId: "terminal:1" });
		await root.waitForIdle(context);
		await human.notify("just after the terminal", "report");
		advance(16 * MIN);
		await human.notify("long after", "report");

		await vi.waitFor(() => expect(notices(seen)).toHaveLength(3));
		expect(notices(seen).map((notice) => [notice.content, notice.target])).toEqual([
			["before any input", TELEGRAM],
			["just after the terminal", TERMINAL],
			["long after", TELEGRAM],
		]);
	});

	test("an unheeded question is pushed to the default once after 15 minutes; a report never is", async () => {
		const { root, open, notices, settle, advance } = await pushing();
		const { human, seen } = await open();
		await human.submit({ content: "嗨", entry: { kind: TERMINAL }, requestId: "terminal:1" });
		await root.waitForIdle(context);
		await human.notify("which one?", "question");
		await human.notify("all done", "report");
		await vi.waitFor(() => expect(notices(seen)).toHaveLength(2));

		advance(14 * MIN);
		await settle();
		expect(notices(seen)).toHaveLength(2);
		advance(2 * MIN);
		await vi.waitFor(() => expect(notices(seen)).toHaveLength(3));
		await settle();
		expect(notices(seen).map((notice) => [notice.content, notice.target])).toEqual([
			["which one?", TERMINAL],
			["all done", TERMINAL],
			["which one?", TELEGRAM],
		]);
	});

	test("a question the human typed after is not pushed again", async () => {
		const { root, open, notices, settle, advance } = await pushing();
		const { human, seen } = await open();
		await human.submit({ content: "嗨", entry: { kind: TERMINAL }, requestId: "terminal:1" });
		await root.waitForIdle(context);
		await human.notify("which one?", "question");
		advance(MIN);
		await human.submit({ content: "等等", entry: { kind: TELEGRAM }, requestId: "telegram:1" });
		await root.waitForIdle(context);
		advance(20 * MIN);
		await settle();
		expect(notices(seen).map((notice) => notice.content)).toEqual(["which one?"]);
	});

	test("a pending escalation survives a restart and is pushed once across two", async () => {
		const { root, open, notices, settle, advance } = await pushing();
		const first = await open();
		await first.human.submit({ content: "嗨", entry: { kind: TERMINAL }, requestId: "terminal:1" });
		await root.waitForIdle(context);
		await first.human.notify("which one?", "question");
		await vi.waitFor(() => expect(notices(first.seen)).toHaveLength(1));
		await first.human.close();

		advance(16 * MIN);
		const second = await open();
		await vi.waitFor(() => expect(notices(second.seen)).toHaveLength(1));
		await second.human.close();
		const third = await open();
		await settle();
		expect(notices(second.seen)).toEqual([
			{ type: "notice", kind: "question", content: "which one?", target: TELEGRAM },
		]);
		expect(notices(third.seen)).toEqual([]);
	});
});
