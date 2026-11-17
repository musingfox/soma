import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type Conversation, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { openHumanPort } from "../src/core/human-port.ts";
import type { SomaEvent } from "../src/ports/human.ts";
import { steppedModel } from "./stepped-model.ts";

const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

/** `slow` makes the root the HumanPort is given in place of the real one. */
async function setup(slow?: (root: Conversation) => Conversation) {
	const stepped = steppedModel();
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: stepped.models, registry: createRegistry() },
		context,
	);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: stepped.model } });
	harness.resume();
	const human = await openHumanPort(harness, slow?.(root) ?? root, new FakeAgentPort(), context);
	cleanup.push(() => human.close());
	const seen: SomaEvent[] = [];
	human.subscribe((event) => seen.push(event));
	const partials = () => seen.filter((event) => event.type === "partial").map((event) => event.content);
	return { stepped, root, human, seen, partials };
}

// Longer than pi-durable's 100 ms partial interval, so a partial that was coming has come.
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

test("a growing answer reaches subscribers as its whole text so far under the round's requestIds, once per change", async () => {
	const { stepped, root, human, seen, partials } = await setup();
	const reply = stepped.reply();

	await human.submit({ content: "寫長一點", entry: { kind: "chat.telegram" }, requestId: "telegram:7" });
	// Thinking alone changes the partial but not its text.
	await reply.think("想一下");
	await settle();
	expect(partials()).toEqual([]);

	await reply.write("第一段");
	await vi.waitFor(() => expect(partials()).toEqual(["第一段"]));
	expect(seen.find((event) => event.type === "partial")).toEqual({
		type: "partial",
		requestIds: ["telegram:7"],
		content: "第一段",
	});
	await reply.think("再想");
	await settle();
	expect(partials()).toEqual(["第一段"]);

	// A subscriber that attaches mid-round gets the next partial, not the one before.
	const late: SomaEvent[] = [];
	human.subscribe((event) => late.push(event));
	await reply.write("，第二段");
	await vi.waitFor(() => expect(partials()).toEqual(["第一段", "第一段，第二段"]));
	expect(late.filter((event) => event.type === "partial")).toEqual([
		{ type: "partial", requestIds: ["telegram:7"], content: "第一段，第二段" },
	]);

	await reply.end();
	await root.waitForIdle(context);
	await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ type: "answer", requestId: "telegram:7" }));
	await settle();
	expect(seen.at(-1)).toEqual({ type: "answer", requestId: "telegram:7", content: "第一段，第二段" });
	expect(partials()).toEqual(["第一段", "第一段，第二段"]);
});

test("text written before a tool call streams, and the round's next generation starts over from empty", async () => {
	const { stepped, root, human, seen, partials } = await setup();
	const [first, second] = [stepped.reply(), stepped.reply()];

	await human.submit({ content: "查一下", entry: { kind: "chat.terminal" }, requestId: "terminal:1" });
	await first.write("我先查");
	await vi.waitFor(() => expect(partials()).toEqual(["我先查"]));
	// A tool the request did not offer: the call settles unavailable and the round goes on to its next generation.
	await first.end(fauxToolCall("nowhere", {}));
	await vi.waitFor(() => expect(partials()).toEqual(["我先查", ""]));
	await second.write("查到了");
	await vi.waitFor(() => expect(partials()).toEqual(["我先查", "", "查到了"]));
	await second.end();
	await root.waitForIdle(context);

	await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ type: "answer", requestId: "terminal:1" }));
	await settle();
	expect(seen.filter((event) => event.type === "partial")).toEqual(
		["我先查", "", "查到了"].map((content) => ({ type: "partial", requestIds: ["terminal:1"], content })),
	);
	expect(seen.at(-1)).toEqual({ type: "answer", requestId: "terminal:1", content: "查到了" });
});

test("a follow-up's round streams under its own requestId", async () => {
	const { stepped, root, human, seen } = await setup();
	const [first, second] = [stepped.reply(), stepped.reply()];

	await human.submit({ content: "一", entry: { kind: "chat.terminal" }, requestId: "terminal:1" });
	await first.write("一的");
	await vi.waitFor(() => expect(seen).toContainEqual({ type: "partial", requestIds: ["terminal:1"], content: "一的" }));
	await human.submit({ content: "二", entry: { kind: "chat.telegram" }, requestId: "telegram:2" });
	await first.end();
	// The same text in the next round is a change: it is that round's first.
	await second.write("一的");
	await vi.waitFor(() => expect(seen).toContainEqual({ type: "partial", requestIds: ["telegram:2"], content: "一的" }));
	await second.end();
	await root.waitForIdle(context);
	await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ type: "answer", requestId: "telegram:2" }));
	expect(seen.filter((event) => event.type === "partial" || event.type === "answer")).toEqual([
		{ type: "partial", requestIds: ["terminal:1"], content: "一的" },
		{ type: "answer", requestId: "terminal:1", content: "一的" },
		{ type: "partial", requestIds: ["telegram:2"], content: "一的" },
		{ type: "answer", requestId: "telegram:2", content: "一的" },
	]);
});

test("partials wait behind a slow commit handler, so each comes after the answer before its round and none after its own", async () => {
	// The handling of an answer reads its round's entries; while `gate` is shut, that read waits, and so do the commits
	// and partials behind it.
	let open = () => {};
	let gate: Promise<void> | undefined;
	const { stepped, root, human, seen } = await setup(
		(real) =>
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
	);
	const [first, second] = [stepped.reply(), stepped.reply()];
	const outcomes = () => seen.filter((event) => event.type === "partial" || event.type === "answer");

	await human.submit({ content: "一", entry: { kind: "chat.terminal" }, requestId: "terminal:1" });
	await first.write("一的");
	await vi.waitFor(() => expect(outcomes()).toHaveLength(1));
	await human.submit({ content: "二", entry: { kind: "chat.telegram" }, requestId: "telegram:2" });
	gate = new Promise((resolve) => {
		open = resolve;
	});
	// A failed check leaves it shut; the HumanPort cannot close behind it.
	cleanup.push(async () => open());
	await first.end();
	// The next round streams while the first one's answer is still being handled.
	await second.write("二的");
	await settle();
	expect(outcomes()).toEqual([{ type: "partial", requestIds: ["terminal:1"], content: "一的" }]);
	open();
	await vi.waitFor(() => expect(outcomes()).toHaveLength(3));
	await second.end();
	await root.waitForIdle(context);
	await vi.waitFor(() => expect(outcomes()).toHaveLength(4));
	await settle();
	expect(outcomes()).toEqual([
		{ type: "partial", requestIds: ["terminal:1"], content: "一的" },
		{ type: "answer", requestId: "terminal:1", content: "一的" },
		{ type: "partial", requestIds: ["telegram:2"], content: "二的" },
		{ type: "answer", requestId: "telegram:2", content: "二的" },
	]);
});
