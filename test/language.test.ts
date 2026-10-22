import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { afterAll, expect, test } from "vitest";
import { language } from "../src/core/extensions/language/index.ts";
import { openHarness } from "../src/core/harness.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "soma-language-"));
let harness: Harness | undefined;
afterAll(async () => {
	await harness?.close(context);
	rmSync(dir, { recursive: true, force: true });
});

test("the system prompt names the configured language and its tag", async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	harness = await openHarness(join(dir, "soma.sqlite"), [language("zh-Hant")], context, { models });
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	let seen: TranscriptContext | undefined;
	faux.setResponses([
		(request: TranscriptContext) => {
			seen = request;
			return fauxAssistantMessage("好。");
		},
	]);

	expect((await (await root.submit({ type: "input", content: "hi" }, context)).wait(context)).status).toBe("done");

	expect(JSON.stringify(seen?.messages.filter((m) => m.role === "system"))).toContain("一律用 繁體中文（zh-Hant）");
});
