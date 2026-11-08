import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, afterEach, expect, test } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { dispatchOver, openAgentPort } from "../src/agent-side.ts";
import { type FileConfig, resolveConfig } from "../src/config.ts";
import { PromptRefused } from "../src/ports/agent.ts";
import type { AgentHandover } from "../src/ports/handover.ts";

const dir = mkdtempSync(join(tmpdir(), "soma-agent-side-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const opened = (file: FileConfig) =>
	openAgentPort(
		resolveConfig({ db: join(dir, "soma.sqlite"), herdrSocket: join(dir, "no-herdr.sock"), ...file }, {}, "/home/me"),
	);
const hangar = { sessionId: "session:hangar", socket: join(dir, "no-rex.sock") };

const context = BACKGROUND_CONTEXT;
const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.close(context);
});

/** What show_job answers for a job the real core holds, over `dispatchOver` with `handover`, on a fake agent side. */
async function showJob(handover?: AgentHandover) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(dispatchOver({ agents: new FakeAgentPort(), handover }, async (_repo, card) => `# ${card}`));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	harnesses.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const call = async (tool: string, args: Record<string, string>) => {
		let result: unknown;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: "toolUse" }),
			(request) => {
				result = JSON.parse(JSON.parse(JSON.stringify(request.messages.at(-1))).content[0].text);
				return fauxAssistantMessage("ok");
			},
		]);
		const submission = await root.submit({ type: "input", content: tool, requestId: tool }, context);
		expect((await submission.wait(context)).status).toBe("done");
		return result;
	};
	await call("dispatch", { card: "card-a", repo: "/repo" });
	return call("show_job", { card: "card-a" });
}

test("show_job in a soma with a hangar goes to the side's own handover, not to no_hangar", async () => {
	const { handover } = opened({ agentAdapter: "acp", rex: hangar });

	expect(await showJob(handover)).toEqual({
		handedOver: false,
		refusal: "not_acp",
		reason: "card-a is no agent acp holds",
	});
});

test("show_job in a soma with no hangar answers no_hangar", async () => {
	const { handover } = opened({ agentAdapter: "acp" });

	expect(await showJob(handover)).toMatchObject({ handedOver: false, refusal: "no_hangar" });
});

test("main.ts builds its dispatch extension from the whole side it opened, as the tests above do", () => {
	const main = readFileSync(join(import.meta.dirname, "../src/main.ts"), "utf8");

	expect(main).toContain("const side = openAgentPort(config);");
	expect(main).toContain("dispatchOver(side, readCard),");
	expect(main).not.toContain("dispatchExtension");
	expect(main).toContain("handoverBridge(root, side.settling, context)");
});

test("acp with a hangar named runs its jobs on two sides, and with none handed over asks rex nothing", async () => {
	const { agents, dormant, handover } = opened({ agentAdapter: "acp", rex: hangar });

	expect(await agents.list()).toEqual([]);
	expect(await dormant()).toEqual([]);
	// Over ACP an unknown name is its own side's to refuse; only the two-sided port can answer this at all.
	expect(await handover?.handOver("nobody")).toEqual({
		handedOver: false,
		refusal: "not_acp",
		reason: "nobody is no agent acp holds",
	});
	// Foreign agents are rex's, and no rex is there.
	await expect(agents.listForeign()).rejects.toThrow();
});

test("only acp with a hangar settles anything", () => {
	expect(opened({ agentAdapter: "acp", rex: hangar }).settling).toBeDefined();
	expect(opened({ agentAdapter: "acp" }).settling).toBeUndefined();
	expect(opened({ agentAdapter: "rex", rex: hangar }).settling).toBeUndefined();
});

test("acp alone hands nothing over, which the dispatch extension says for itself, and asks no rex for anything", async () => {
	const { agents, handover } = opened({ agentAdapter: "acp" });

	expect(handover).toBeUndefined();
	expect(await agents.listForeign()).toEqual([]);
});

test.each([
	["rex", { agentAdapter: "rex", rex: hangar }, "rex"],
	["tty", { agentAdapter: "tty" }, "tty"],
	["an unset adapter", {}, "herdr"],
] as const)("%s says its jobs are not over ACP", async (_name, file, adapter) => {
	expect(await opened(file).handover?.handOver("card-a")).toEqual({
		handedOver: false,
		refusal: "not_acp",
		reason: `this soma runs its jobs on ${adapter}, not over ACP`,
	});
});

test("as main.ts opens it, with rex not there, a job left mid-handover is undecided and a job handed over fails the listing", async () => {
	const db = join(dir, "left.sqlite");
	const sessions = `${db}.acp-sessions.json`;
	const entry = { card: "card-a", sessionId: "s", acpSessionId: "a", cwd: dir };
	const said = console.error;
	console.error = () => {};
	try {
		writeFileSync(sessions, JSON.stringify({ "card-a": { ...entry, handingOver: true } }));
		const left = opened({ agentAdapter: "acp", rex: hangar, db });
		// The port's own, which counts a job its startup look gave back to ACP, not the ACP side's alone.
		expect((left.agents as unknown as { dormant: unknown }).dormant).toBe(left.dormant);
		expect(await left.dormant()).toEqual([]);
		expect(await left.agents.list()).toEqual([{ name: "card-a", sessionId: "s" }]);
		await expect(left.agents.prompt("card-a", "now")).rejects.toThrow(PromptRefused);

		writeFileSync(sessions, JSON.stringify({ "card-a": { ...entry, handedOver: true } }));
		const handed = opened({ agentAdapter: "acp", rex: hangar, db });
		await expect(handed.agents.list()).rejects.toThrow();
	} finally {
		console.error = said;
	}
});
