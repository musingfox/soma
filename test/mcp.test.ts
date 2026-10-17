import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import type { McpClient } from "@earendil-works/pi-mcp";
import { afterAll, beforeAll, expect, test } from "vitest";
import { connectStdio, loadMcpConfig, mcpExtension } from "../src/core/extensions/mcp/index.ts";
import { openHarness } from "../src/core/harness.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "soma-mcp-"));
// The reference server from the MCP project, spawned over stdio like any third-party server.
const everything = {
	command: process.execPath,
	args: [
		resolve(import.meta.dirname, "../node_modules/@modelcontextprotocol/server-everything/dist/index.js"),
		"stdio",
	],
	env: {},
};

let client: McpClient;
let harness: Harness | undefined;
beforeAll(async () => {
	client = await connectStdio(everything);
});
afterAll(async () => {
	await harness?.close(context);
	await client.close();
	rmSync(dir, { recursive: true, force: true });
});

test("the server's tools are listed under its name and none may rerun on recovery", async () => {
	const extension = await mcpExtension("everything", client);
	const names = extension.tools?.map((tool) => tool.name) ?? [];
	expect(names).toContain("everything_get-sum");
	expect(names).toContain("everything_echo");
	expect(extension.tools?.every((tool) => tool.replay === "unsafe")).toBe(true);
});

test("the model calls an MCP tool through the harness and reads its result", async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	harness = await openHarness(join(dir, "soma.sqlite"), [await mcpExtension("everything", client)], context, {
		models,
	});
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	let seen: TranscriptContext | undefined;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("everything_get-sum", { a: 2, b: 40 }), { stopReason: "toolUse" }),
		(request) => {
			seen = request;
			return fauxAssistantMessage("42。");
		},
	]);
	const settled = await (await root.submit({ type: "input", content: "2 加 40 是多少？" }, context)).wait(context);
	expect(settled.status).toBe("done");

	const result = seen?.messages.findLast((m) => m.role === "toolResult");
	expect(result?.role === "toolResult" && result.isError).toBe(false);
	expect(JSON.stringify(result?.content)).toContain("42");
});

test("a missing config file means no servers; a present one is parsed", () => {
	expect(loadMcpConfig(join(dir, "absent.json"))).toEqual({});
	const path = join(dir, "mcp.json");
	writeFileSync(path, JSON.stringify({ servers: { google: { command: "uvx", args: ["workspace-mcp"] } } }));
	expect(loadMcpConfig(path)).toEqual({ google: { command: "uvx", args: ["workspace-mcp"], env: {} } });
});
