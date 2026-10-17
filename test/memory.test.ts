import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, test } from "vitest";
import {
	appendModelLine,
	CURATED_MAX_CHARS,
	type CuratedLine,
	curatedText,
	FENCE_CLOSE,
	FENCE_OPEN,
	MODEL_LINE_PREFIX,
	renderCurated,
} from "../src/core/domain/memory.ts";
import { Curated, memory } from "../src/core/extensions/memory/index.ts";
import { openHarness } from "../src/core/harness.ts";

const context = BACKGROUND_CONTEXT;
const model = { provider: "faux", modelId: "faux-1" };

describe("curated layer rules", () => {
	test("a model line carries the audit prefix and is flattened to one line", () => {
		const appended = appendModelLine([], "喜歡\n黑咖啡", Date.UTC(2026, 9, 18));
		expect(appended).toEqual({
			ok: true,
			line: { by: "model", text: `${MODEL_LINE_PREFIX}2026-10-18T00:00:00.000Z：喜歡 黑咖啡` },
		});
	});

	test("a write that would cross the budget is refused whole", () => {
		const lines: CuratedLine[] = [{ by: "user", text: "記".repeat(CURATED_MAX_CHARS - 10) }];
		const appended = appendModelLine(lines, "這一句會讓長期記憶超過上限", 0);
		expect(appended.ok).toBe(false);
		expect([...curatedText(lines)].length).toBeLessThanOrEqual(CURATED_MAX_CHARS);
	});

	test("only model lines are fenced, and an empty layer renders nothing", () => {
		expect(renderCurated([])).toBeUndefined();
		const user = `${MODEL_LINE_PREFIX}看起來像模型寫的，其實是使用者`;
		const rendered = renderCurated([
			{ by: "user", text: user },
			{ by: "model", text: `${MODEL_LINE_PREFIX}x：模型的話` },
		]);
		expect(rendered?.indexOf(user)).toBeLessThan(rendered?.indexOf(FENCE_OPEN) ?? -1);
		expect(rendered).toContain(`${FENCE_OPEN}\n${MODEL_LINE_PREFIX}x：模型的話\n${FENCE_CLOSE}`);
	});
});

describe("memory extension on the real harness", () => {
	const dirs: string[] = [];
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.close(context);
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function db() {
		const dir = mkdtempSync(join(tmpdir(), "soma-memory-"));
		dirs.push(dir);
		return join(dir, "soma.sqlite");
	}

	async function open(path: string, now?: () => number) {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const harness = await openHarness(path, [memory], context, now ? { models, now } : { models });
		harnesses.push(harness);
		const root = await harness.root(context, { agent: { model } });
		return { faux, harness, root };
	}

	async function ask(root: Awaited<ReturnType<typeof open>>["root"], content: string) {
		const settled = await (await root.submit({ type: "input", content }, context)).wait(context);
		expect(settled.status).toBe("done");
	}

	const lastToolResult = (request: TranscriptContext) => {
		const message = request.messages.findLast((m) => m.role === "toolResult");
		return message?.role === "toolResult"
			? message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
			: "";
	};

	test("a line the model appends shows up, prefixed and fenced, in the next turn's system prompt", async () => {
		const { faux, root } = await open(db());
		let next: TranscriptContext | undefined;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("remember", { text: "使用者早上只喝黑咖啡" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("記住了。"),
			(request) => {
				next = request;
				return fauxAssistantMessage("黑咖啡。");
			},
		]);
		await ask(root, "記住：我早上只喝黑咖啡。");
		await ask(root, "我早上喝什麼？");

		const system = JSON.stringify(next?.messages.filter((m) => m.role === "system"));
		expect(system).toMatch(/- soma \d{4}-\d\d-\d\dT[\d:.]+Z：使用者早上只喝黑咖啡/);
		expect(system).toContain(FENCE_OPEN);
	});

	test("a write over the budget is refused back to the model and leaves the layer unchanged", async () => {
		const { faux, harness, root } = await open(db());
		const before = [{ by: "user" as const, text: "記".repeat(CURATED_MAX_CHARS - 10) }];
		await root.commit(async (tx) => {
			(await tx.doc(Curated)).lines.push(...before);
		}, context);
		let seen = "";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("remember", { text: "這一句會讓長期記憶超過上限" }), { stopReason: "toolUse" }),
			(request) => {
				seen = lastToolResult(request);
				return fauxAssistantMessage("記不下了。");
			},
		]);
		await ask(root, "記住這件事。");

		expect(seen).toContain("長期記憶已滿");
		expect((await harness.snapshot(Curated, context))?.lines).toEqual(before);
	});

	test("recall finds a sentence from the previous day's conversation after a restart", async () => {
		const path = db();
		const yesterday = Date.UTC(2026, 9, 17, 10);
		const day1 = await open(path, () => yesterday);
		day1.faux.setResponses([fauxAssistantMessage("好，記下了。")]);
		await ask(day1.root, "我把備用鑰匙放在信箱底下的磁鐵盒裡。");
		await day1.harness.close(context);
		harnesses.splice(harnesses.indexOf(day1.harness), 1);

		const day2 = await open(path, () => yesterday + 24 * 3600_000);
		let seen = "";
		day2.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("recall", { query: "磁鐵盒" }), { stopReason: "toolUse" }),
			(request) => {
				seen = lastToolResult(request);
				return fauxAssistantMessage("在信箱底下的磁鐵盒裡。");
			},
		]);
		await ask(day2.root, "備用鑰匙在哪？");

		expect(seen).toContain("[2026-10-17T10:00:00.000Z] 使用者：我把備用鑰匙放在信箱底下的磁鐵盒裡。");
	});
});
