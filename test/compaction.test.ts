import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CompactionEntry, type Harness } from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { clock } from "../src/core/extensions/clock/index.ts";
import { inspectExtension } from "../src/core/extensions/inspect/index.ts";
import { language } from "../src/core/extensions/language/index.ts";
import { memory } from "../src/core/extensions/memory/index.ts";
import { stopGuard } from "../src/core/extensions/stop/index.ts";
import { tools } from "../src/core/extensions/tools/index.ts";
import { openHarness, openStorage, rootCompaction } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";
import { startCore } from "../src/core/startup.ts";
import type { SomaEvent } from "../src/ports/human.ts";

const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const each of cleanup.splice(0).reverse()) await each();
});

const SUMMARY = "## Goal\n- 閒聊（faux 的摘要）";
// About 7000 tokens each at pi-ai's 3.5 characters a token, so the fourth input passes a compactAt of 25000.
const filler = (n: number) => `第 ${n} 段：${"今天天氣很好，我們去散步吧。".repeat(1750)}`;
const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: (content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");

test("a root conversation past compactAt is compacted on its own, restated once after the summary, and still recalled", async () => {
	const directory = await mkdtemp(join(tmpdir(), "soma-compaction-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const requests: TranscriptContext[] = [];
	const results: string[] = [];
	faux.setResponses(
		Array.from({ length: 20 }, () => (request: TranscriptContext) => {
			const first = request.messages[0];
			if (first?.role === "system" && textOf(first.content).includes("context summarization assistant")) {
				return fauxAssistantMessage(SUMMARY);
			}
			requests.push(request);
			const last = request.messages.at(-1);
			if (last?.role === "toolResult") {
				results.push(textOf(last.content));
				return fauxAssistantMessage("好了。");
			}
			if (textOf(last?.content).includes("記住鳳梨暗號")) return fauxAssistantMessage("好，鳳梨暗號是七十七。");
			if (textOf(last?.content).includes("記下來"))
				return fauxAssistantMessage([fauxToolCall("remember", { text: "住在台北" })], { stopReason: "toolUse" });
			if (textOf(last?.content).includes("找一下"))
				return fauxAssistantMessage([fauxToolCall("recall", { query: "鳳梨暗號" })], { stopReason: "toolUse" });
			return fauxAssistantMessage("好。");
		}),
	);
	const storage = await openStorage(join(directory, "soma.sqlite"));
	const settings = rootCompaction(25_000, faux.getModel());
	expect(settings).toBeDefined();
	const extensions = [
		clock(() => Date.parse("2026-11-18T10:00:00+08:00"), "Asia/Taipei"),
		language("zh-Hant"),
		stopGuard,
		memory,
		inspectExtension(storage),
		tools,
	];
	const harness: Harness = await openHarness(storage, extensions, context, {
		models,
		...(settings !== undefined && { settings: { compaction: settings } }),
	});
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: faux.getModel().id } } });
	const human = await startCore(harness, () => openHumanPort(harness, root, new FakeAgentPort(), context));
	cleanup.push(() => human.close());
	const seen: SomaEvent[] = [];
	human.subscribe((event) => seen.push(event));
	const say = async (content: string, n: number) => {
		await human.submit({ content, entry: { kind: "chat.terminal" }, requestId: `terminal:${n}` });
		await vi.waitFor(() =>
			expect(seen).toContainEqual(expect.objectContaining({ type: "answer", requestId: `terminal:${n}` })),
		);
		await root.waitForIdle(context);
	};
	const compactions = async () => (await root.context(context)).entries.filter((entry) => CompactionEntry.is(entry));

	await say(`${filler(1)}記住鳳梨暗號是七十七。`, 1);
	await say(filler(2), 2);
	// The memory section the remembered line brings is a system entry among those the compaction keeps.
	await say(`${filler(3)}我住在台北，記下來。`, 3);
	await say(filler(4), 4);
	// Nothing in the test asked for it: the fourth request passed compactAt and started one in the background.
	await vi.waitFor(async () => expect(await compactions()).toHaveLength(1), { timeout: 5_000 });
	const before = requests.length;
	// Before it: the first baseline, then the memory section, new in the middle, removed and re-added with the rest.
	expect(requests[before - 1]?.messages.filter((message) => message.role === "system")).toHaveLength(3);

	await say("找一下我之前說的暗號", 5);

	expect(seen).toContainEqual({ type: "answer", requestId: "terminal:5", content: "好了。" });
	const after = requests[before];
	const said = after?.messages.map((message) => textOf("content" in message ? message.content : "")) ?? [];
	// The summary, then what was kept verbatim; the first input is only in the summary.
	expect(said.some((text) => text.includes(SUMMARY))).toBe(true);
	expect(said.some((text) => text.includes("第 4 段"))).toBe(true);
	expect(said.some((text) => text.includes("鳳梨暗號是七十七"))).toBe(false);
	// One system message, every section and every tool in it once; none of the earlier ones.
	const system = after?.messages.filter((message) => message.role === "system") ?? [];
	expect(system).toHaveLength(1);
	const agent = await root.agent(context);
	const toolNames = agent.tools.map((tool) => tool.name);
	expect(toolNames).toEqual(expect.arrayContaining(["recall", "inspect", "remember"]));
	const added = (system[0] as { toolsAdded?: { name: string }[] }).toolsAdded?.map((tool) => tool.name);
	expect(added).toEqual(toolNames);
	const sections = Object.keys((system[0] as { sections?: Record<string, string | null> }).sections ?? {});
	expect(sections).toEqual(agent.sections.map((section) => section.key));
	expect(sections).toEqual(expect.arrayContaining(["clock", "language", "memory", "tools"]));
	expect(JSON.stringify(system[0])).toContain("住在台北");
	// recall reads storage, not the model's context, so the compacted first answer is still found. (Only soma's side:
	// recall takes pi.user entries, and the HumanPort submits under the interface's own kind.)
	expect(results.at(-1)).toContain("soma：好，鳳梨暗號是七十七。");
});
