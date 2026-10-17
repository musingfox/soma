import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { afterAll, expect, test } from "vitest";
import { clock, renderNow } from "../src/core/extensions/clock/index.ts";
import { openHarness } from "../src/core/harness.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "soma-clock-"));
let harness: Harness | undefined;
afterAll(async () => {
	await harness?.close(context);
	rmSync(dir, { recursive: true, force: true });
});

test("the date, weekday, time and offset are those of the configured time zone", () => {
	expect(renderNow(Date.UTC(2026, 9, 18, 23, 30), "Asia/Taipei")).toBe(
		"現在是 2026-10-19（星期一）07:30，時區 Asia/Taipei（GMT+08:00）。",
	);
});

test("each turn's system prompt carries the injected clock's date", async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let at = Date.UTC(2026, 9, 18, 6, 5);
	harness = await openHarness(join(dir, "soma.sqlite"), [clock(() => at, "Asia/Taipei")], context, { models });
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	const seen: TranscriptContext[] = [];
	const reply = (request: TranscriptContext) => {
		seen.push(request);
		return fauxAssistantMessage("好。");
	};
	faux.setResponses([reply, reply]);
	const ask = async (content: string) =>
		expect((await (await root.submit({ type: "input", content }, context)).wait(context)).status).toBe("done");
	const system = (request: TranscriptContext | undefined) =>
		JSON.stringify(request?.messages.filter((m) => m.role === "system"));

	await ask("今天有什麼會？");
	expect(system(seen[0])).toContain("2026-10-18（星期日）14:05，時區 Asia/Taipei");

	at = Date.UTC(2026, 9, 19, 1, 0);
	await ask("那今天呢？");
	expect(system(seen[1])).toContain("2026-10-19（星期一）09:00，時區 Asia/Taipei");
});
