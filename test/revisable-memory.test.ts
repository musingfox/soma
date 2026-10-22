import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineDoc, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, test } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { type CuratedLine, EVIDENCE_ID, MODEL_LINE_PREFIX } from "../src/core/domain/memory.ts";
import { Curated, memory } from "../src/core/extensions/memory/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";
import type { SomaEvent } from "../src/ports/human.ts";

const context = BACKGROUND_CONTEXT;
const model = { provider: "faux", modelId: "faux-1" };
const OLD = `${MODEL_LINE_PREFIX}2026-10-17T00:00:00.000Z：使用者喜歡早上九點開會`;

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.close(context);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function db() {
	const dir = mkdtempSync(join(tmpdir(), "soma-revise-"));
	dirs.push(dir);
	return join(dir, "soma.sqlite");
}

async function open(path = db()) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await openHarness(path, [memory], context, { models });
	harnesses.push(harness);
	const root = await harness.root(context, { agent: { model } });
	await root.commit(async (tx) => {
		const curated = await tx.doc(Curated);
		if (curated.lines.length > 0) return;
		curated.lines.push({ id: 1, by: "model", text: OLD });
		curated.next = 2;
	}, context);
	return { faux, harness, root };
}

async function ask(root: Awaited<ReturnType<typeof open>>["root"], content: string) {
	const settled = await (await root.submit({ type: "input", content }, context)).wait(context);
	expect(settled.status).toBe("done");
}

const call = (name: string, args: JsonObject) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

const lastToolResult = (request: TranscriptContext) => {
	const message = request.messages.findLast((m) => m.role === "toolResult");
	return message?.role === "toolResult"
		? message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
		: "";
};

// Later system messages replace sections by name, so the memory section in effect is the last one that names it.
const memoryOf = (request: TranscriptContext | undefined) => {
	for (const message of [...(request?.messages ?? [])].reverse()) {
		if (message.role === "system" && message.sections?.memory !== undefined) return message.sections.memory ?? "";
	}
	return "";
};

const revise = (text: string, evidence: string[] = ["submission:3"]) =>
	call("revise_memory", { line: 1, text, reason: "使用者說改到十點了", evidence });

test("evidence ids follow the format agreed with the self-inspect tool", () => {
	for (const id of ["entry:12", "submission:3", "task:7", "document:2@41", "decision:card-a#0"])
		expect(id).toMatch(EVIDENCE_ID);
	for (const id of [
		"",
		"entry",
		"entry:",
		"entry:x",
		"turn:3",
		"document:2",
		" entry:1",
		"entry:1 ",
		"decision:card a#0",
	]) {
		expect(id).not.toMatch(EVIDENCE_ID);
	}
});

describe("revising the curated layer on the real harness", () => {
	test("a revised line replaces the old one in the next turn's system prompt", async () => {
		const { faux, root } = await open();
		let next: TranscriptContext | undefined;
		faux.setResponses([
			revise("使用者喜歡早上十點開會"),
			fauxAssistantMessage("改好了。"),
			(request) => {
				next = request;
				return fauxAssistantMessage("十點。");
			},
		]);
		await ask(root, "我現在都改十點開會了。");
		await ask(root, "我喜歡幾點開會？");

		expect(memoryOf(next)).toMatch(/\[#1\] - soma [\d\-T:.]+Z：使用者喜歡早上十點開會/);
		expect(memoryOf(next)).not.toContain("九點");
	});

	test.each([
		["no evidence", []],
		["a malformed evidence id", ["那次對話"]],
	])("a revision with %s is refused back to the model and changes nothing", async (_, evidence) => {
		const { faux, harness, root } = await open();
		let seen = "";
		faux.setResponses([
			revise("使用者喜歡早上十點開會", evidence),
			(request) => {
				seen = lastToolResult(request);
				return fauxAssistantMessage("改不了。");
			},
		]);
		await ask(root, "我現在都改十點開會了。");

		expect(seen).toMatch(/沒有修訂：.*(evidence 是空的|證據 id 格式不對)/);
		const curated = await harness.snapshot(Curated, context);
		expect(curated?.lines).toEqual([{ id: 1, by: "model", text: OLD }]);
		expect(curated?.history).toEqual([]);
	});

	test("a restore brings back the chosen old version and keeps every revision in history", async () => {
		const { faux, harness, root } = await open();
		let listed = "";
		let next: TranscriptContext | undefined;
		faux.setResponses([
			revise("使用者喜歡早上十點開會"),
			call("forget_memory", { line: 1, reason: "使用者說不用記開會時間", evidence: ["entry:9"] }),
			call("memory_history", { line: 1 }),
			(request) => {
				listed = lastToolResult(request);
				return call("restore_memory", { line: 1, version: 1, reason: "使用者說九點才對", evidence: ["entry:12"] });
			},
			fauxAssistantMessage("還原了。"),
			(request) => {
				next = request;
				return fauxAssistantMessage("九點。");
			},
		]);
		await ask(root, "改一改，然後還原。");
		await ask(root, "我喜歡幾點開會？");

		expect(listed).toContain(`第 1 版（修訂前的原文）：${OLD}`);
		expect(listed).toMatch(/第 2 版（.* 修改，理由：使用者說改到十點了）：.*十點/);
		expect(listed).toMatch(/第 3 版（.* 刪除，理由：使用者說不用記開會時間）：（已刪除）/);
		expect(memoryOf(next)).toContain(`[#1] ${OLD}`);
		expect(memoryOf(next)).not.toContain("十點");

		const curated = await harness.snapshot(Curated, context);
		const revised: CuratedLine = { by: "model", text: expect.stringContaining("十點") as unknown as string };
		expect(curated?.history).toEqual([
			expect.objectContaining({ line: 1, action: "revise", before: { by: "model", text: OLD }, after: revised }),
			expect.objectContaining({ line: 1, action: "forget", before: revised, after: null, evidence: ["entry:9"] }),
			expect.objectContaining({ line: 1, action: "restore", before: null, after: { by: "model", text: OLD } }),
		]);
		expect(curated?.history.every((revision) => revision.at > 0 && revision.reason !== "")).toBe(true);
	});

	test("a user line the model revises becomes the model's, and a restore gives it back to the user", async () => {
		const { faux, harness, root } = await open();
		await root.commit(async (tx) => {
			const curated = await tx.doc(Curated);
			curated.lines = [{ id: 1, by: "user", text: "我對花生過敏" }];
		}, context);
		faux.setResponses([
			revise("使用者對花生和蝦過敏"),
			call("restore_memory", { line: 1, version: 1, reason: "使用者說蝦不算", evidence: ["entry:4"] }),
			fauxAssistantMessage("好。"),
		]);
		await ask(root, "改一改，然後還原。");

		const curated = await harness.snapshot(Curated, context);
		expect(curated?.history[0]?.after?.by).toBe("model");
		expect(curated?.lines).toEqual([{ id: 1, by: "user", text: "我對花生過敏" }]);
	});

	test("every revision reaches the human as a notice through HumanPort", async () => {
		const { faux, harness, root } = await open();
		const port = await openHumanPort(harness, root, new FakeAgentPort(), context);
		const events: SomaEvent[] = [];
		port.subscribe((event) => events.push(event));
		faux.setResponses([
			revise("使用者喜歡早上十點開會"),
			call("restore_memory", { line: 1, version: 1, reason: "使用者說九點才對", evidence: ["entry:12"] }),
			revise("沒有證據的修訂", []),
			fauxAssistantMessage("好。"),
		]);
		await ask(root, "改一改，然後還原。");
		await root.waitForIdle(context);
		await port.close();

		const notices = events.flatMap((event) => (event.type === "notice" ? [event] : []));
		expect(notices).toEqual([
			{
				type: "notice",
				kind: "report",
				content: expect.stringMatching(/修改了長期記憶 #1：.*九點.*→.*十點.*submission:3/),
			},
			{
				type: "notice",
				kind: "report",
				content: expect.stringMatching(/還原了長期記憶 #1：.*使用者說九點才對.*entry:12/),
			},
		]);
	});

	test("a curated layer stored before revisions existed reopens with numbered lines and empty history", async () => {
		const path = db();
		const V1 = defineDoc<{ lines: CuratedLine[] }>({
			kind: "soma.memory.curated",
			version: 1,
			scope: "session",
			initial: () => ({ lines: [] }),
		});
		const old = await openHarness(path, [], context);
		await (await old.root(context)).commit(async (tx) => {
			(await tx.doc(V1)).lines.push({ by: "user", text: "甲" }, { by: "model", text: OLD });
		}, context);
		await old.close(context);

		const { harness } = await open(path);
		expect(await harness.snapshot(Curated, context)).toEqual({
			next: 3,
			lines: [
				{ id: 1, by: "user", text: "甲" },
				{ id: 2, by: "model", text: OLD },
			],
			history: [],
		});
	});
});
