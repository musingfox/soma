import { existsSync, readFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { McpClient, StdioTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { z } from "zod";

const StdioServer = z.object({
	command: z.string(),
	args: z.array(z.string()).default([]),
	env: z.record(z.string(), z.string()).default({}),
});
export type StdioServer = z.infer<typeof StdioServer>;

const McpConfig = z.object({ servers: z.record(z.string(), StdioServer) });

/** `{ "servers": { "<name>": { "command", "args", "env" } } }`; a missing file means no MCP servers. */
export function loadMcpConfig(path: string): Record<string, StdioServer> {
	return existsSync(path) ? McpConfig.parse(JSON.parse(readFileSync(path, "utf8"))).servers : {};
}

export async function connectStdio(server: StdioServer): Promise<McpClient> {
	const client = new McpClient({ name: "soma", version: "0.0.0" });
	const transport = new StdioTransport({ ...server, stderr: "pipe" });
	try {
		await client.connect(transport);
	} catch (error) {
		throw new Error(`${server.command} did not start: ${transport.stderr.trim()}`, { cause: error });
	}
	return client;
}

// Providers allow at most 64 characters of [A-Za-z0-9_-].
const toolName = (server: string, tool: string) => `${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

/** Every tool the server lists, under `<server>_<tool>`. None may rerun on recovery: sending mail cannot be replayed. */
export async function mcpExtension(server: string, client: McpClient): Promise<Extension> {
	const tools = (await client.listTools()).map((tool) =>
		defineTool({
			name: toolName(server, tool.name),
			description: tool.description ?? tool.title ?? tool.name,
			// Providers require an object schema, and some reject one without `properties`.
			parameters: Type.Unsafe<Record<string, unknown>>({
				...tool.inputSchema,
				type: "object",
				properties: tool.inputSchema.properties ?? {},
			}),
			replay: "unsafe",
			execute: async (args, _api, context) => {
				const result = await client.callTool(tool.name, args, { signal: context.abortSignal });
				// MCP reports tool failures in the result instead of as a protocol error.
				return { output: toLlmContent(result), isError: result.isError === true };
			},
		}),
	);
	return defineExtension({ name: `soma.mcp.${server}`, tools });
}
