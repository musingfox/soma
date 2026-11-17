import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { afterAll, expect, test } from "vitest";
import { TOOLS_RULE, tools } from "../src/core/extensions/tools/index.ts";
import { openHarness } from "../src/core/harness.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "soma-tools-rule-"));
let harness: Harness | undefined;
afterAll(async () => {
	await harness?.close(context);
	rmSync(dir, { recursive: true, force: true });
});

test("the system prompt tells the model its tool list is current and earlier denials may be out of date", async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	harness = await openHarness(join(dir, "soma.sqlite"), [tools], context, { models });
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	let seen: TranscriptContext | undefined;
	faux.setResponses([
		(request: TranscriptContext) => {
			seen = request;
			return fauxAssistantMessage("好。");
		},
	]);

	expect((await (await root.submit({ type: "input", content: "hi" }, context)).wait(context)).status).toBe("done");

	expect(TOOLS_RULE).toContain("以現在的工具清單為準");
	expect(TOOLS_RULE).toContain("可能已經過時");
	expect(JSON.stringify(seen?.messages.filter((m) => m.role === "system"))).toContain(TOOLS_RULE);
});
