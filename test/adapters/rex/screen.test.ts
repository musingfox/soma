import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { createRexAgentPort } from "../../../src/adapters/rex/agent-port.ts";
import { dispatchExtension } from "../../../src/core/extensions/dispatch/index.ts";
import { AT, type Block, git, HANGAR, rex, type Session } from "./fake.ts";

const context = BACKGROUND_CONTEXT;
const open: Harness[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
});

/**
 * The real core over the rex adapter on the in-memory rex, with card-a dispatched: the window start() opens becomes a
 * block of the hangar, labelled with its session id. `work` is the human's session beside it.
 */
async function dispatched(work: Session) {
	const blocks: Block[] = [];
	const fake = rex(blocks, [work]);
	const original = fake.client.call.bind(fake.client);
	fake.client.call = async (method, payload, schema) => {
		if (method === "session.new_window") {
			const { window_label, layout } = payload as { window_label: string; layout: { block: { label: string } } };
			blocks.push({ name: window_label, block: "block:a", label: layout.block.label, argv0: "claude", records: [] });
		}
		return original(method, payload, schema);
	};
	const agents = createRexAgentPort({
		label: "soma-test",
		client: fake.client,
		sessionId: HANGAR,
		git: git().git,
		processStart: async () => undefined,
		redrawMs: 0,
	});
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(dispatchExtension(agents, async (_repo, card) => `# ${card}`));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();

	/** What the model's call of `tool` returned. */
	async function call(tool: string, args: Record<string, string>, requestId: string) {
		let result: unknown;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: "toolUse" }),
			(request) => {
				result = JSON.parse(JSON.parse(JSON.stringify(request.messages.at(-1))).content[0].text);
				return fauxAssistantMessage("ok");
			},
		]);
		const submission = await root.submit({ type: "input", content: tool, requestId }, context);
		expect((await submission.wait(context)).status).toBe("done");
		return result;
	}
	await call("dispatch", { card: "card-a", repo: "/nonexistent/repo" }, "r0");
	const [job] = blocks;
	if (job === undefined) throw new Error("no window opened");
	return { fake, job, call };
}

test("screen reads a dispatched job's pane in the hangar off rex, by its card, at every call", async () => {
	const { fake, job, call } = await dispatched({ id: "session:work", label: "work", blocks: [] });
	job.records = [{ state: "working", updated_at: AT }];
	job.screen = "> build improve-report-readability and open a PR\n✻ Working…";

	expect(await call("screen", { card: "card-a" }, "r1")).toEqual({
		text: "> build improve-report-readability and open a PR\n✻ Working…",
	});
	job.screen = "● PR opened: #42\n\n";
	expect(await call("screen", { card: "card-a" }, "r2")).toEqual({ text: "● PR opened: #42" });

	const reads = fake.calls.filter((each) => each.method === "com.superlogical.terminal.format");
	expect(reads.map((each) => each.payload)).toEqual(
		Array(2).fill({ session_id: HANGAR, block_id: "block:a", args: { format: "text", trim: true, max_bytes: 65_536 } }),
	);
});

test("screen reads a foreign agent's pane in its own session by the id foreign_agents gave", async () => {
	const human: Block = {
		name: "wrapup-dream-hindsight",
		block: "block:w1",
		argv0: "claude",
		records: [{ state: "working", updated_at: AT }],
		screen: "✻ Thinking…",
	};
	const { fake, call } = await dispatched({ id: "session:work", label: "work", blocks: [human] });

	const [listed] = (await call("foreign_agents", {}, "r1")) as { id: string }[];
	expect(listed?.id).toBe("block:w1");
	expect(await call("screen", { foreign: listed?.id ?? "" }, "r2")).toEqual({ text: "✻ Thinking…" });
	human.screen = "✻ Thinking…\n● Which branch should the PR target?";
	expect(await call("screen", { foreign: "block:w1" }, "r3")).toEqual({
		text: "✻ Thinking…\n● Which branch should the PR target?",
	});
	// soma's own job is not foreign, and nothing was typed into either pane.
	expect(await call("screen", { foreign: "block:a" }, "r4")).toEqual({
		error: "no foreign agent block:a: no block of that id runs claude outside soma",
	});
	expect(fake.methods().filter((method) => method.endsWith(".write") || method === "block.event")).toEqual([]);
});
