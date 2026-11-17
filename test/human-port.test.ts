import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type Conversation, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { runTerminal } from "../src/adapters/terminal/index.ts";
import { type Policies, PRESETS } from "../src/core/domain/push.ts";
import { Questions } from "../src/core/extensions/ask/index.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { schedule } from "../src/core/extensions/schedule/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { openHumanPort, Pushes, type PushOptions } from "../src/core/human-port.ts";
import { NOTICE, noticeEntry } from "../src/core/notice.ts";
import type { SomaEvent } from "../src/ports/human.ts";
import { ringing } from "./ringing.ts";

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

test("a follow-up input that starts the next run in the commit ending the first shows idle, then working", async () => {
	const { faux, root, human, seen } = await setup();
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	faux.setResponses([
		async () => {
			await gate;
			return fauxAssistantMessage("一");
		},
		fauxAssistantMessage("二"),
	]);

	await human.submit({ content: "a", entry: { kind: "chat.terminal" }, requestId: "terminal:1" });
	await vi.waitFor(() => expect(seen).toContainEqual({ type: "run", state: "working" }));
	await human.submit({ content: "b", entry: { kind: "chat.terminal" }, requestId: "terminal:2" });
	release();
	await root.waitForIdle(context);

	await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ type: "answer", requestId: "terminal:2" }));
	expect(seen).toEqual([
		{ type: "run", state: "idle" },
		{ type: "run", state: "working" },
		{ type: "run", state: "idle" },
		{ type: "answer", requestId: "terminal:1", content: "一" },
		{ type: "run", state: "working" },
		{ type: "run", state: "idle" },
		{ type: "answer", requestId: "terminal:2", content: "二" },
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

	await human.notify("job a needs a password", "question", "action");

	await vi.waitFor(() =>
		expect(seen).toContainEqual({
			type: "notice",
			kind: "question",
			class: "action",
			content: "job a needs a password",
		}),
	);
	expect(seen.filter((event) => event.type === "run")).toEqual([{ type: "run", state: "idle" }]);
});

test("a notice appended before anyone subscribed reaches the first subscriber once", async () => {
	const { harness, root } = await setup();
	const human = await openHumanPort(harness, root, new FakeAgentPort(), context);
	cleanup.push(() => human.close());
	await human.notify("agent a is gone", "report", "outcome");
	await root.commit(async (tx) => {
		const status = { state: "idle" } as const;
		(await tx.doc(Dispatches, root.id)).jobs = [{ card: "a", agent: "a", sessionId: "s", status, decisions: [] }];
	}, context);
	await root.waitForIdle(context);
	await new Promise((resolve) => setTimeout(resolve, 50));

	const first: SomaEvent[] = [];
	human.subscribe((event) => first.push(event));
	const second: SomaEvent[] = [];
	human.subscribe((event) => second.push(event));

	const gone = { type: "notice", kind: "report", class: "outcome", content: "agent a is gone" };
	expect(first).toContainEqual(gone);
	expect(second).not.toContainEqual(gone);
	// After the held notice, so a client retires the buttons of a prompt the job has moved past.
	expect(first.findIndex((event) => event.type === "job")).toBeGreaterThan(first.findIndex((e) => e.type === "notice"));
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

test("a notice written without a class is a fault: it is logged and pushed as an action, never quietly", async () => {
	const { root, seen } = await setup();
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	cleanup.push(async () => errors.mockRestore());

	await root.submit(
		{ type: "write", entry: { kind: NOTICE, data: { kind: "report", content: "who am I?" } } },
		context,
	);

	await vi.waitFor(() =>
		expect(seen).toContainEqual({ type: "notice", kind: "report", class: "action", content: "who am I?" }),
	);
	expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^\[soma\] fault: a notice without a class/));
});

const boom = () => {
	throw new Error("401 invalid x-api-key");
};

/** A HumanPort over a harness with the schedule tool, whose model answers with `responses`. */
async function scheduling(
	responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
	push?: PushOptions,
) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("schedule", { at: "PT1S", instruction: "喝水" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("好。"),
		...responses,
	]);
	const registry = createRegistry();
	registry.install(schedule((id, c) => harness.abortTask(id, c)));
	const harness: Harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const human = await openHumanPort(harness, root, new FakeAgentPort(), context, push);
	cleanup.push(() => human.close());
	const seen: SomaEvent[] = [];
	human.subscribe((event) => seen.push(event));
	await human.submit({ content: "提醒我 喝水", entry: { kind: "chat.terminal" }, requestId: "terminal:1" });
	return seen;
}

test("a scheduled round's answer is pushed as an outcome; the answer of a round the human started is not", async () => {
	const seen = await scheduling([fauxAssistantMessage("該喝水了。")]);

	await vi.waitFor(() => expect(seen.filter((event) => event.type === "answer")).toHaveLength(2), { timeout: 10_000 });
	expect(seen.filter((event) => event.type === "answer")).toEqual([
		{ type: "answer", requestId: "terminal:1", content: "好。" },
		{ type: "answer", requestId: expect.stringMatching(/^schedule:/), content: "該喝水了。", class: "outcome" },
	]);
});

test("a scheduled round's answer follows the outcome policies: logged on Telegram at ask", async () => {
	const policies = { "chat.telegram": PRESETS.ask, "chat.terminal": PRESETS.instant };
	const seen = await scheduling([fauxAssistantMessage("該喝水了。")], { policies });

	await vi.waitFor(() => expect(seen.filter((event) => event.type === "answer")).toHaveLength(2), { timeout: 10_000 });
	expect(seen.filter((event) => event.type === "answer").at(-1)).toMatchObject({
		class: "outcome",
		delivery: { "chat.telegram": "log", "chat.terminal": "ring" },
	});
});

test("a pushed round's failure is an outcome; the failure of a round the human started is not pushed", async () => {
	const seen = await scheduling([boom]);

	await vi.waitFor(() => expect(seen.some((event) => event.type === "failure")).toBe(true), { timeout: 10_000 });
	expect(seen.filter((event) => event.type === "failure")).toEqual([
		{ type: "failure", requestId: expect.stringMatching(/^schedule:/), reason: expect.any(String), class: "outcome" },
	]);
});

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
	const WEB = "chat.web";

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
		const open = async (policies?: Policies) => {
			const human = await openHumanPort(harness, root, new FakeAgentPort(), context, {
				defaultTarget: TELEGRAM,
				...(policies && { policies }),
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
		await human.notify("before any input", "report", "outcome");
		await human.submit({ content: "嗨", entry: { kind: TERMINAL }, requestId: "terminal:1" });
		await root.waitForIdle(context);
		await human.notify("just after the terminal", "report", "outcome");
		advance(16 * MIN);
		await human.notify("long after", "report", "outcome");

		await vi.waitFor(() => expect(notices(seen)).toHaveLength(3));
		expect(notices(seen).map((notice) => [notice.content, ringing(notice)])).toEqual([
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
		await human.notify("which one?", "question", "action");
		await human.notify("all done", "report", "outcome");
		await vi.waitFor(() => expect(notices(seen)).toHaveLength(2));

		advance(14 * MIN);
		await settle();
		expect(notices(seen)).toHaveLength(2);
		advance(2 * MIN);
		await vi.waitFor(() => expect(notices(seen)).toHaveLength(3));
		await settle();
		expect(notices(seen).map((notice) => [notice.content, ringing(notice)])).toEqual([
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
		await human.notify("which one?", "question", "action");
		advance(MIN);
		await human.submit({ content: "等等", entry: { kind: TELEGRAM }, requestId: "telegram:1" });
		await root.waitForIdle(context);
		advance(20 * MIN);
		await settle();
		expect(notices(seen).map((notice) => notice.content)).toEqual(["which one?"]);
	});

	const options = [
		{ id: "1", label: "好" },
		{ id: "2", label: "不用" },
	];
	const ask = (root: Conversation, question: string) =>
		root.submit(
			{ type: "write", entry: noticeEntry("question", "action", `問 ${question}`, { question, options }) },
			context,
		);

	test("a press on a question's option counts as the human's presence on that interface, as typing does", async () => {
		const { root, open, notices, advance } = await pushing();
		const { human, seen } = await open();
		await root.commit(async (tx) => {
			(await tx.doc(Questions, root.id)).questions = { q1: { options } };
		}, context);
		await human.submit({ content: "嗨", entry: { kind: TERMINAL }, requestId: "terminal:1" });
		await root.waitForIdle(context);
		advance(16 * MIN);
		expect(await human.say("q1", "1", { entry: { kind: WEB }, requestId: "web:1" })).toEqual({
			said: true,
			label: "好",
		});
		await root.waitForIdle(context);
		await human.notify("after the press", "report", "outcome");

		await vi.waitFor(() => expect(notices(seen)).toHaveLength(1));
		expect(notices(seen).map((notice) => [notice.content, ringing(notice)])).toEqual([["after the press", WEB]]);
		const presence = await root.commit(async (tx) => ({ ...(await tx.doc(Pushes, root.id)).presence }), context);
		expect(presence[WEB]).toBe(116 * MIN);
	});

	test("a question whose option was said is not pushed again; one still open is", async () => {
		const { root, open, notices, settle, advance } = await pushing();
		const { human, seen } = await open();
		await root.commit(async (tx) => {
			(await tx.doc(Questions, root.id)).questions = { q1: { options }, q2: { options } };
		}, context);
		await human.submit({ content: "嗨", entry: { kind: TERMINAL }, requestId: "terminal:1" });
		await root.waitForIdle(context);
		await ask(root, "q1");
		await ask(root, "q2");
		await vi.waitFor(() => expect(notices(seen)).toHaveLength(2));
		// Said as a press writes it, with no input after the push, so only the said question tells it from q2.
		await root.commit(async (tx) => {
			const doc = await tx.doc(Questions, root.id);
			doc.questions.q1 = { options, said: "2" };
		}, context);

		advance(16 * MIN);
		await vi.waitFor(() => expect(notices(seen)).toHaveLength(3));
		await settle();
		expect(notices(seen).map((notice) => [notice.content, ringing(notice)])).toEqual([
			["問 q1", TERMINAL],
			["問 q2", TERMINAL],
			["問 q2", TELEGRAM],
		]);
	});

	test("a pending escalation survives a restart and is pushed once across two", async () => {
		const { root, open, notices, settle, advance } = await pushing();
		const first = await open();
		await first.human.submit({ content: "嗨", entry: { kind: TERMINAL }, requestId: "terminal:1" });
		await root.waitForIdle(context);
		await first.human.notify("which one?", "question", "action");
		await vi.waitFor(() => expect(notices(first.seen)).toHaveLength(1));
		await first.human.close();

		advance(16 * MIN);
		const second = await open();
		await vi.waitFor(() => expect(notices(second.seen)).toHaveLength(1));
		await second.human.close();
		const third = await open();
		await settle();
		expect(notices(second.seen)).toEqual([
			{
				type: "notice",
				kind: "question",
				class: "action",
				content: "which one?",
				delivery: { [TELEGRAM]: "ring" },
			},
		]);
		expect(notices(third.seen)).toEqual([]);
	});

	const ASK = { [TELEGRAM]: PRESETS.ask, [TERMINAL]: PRESETS.instant };

	test("with Telegram at ask and nobody typing, a question rings there and nothing else reaches it", async () => {
		const { open, notices } = await pushing();
		const { human, seen } = await open(ASK);
		await human.notify("which one?", "question", "action");
		await human.notify("card a 完成", "report", "outcome");
		await human.notify("記下了", "report", "ambient");

		await vi.waitFor(() => expect(notices(seen)).toHaveLength(3));
		expect(notices(seen).map((notice) => [notice.content, notice.delivery])).toEqual([
			["which one?", { [TELEGRAM]: "ring", [TERMINAL]: "quiet" }],
			["card a 完成", { [TELEGRAM]: "log", [TERMINAL]: "quiet" }],
			["記下了", { [TELEGRAM]: "log", [TERMINAL]: "quiet" }],
		]);
	});

	test("under ask, an unheeded question still escalates to Telegram and rings there", async () => {
		const { root, open, notices, advance } = await pushing();
		const { human, seen } = await open(ASK);
		await human.submit({ content: "嗨", entry: { kind: TERMINAL }, requestId: "terminal:1" });
		await root.waitForIdle(context);
		await human.notify("which one?", "question", "action");
		advance(16 * MIN);

		await vi.waitFor(() => expect(notices(seen)).toHaveLength(2));
		expect(notices(seen).map((notice) => notice.delivery)).toEqual([
			{ [TELEGRAM]: "quiet", [TERMINAL]: "ring" },
			{ [TELEGRAM]: "ring", [TERMINAL]: "quiet" },
		]);
	});

	test("an escalation is kept only while Telegram's policy shows its class", async () => {
		const { root, open, notices, settle, advance } = await pushing();
		const muted = { action: "log", outcome: "log", ambient: "log" } as const;
		const { human, seen } = await open({ [TELEGRAM]: muted });
		await human.submit({ content: "嗨", entry: { kind: TERMINAL }, requestId: "terminal:1" });
		await root.waitForIdle(context);
		await human.notify("which one?", "question", "action");
		await vi.waitFor(() => expect(notices(seen)).toHaveLength(1));
		expect(await root.commit(async (tx) => (await tx.doc(Pushes, root.id)).pending.length, context)).toBe(0);
		advance(16 * MIN);
		await settle();
		expect(notices(seen)).toHaveLength(1);
		await human.close();

		// A failure kept while Telegram was instant, then the config set it to ask: it is dropped, not pushed.
		await root.commit(async (tx) => {
			(await tx.doc(Pushes, root.id)).pending = [
				{ key: "failure:9", at: 100 * MIN, kind: "report", class: "outcome", content: "schedule:1 那一輪失敗" },
			];
		}, context);
		const again = await open(ASK);
		await vi.waitFor(async () =>
			expect(await root.commit(async (tx) => (await tx.doc(Pushes, root.id)).pending.length, context)).toBe(0),
		);
		await settle();
		expect(notices(again.seen)).toEqual([]);
	});

	test("an escalation kept before pushes had classes is pushed as an action if a question, else an outcome", async () => {
		const { root, open, notices, advance } = await pushing();
		await root.commit(async (tx) => {
			(await tx.doc(Pushes, root.id)).pending = [
				{ key: "notice:1", at: 100 * MIN, kind: "question", content: "old question" },
				{ key: "failure:2", at: 100 * MIN, kind: "report", content: "schedule:1 那一輪失敗" },
			];
		}, context);
		advance(16 * MIN);
		const { seen } = await open();

		await vi.waitFor(() => expect(notices(seen)).toHaveLength(2));
		expect(notices(seen).map((notice) => [notice.content, notice.class])).toEqual([
			["old question", "action"],
			["schedule:1 那一輪失敗", "outcome"],
		]);
	});
});
