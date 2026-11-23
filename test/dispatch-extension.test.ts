import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { eventBridge, JOB_DONE, reconcileDispatches } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension, releasedSession } from "../src/core/extensions/dispatch/index.ts";

const context = BACKGROUND_CONTEXT;
const open: Harness[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
});

async function setup() {
	const agents = new FakeAgentPort();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(
		dispatchExtension(agents, async (_repo, card) => {
			if (card === "missing") throw new Error(`no card ${card}`);
			return `# ${card}`;
		}),
	);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();

	async function dispatch(card: string, requestId: string) {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("dispatch", { card, repo: "/repo" }, { id: requestId })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok"),
		]);
		const submission = await root.submit({ type: "input", content: `派 ${card}`, requestId }, context);
		expect((await submission.wait(context)).status).toBe("done");
	}
	const jobs = async () => (await harness.snapshot(Dispatches, root.id, context))?.jobs ?? [];
	async function call(tool: string, args: Record<string, string | number>, requestId: string) {
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
	return { agents, faux, root, dispatch, call, jobs };
}

test("dispatch starts an agent named after the card and records the job with its session id", async () => {
	const { agents, dispatch, jobs } = await setup();

	await dispatch("card-a", "r1");

	expect(agents.started).toHaveLength(1);
	const [started] = agents.started;
	expect(started).toMatchObject({ name: "card-a", card: "card-a", cwd: "/repo" });
	expect(await jobs()).toEqual([
		{
			card: "card-a",
			agent: "card-a",
			sessionId: started?.sessionId,
			status: { state: "idle" },
			launch: expect.stringMatching(/以下是任務卡：\n\n# card-a$/),
			decisions: [],
			repo: "/repo",
			createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
		},
	]);
});

test("a card already in the dispatch list is not started again", async () => {
	const { agents, dispatch, jobs } = await setup();

	await dispatch("card-a", "r1");
	await dispatch("card-a", "r2");

	expect(agents.started).toHaveLength(1);
	expect(await jobs()).toHaveLength(1);
});

test("a card whose agent is already listed is recorded without starting it", async () => {
	const { agents, dispatch, jobs } = await setup();
	agents.emit("card-a", { state: "working" });

	await dispatch("card-a", "r1");

	expect(agents.started).toEqual([]);
	expect(await jobs()).toMatchObject([{ card: "card-a", status: { state: "working" } }]);
});

test("reconcile writes what changed while the core was down", async () => {
	const { agents, root, dispatch, jobs } = await setup();
	await dispatch("card-a", "r1");
	agents.finish("card-a", "結果：完成");

	await reconcileDispatches(root, agents, context);

	expect(await jobs()).toMatchObject([{ card: "card-a", status: { state: "done" } }]);
});

test("jobs lists the dispatched jobs", async () => {
	const { faux, root, dispatch } = await setup();
	await dispatch("card-a", "r1");
	let result = "";
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("jobs", {})], { stopReason: "toolUse" }),
		(request) => {
			result = JSON.stringify(request.messages.at(-1));
			return fauxAssistantMessage("ok");
		},
	]);

	const submission = await root.submit({ type: "input", content: "列出派工清單", requestId: "r2" }, context);
	expect((await submission.wait(context)).status).toBe("done");

	expect(JSON.parse(result)).toMatchObject({ role: "toolResult", toolName: "jobs", isError: false });
	expect(JSON.parse(JSON.parse(result).content[0].text)).toMatchObject([{ card: "card-a", agent: "card-a" }]);
});

test("jobs says outcome is the last finished turn's result and status.state the current state", () => {
	const tools = dispatchExtension(new FakeAgentPort(), async () => "").tools ?? [];
	const description = tools.find((tool) => tool.name === "jobs")?.description ?? "";

	expect(description).toMatch(/status\.state is the agent's current state/);
	expect(description).toMatch(/outcome is the result of its last finished turn only/);
	expect(description).toMatch(/judge where an agent is now by status\.state, never by outcome/);
	expect(description).toContain("screen");
});

test("a job's outcome stays its last finished turn's while status.state says it works on the next", async () => {
	const { agents, call, dispatch, root } = await setup();
	await dispatch("card-a", "r1");
	const bridge = eventBridge(root, agents, context);
	const handled: Promise<void>[] = [];
	const off = agents.onStatus((event) => handled.push(bridge.handle(event)));
	agents.finish("card-a", "結果：需要你\n要開 PR 嗎？");
	await Promise.all(handled);
	// The human answered the agent at its pane, and it went to work on the answer.
	agents.emit("card-a", { state: "working" });
	await Promise.all(handled);
	off();

	expect(await call("jobs", {}, "r2")).toMatchObject([
		{ card: "card-a", status: { state: "working" }, outcome: "需要你" },
	]);
});

test("foreign_agents lists what runs beside soma's jobs, and jobs does not", async () => {
	const { agents, call, dispatch } = await setup();
	await dispatch("card-a", "r1");
	const agent = { id: "pane-1", session: "work", label: "Window 1", status: { state: "working" as const }, cwd: "/w" };
	agents.foreign.push({ agent });

	expect(await call("foreign_agents", {}, "r2")).toEqual([agent]);
	expect(await call("jobs", {}, "r3")).toMatchObject([{ card: "card-a" }]);
	expect(await call("jobs", {}, "r4")).toHaveLength(1);
});

test("foreign_result reads a foreign agent's last result, and says so when it cannot", async () => {
	const { agents, call } = await setup();
	const agent = { id: "pane-1", session: "work", label: "Window 1" };
	agents.foreign.push({ agent, result: { id: "a-1", text: "結果：完成" } }, { agent: { ...agent, id: "pane-2" } });

	expect(await call("foreign_result", { id: "pane-1" }, "r1")).toEqual({ id: "a-1", text: "結果：完成" });
	expect(await call("foreign_result", { id: "pane-2" }, "r2")).toEqual({
		error: "no transcript of foreign agent pane-2 can be read",
	});
	expect(await call("foreign_result", { id: "pane-9" }, "r3")).toEqual({ error: "no foreign agent pane-9" });
});

test("screen reads a job's pane by its card and a foreign agent's by its id, off the pane at every call", async () => {
	const { agents, call, dispatch, jobs } = await setup();
	await dispatch("card-a", "r1");
	agents.screens.set("card-a", "● Done.");
	const foreign = { agent: { id: "pane-1", session: "work", label: "Window 1" }, screen: "✻ Working…" };
	agents.foreign.push(foreign);

	expect(await call("screen", { card: "card-a" }, "r2")).toEqual({ text: "● Done." });
	expect(await call("screen", { foreign: "pane-1" }, "r3")).toEqual({ text: "✻ Working…" });

	// The human answered at the panes since: each read shows that, not what was read or recorded before.
	agents.screens.set("card-a", "● Done.\n> also open the PR\n✻ Working…");
	foreign.screen = "Open the PR?\n❯ 1. Yes";
	expect(await call("screen", { card: "card-a" }, "r4")).toEqual({ text: "● Done.\n> also open the PR\n✻ Working…" });
	expect(await call("screen", { foreign: "pane-1" }, "r5")).toEqual({ text: "Open the PR?\n❯ 1. Yes" });
	expect(await jobs()).toMatchObject([{ card: "card-a", status: { state: "idle" } }]);
});

test("screen returns the pane's last lines, past the blank ones below, and says when earlier ones were left out", async () => {
	const { agents, call, dispatch } = await setup();
	await dispatch("card-a", "r1");
	const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
	agents.screens.set("card-a", `${lines.join("\n")}\n\n   \n`);

	expect(await call("screen", { card: "card-a", lines: 3 }, "r2")).toEqual({
		text: "line 98\nline 99\nline 100",
		more: true,
	});
	expect(await call("screen", { card: "card-a" }, "r3")).toEqual({ text: lines.slice(-60).join("\n"), more: true });
	expect(await call("screen", { card: "card-a", lines: 400 }, "r4")).toEqual({ text: lines.join("\n") });
});

test("screen names a job or a foreign agent, not both and not neither, and says why it cannot read one", async () => {
	const { call, dispatch } = await setup();
	await dispatch("card-a", "r1");
	const error = { error: "name either card, for a job, or foreign, for a foreign agent" };

	expect(await call("screen", {}, "r2")).toEqual(error);
	expect(await call("screen", { card: "card-a", foreign: "pane-1" }, "r3")).toEqual(error);
	expect(await call("screen", { card: "card-z" }, "r4")).toEqual({ error: "no job for card card-z" });
	expect(await call("screen", { card: "card-a" }, "r5")).toEqual({ error: "no pane of agent card-a" });
	expect(await call("screen", { foreign: "pane-9" }, "r6")).toEqual({ error: "no foreign agent pane-9" });
});

test("screen is read only, and the foreign tools point to it", () => {
	const tools = dispatchExtension(new FakeAgentPort(), async () => "").tools ?? [];
	const byName = new Map(tools.map((tool) => [tool.name, tool]));

	expect(byName.get("screen")?.replay).toBe("safe");
	for (const name of ["foreign_agents", "foreign_result", "foreign_prompt"]) {
		expect(byName.get(name)?.description).toContain("screen");
	}
});

test("respond answers a foreign agent's prompt by its id, checking the fingerprint, and never an auth one", async () => {
	const { agents, call } = await setup();
	const where = { session: "work", label: "Window 1" };
	const fingerprint = "f00d";
	const blocked = {
		state: "blocked" as const,
		kind: "permission" as const,
		fingerprint,
		options: [{ id: "1", label: "Yes" }],
	};
	agents.foreign.push(
		{ agent: { id: "pane-1", ...where, status: blocked } },
		{ agent: { id: "pane-2", ...where, status: { ...blocked, kind: "auth" } } },
	);
	const answer = (id: string, print: string, requestId: string) =>
		call("respond", { foreign: id, option: "1", fingerprint: print, reason: "無害的指令" }, requestId);

	expect(await answer("pane-1", "beef", "r1")).toEqual({ sent: false, refusal: "stale" });
	expect(await answer("pane-2", fingerprint, "r2")).toEqual({ sent: false, refusal: "auth" });
	expect(await answer("pane-9", fingerprint, "r3")).toEqual({ sent: false, error: "no foreign agent pane-9" });
	expect(agents.foreignResponses).toEqual([]);

	expect(await answer("pane-1", fingerprint, "r4")).toEqual({ sent: true });
	expect(agents.foreignResponses).toEqual([{ id: "pane-1", answer: { option: "1", fingerprint } }]);
	expect(agents.responses).toEqual([]);
});

test("foreign_prompt sends an idle or done foreign agent a prompt, and refuses a working or blocked one with the reason", async () => {
	const { agents, call } = await setup();
	const where = { session: "work", label: "Window 1" };
	const blocked = { state: "blocked" as const, kind: "permission" as const, fingerprint: "f" };
	agents.foreign.push(
		{ agent: { id: "pane-1", ...where, status: { state: "idle" } } },
		{ agent: { id: "pane-2", ...where, status: { state: "done" } } },
		{ agent: { id: "pane-3", ...where, status: { state: "working" } } },
		{ agent: { id: "pane-4", ...where, status: blocked } },
	);
	const send = (id: string, requestId: string) => call("foreign_prompt", { id, text: `go ${id}` }, requestId);

	expect(await send("pane-3", "r1")).toEqual({
		sent: false,
		refused: "foreign agent pane-3 is working: a prompt goes only to idle or done",
	});
	expect(await send("pane-4", "r2")).toEqual({
		sent: false,
		refused: "foreign agent pane-4 is blocked: a prompt goes only to idle or done",
	});
	expect(await send("pane-9", "r3")).toEqual({ sent: false, refused: "no foreign agent pane-9" });
	expect(agents.foreignPrompts).toEqual([]);

	expect(await send("pane-1", "r4")).toEqual({ sent: true });
	expect(await send("pane-2", "r5")).toEqual({ sent: true });
	expect(agents.foreignPrompts).toEqual([
		{ id: "pane-1", text: "go pane-1" },
		{ id: "pane-2", text: "go pane-2" },
	]);
	expect(agents.prompts).toEqual([]);
});

test("foreign_prompt that fails after typing began does not call it a refusal", async () => {
	const { agents, call } = await setup();
	agents.foreign.push({ agent: { id: "pane-1", session: "work", label: "Window 1", status: { state: "idle" } } });
	agents.promptForeign = async () => {
		throw new Error("rex connection lost");
	};

	expect(await call("foreign_prompt", { id: "pane-1", text: "go" }, "r1")).toEqual({
		sent: "unknown",
		error: "rex connection lost",
	});
});

test("foreign_prompt is not replayed after a crash, and foreign_agents no longer says soma never prompts", () => {
	const tools = dispatchExtension(new FakeAgentPort(), async () => "").tools ?? [];
	const byName = new Map(tools.map((tool) => [tool.name, tool]));

	expect(byName.get("foreign_prompt")?.replay).toBe("unsafe");
	expect(byName.get("foreign_agents")?.description).toContain("foreign_prompt");
	expect(byName.get("foreign_agents")?.description).not.toMatch(/never prompts/);
});

test("respond names a job or a foreign agent, not both and not neither", async () => {
	const { agents, call, dispatch } = await setup();
	await dispatch("card-a", "r1");
	const error = { sent: false, error: "name either card, for a job, or foreign, for a foreign agent" };

	expect(await call("respond", { option: "1", fingerprint: "f", reason: "r" }, "r2")).toEqual(error);
	expect(
		await call("respond", { card: "card-a", foreign: "pane-1", option: "1", fingerprint: "f", reason: "r" }, "r3"),
	).toEqual(error);
	expect(agents.responses).toEqual([]);
	expect(agents.foreignResponses).toEqual([]);
});

test("a card that cannot be read starts nothing", async () => {
	const { agents, dispatch, jobs } = await setup();

	await dispatch("missing", "r1");

	expect(agents.started).toEqual([]);
	expect(await jobs()).toEqual([]);
});

test("reply sends the human's answer to the agent that asked, and its next result is recorded", async () => {
	const { agents, root, dispatch, call, jobs } = await setup();
	const bridge = eventBridge(root, agents, context);
	const handled: Promise<void>[] = [];
	agents.onStatus((event) => handled.push(bridge.handle(event)));
	const settle = async () => {
		for (let seen = -1; seen !== handled.length; ) {
			seen = handled.length;
			await Promise.all(handled);
		}
	};
	await dispatch("card-a", "r1");
	agents.finish("card-a", "結果：需要你\nhello 還是 hi？");
	await settle();

	const result = await call("reply", { card: "card-a", text: "hi", reason: "人在終端機選了 hi" }, "r2");
	agents.finish("card-a", "結果：完成");
	await settle();

	expect(result).toEqual({ sent: true });
	expect(agents.prompts.at(-1)).toEqual({ agent: "card-a", text: "hi" });
	expect((await jobs())[0]?.decisions).toMatchObject([
		{ kind: "question", action: "replied", text: "hi", reason: "人在終端機選了 hi" },
	]);
	const done = (await root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter(
		(entry) => entry.kind === JOB_DONE,
	);
	expect(done.map((entry) => (entry.data as { outcome: string }).outcome)).toEqual(["需要你", "完成"]);
});

test("reply to a hand-off job soma stopped after its last turn is refused, sending nothing and recording nothing", async () => {
	const { agents, root, call, jobs } = await setup();
	const stopped = {
		card: "soma-repo-7e33",
		agent: "soma-repo-7e33",
		sessionId: "7e33597b-e33d-4c6d-a700-e21b2f54223e",
		status: { state: "done" as const },
		outcome: "完成" as const,
		decisions: [],
		handoff: true as const,
		reclaim: { phase: "stopped" as const },
	};
	await root.commit(async (tx) => {
		(await tx.doc(Dispatches, root.id)).jobs.push(stopped);
	}, context);

	const result = await call("reply", { card: "soma-repo-7e33", text: "go on", reason: "人要它繼續" }, "r1");

	expect(result).toEqual({ sent: false, refused: releasedSession("soma-repo-7e33") });
	expect(releasedSession("x")).toMatch(/session was released after its last turn.*hand off.*dispatch a new job/);
	expect(agents.prompts).toEqual([]);
	expect(await jobs()).toEqual([stopped]);
});

test("reply to a card with no job sends nothing and says why", async () => {
	const { agents, call, jobs } = await setup();

	const result = await call("reply", { card: "card-a", text: "hi", reason: "人回答了" }, "r1");

	expect(result).toEqual({ sent: false, error: "no job for card card-a" });
	expect(agents.prompts).toEqual([]);
	expect(await jobs()).toEqual([]);
});
