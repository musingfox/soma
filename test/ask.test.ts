import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { askExtension, Questions } from "../src/core/extensions/ask/index.ts";
import { openHumanPort } from "../src/core/human-port.ts";
import { NOTICE } from "../src/core/notice.ts";
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
	const storage = new MemoryStorage();
	registry.install(askExtension({ storage, interfaces: ["chat.terminal"] }));
	const harness = await Harness.open(storage, { models, registry }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const human = await openHumanPort(harness, root, new FakeAgentPort(), context);
	cleanup.push(() => human.close());
	const seen: SomaEvent[] = [];
	human.subscribe((event) => seen.push(event));

	/** One round in which the model calls ask with `options`; resolves to the tool's result as the model saw it. */
	async function ask(options: string[], requestId = "terminal:1") {
		let result: { isError: boolean; body: unknown } | undefined;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("ask", { question: "要我稍後再試一次嗎？", options })], {
				stopReason: "toolUse",
			}),
			(request) => {
				const message = JSON.parse(JSON.stringify(request.messages.at(-1)));
				result = { isError: message.isError, body: JSON.parse(message.content[0].text) };
				return fauxAssistantMessage("問了。");
			},
		]);
		await human.submit({ content: "試試看", entry: { kind: "chat.terminal" }, requestId });
		await root.waitForIdle(context);
		return result;
	}
	const notices = async () =>
		(await root.entries({ order: "ascending" }, 100, undefined, context)).items.filter(
			(entry) => entry.kind === NOTICE,
		);
	return { faux, harness, root, human, seen, ask, notices };
}

const choicesOf = (event: SomaEvent | undefined) =>
	event?.type === "notice" && event.kind === "question" ? event.choices : undefined;

test("ask appends a question notice of class action carrying its options, naming no card", async () => {
	const { ask, notices, seen } = await setup();

	expect(await ask(["好", "不用"])).toEqual({ isError: false, body: { asked: true, note: expect.any(String) } });

	const [notice] = await notices();
	const question = (notice?.data as { choices?: { question?: unknown } } | undefined)?.choices?.question;
	expect(question).toMatch(/^[0-9a-f]{16}$/);
	expect(notice?.data).toEqual({
		kind: "question",
		class: "action",
		content: "要我稍後再試一次嗎？",
		choices: {
			question,
			options: [
				{ id: "1", label: "好" },
				{ id: "2", label: "不用" },
			],
		},
		// The round's input came from the terminal: the question is part of the reply to it.
		replyTo: ["chat.terminal"],
	});
	await vi.waitFor(() => expect(choicesOf(seen.find((event) => event.type === "notice"))).toBeDefined());
	expect(seen).toContainEqual({
		type: "notice",
		kind: "question",
		class: "action",
		content: "要我稍後再試一次嗎？",
		choices: notice?.data && (notice.data as { choices: unknown }).choices,
	});
});

test("the tool's description names no interface: each says what it shows in its own text", () => {
	const description = askExtension({ storage: new MemoryStorage(), interfaces: [] }).tools?.[0]?.description ?? "";
	expect(description).toContain("one press");
	expect(description).not.toMatch(/telegram|web|terminal|chat\./i);
});

test("the description and the result tell the model the question went on its own and to end with no text", async () => {
	const { ask } = await setup();
	const description = askExtension({ storage: new MemoryStorage(), interfaces: [] }).tools?.[0]?.description ?? "";
	const note = ((await ask(["好", "不用"]))?.body as { note?: string } | undefined)?.note ?? "";
	for (const told of [description, note]) {
		expect(told).toMatch(/sent to the human as its own message/);
		expect(told).toMatch(/end your turn with no text, unless the human needs something else besides the question/);
	}
});

test("ask refuses fewer than 2 or more than 4 options, and asks nothing", async () => {
	const { ask, notices } = await setup();

	expect(await ask(["好"], "terminal:1")).toEqual({
		isError: true,
		body: { asked: false, error: "give 2 to 4 options, not 1" },
	});
	expect(await ask(["一", "二", "三", "四", "五"], "terminal:2")).toEqual({
		isError: true,
		body: { asked: false, error: "give 2 to 4 options, not 5" },
	});
	expect(await notices()).toEqual([]);
	expect((await ask(["一", "二", "三", "四"], "terminal:3"))?.isError).toBe(false);
	expect(await notices()).toHaveLength(1);
});

test("ask refuses an empty, an overlong or a repeated option", async () => {
	const { ask, notices } = await setup();

	expect((await ask(["好", " "], "terminal:1"))?.body).toEqual({ asked: false, error: "an option is empty" });
	expect((await ask(["好", "x".repeat(41)], "terminal:2"))?.body).toMatchObject({ asked: false });
	expect((await ask(["好", "好"], "terminal:3"))?.body).toEqual({ asked: false, error: "two options are the same" });
	expect(await notices()).toEqual([]);
});

test("a press is the human's input with the option's label, runs a round, and settles the question once", async () => {
	const { faux, harness, root, human, seen, ask } = await setup();
	await ask(["好", "不用"]);
	const choices = choicesOf(seen.find((event) => event.type === "notice"));
	if (choices === undefined || "card" in choices) throw new Error("no question with options");

	let heard = "";
	faux.setResponses([
		(request) => {
			heard = JSON.stringify(request.messages.at(-1));
			return fauxAssistantMessage("那我稍後再試。");
		},
		fauxAssistantMessage("不該有這一輪"),
	]);
	const pressed = await human.say(choices.question, "1", {
		entry: { kind: "chat.telegram", data: { pressed: 9 } },
		requestId: "telegram:ask/q",
	});
	expect(pressed).toEqual({ said: true, label: "好" });
	await root.waitForIdle(context);
	expect(JSON.parse(heard)).toMatchObject({ role: "user", content: "好" });
	await vi.waitFor(() =>
		expect(seen).toContainEqual({ type: "answer", requestId: "telegram:ask/q", content: "那我稍後再試。" }),
	);
	expect(seen).toContainEqual({ type: "said", question: choices.question, label: "好" });
	const { items } = await root.entries({ order: "ascending" }, 100, undefined, context);
	expect(items.filter((entry) => entry.kind === "chat.telegram").map((entry) => entry.data)).toEqual([{ pressed: 9 }]);

	// A second press, here or on another interface, admits nothing and names the option said.
	const again = await human.say(choices.question, "2", { entry: { kind: "chat.web" }, requestId: "web:again" });
	expect(again).toEqual({ said: false, refusal: "settled", label: "好" });
	await root.waitForIdle(context);
	expect(faux.state.callCount).toBe(3);
	expect(seen.filter((event) => event.type === "said")).toHaveLength(1);
	const doc = await harness.snapshot(Questions, root.id, context);
	expect(doc?.questions[choices.question]?.said).toBe("1");
});

test("a press on an option or a question that does not exist admits nothing", async () => {
	const { faux, root, human, seen, ask } = await setup();
	await ask(["好", "不用"]);
	const choices = choicesOf(seen.find((event) => event.type === "notice"));
	if (choices === undefined || "card" in choices) throw new Error("no question with options");
	const input = { entry: { kind: "chat.telegram" }, requestId: "telegram:ask/x" };

	expect(await human.say(choices.question, "3", input)).toEqual({ said: false, refusal: "unknown_option" });
	expect(await human.say("0000000000000000", "1", input)).toEqual({ said: false, refusal: "no_question" });
	await root.waitForIdle(context);
	expect(faux.state.callCount).toBe(2);
	// Still open: a later press on a real option goes through.
	faux.setResponses([fauxAssistantMessage("好的。")]);
	expect(await human.say(choices.question, "2", input)).toEqual({ said: true, label: "不用" });
});

test("a question id that names a key of every object's prototype is refused as no question, not thrown on", async () => {
	const { faux, root, human, ask } = await setup();
	await ask(["好", "不用"]);
	const input = { entry: { kind: "chat.telegram" }, requestId: "telegram:ask/proto" };

	for (const question of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"])
		expect([question, await human.say(question, "1", input)]).toEqual([
			question,
			{ said: false, refusal: "no_question" },
		]);
	await root.waitForIdle(context);
	expect(faux.state.callCount).toBe(2);
});

test("a call replayed under the same call id finds its question and appends no second notice", async () => {
	const { faux, root, human, notices } = await setup();
	const call = (id: string, question: string) =>
		fauxAssistantMessage([fauxToolCall("ask", { question, options: ["好", "不用"] }, { id })], {
			stopReason: "toolUse",
		});
	const results: string[] = [];
	const answer = (request: { messages: unknown[] }) => {
		results.push(JSON.parse(JSON.stringify(request.messages.at(-1))).content[0].text);
		return fauxAssistantMessage("問了。");
	};
	faux.setResponses([
		call("call-1", "要我稍後再試嗎？"),
		answer,
		call("call-1", "要我稍後再試嗎？"),
		answer,
		call("call-2", "要我稍後再試嗎？"),
		answer,
	]);
	for (const requestId of ["terminal:1", "terminal:2", "terminal:3"]) {
		await human.submit({ content: "試試看", entry: { kind: "chat.terminal" }, requestId });
		await root.waitForIdle(context);
	}

	expect(results.map((text) => JSON.parse(text).asked)).toEqual([true, true, true]);
	const questions = (await notices()).map(
		(entry) => (entry.data as { choices: { question: string } }).choices.question,
	);
	expect(questions).toHaveLength(2);
	expect(new Set(questions).size).toBe(2);
});
