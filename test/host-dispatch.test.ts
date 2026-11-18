import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { eventBridge } from "../src/core/extensions/dispatch/bridge.ts";
import { HostSessions, hostDispatcher } from "../src/core/extensions/dispatch/host.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import type { StartRequest } from "../src/ports/agent.ts";
import type { RepoCheck } from "../src/ports/dispatch.ts";

const context = BACKGROUND_CONTEXT;
const open: Harness[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
});

const REPO = "/Users/me/workspace/soma";
// A repo is taken only as `/Users/me/workspace/<name>`; a link resolves first, as realpath would.
const checkRepo: RepoCheck = async (path) => {
	const real = path === "/Users/me/link" ? REPO : path;
	return /^\/Users\/me\/workspace\/[^/]+$/.test(real)
		? { repo: real }
		: { refused: `${real} is not a folder directly under /Users/me/workspace` };
};
const readCard = async (_repo: string, card: string) => {
	if (card === "missing") throw new Error("Error: File not found: pm/soma/tasks/missing.md");
	return `# ${card}`;
};

/** Agents whose start throws, as a full hangar's does, after it saw the request. */
class Refusing extends FakeAgentPort {
	readonly error: string;
	constructor(error: string) {
		super();
		this.error = error;
	}
	override async start(request: StartRequest): Promise<void> {
		this.started.push(request);
		throw new Error(this.error);
	}
}

async function setup(agents = new FakeAgentPort()) {
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("ok")));
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(dispatchExtension(agents, readCard));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const bridge = eventBridge(root, agents, context);
	const handled: Promise<void>[] = [];
	agents.onStatus((event) => handled.push(bridge.handle(event)));
	const host = hostDispatcher(agents, readCard, checkRepo);
	return {
		agents,
		root,
		calls: () => faux.state.callCount,
		dispatch: (card: string, repo = REPO) => host(root, { card, repo }, context),
		jobs: async () => (await harness.snapshot(Dispatches, root.id, context))?.jobs ?? [],
		sessions: async () => (await harness.snapshot(HostSessions, root.id, context))?.cards ?? {},
		settle: async () => {
			for (let seen = -1; seen !== handled.length; ) {
				seen = handled.length;
				await Promise.all(handled);
			}
			await root.waitForIdle(context);
		},
	};
}

test("a host dispatch starts the card's agent in the repo, records its job and makes no model call", async () => {
	const soma = await setup();

	const reply = await soma.dispatch("card-a");

	const [started] = soma.agents.started;
	expect(soma.agents.started).toEqual([{ name: "card-a", card: "card-a", cwd: REPO, sessionId: expect.any(String) }]);
	expect(reply).toEqual({
		dispatched: true,
		how: "started",
		card: "card-a",
		agent: "card-a",
		sessionId: started?.sessionId,
		repo: REPO,
		state: "idle",
	});
	expect(await soma.jobs()).toEqual([
		{
			card: "card-a",
			agent: "card-a",
			sessionId: started?.sessionId,
			status: { state: "idle" },
			repo: REPO,
			createdAt: expect.any(String),
			launch: expect.stringMatching(/以下是任務卡：\n\n# card-a$/),
			decisions: [],
		},
	]);
	// The session id was kept only until the job held it.
	expect(await soma.sessions()).toEqual({});
	await soma.settle();
	expect(soma.calls()).toBe(0);
});

test("the agent gets the card's launch prompt at its first idle, as a job the model dispatched does", async () => {
	const soma = await setup();
	await soma.dispatch("card-a");

	soma.agents.emit("card-a", { state: "idle" });
	await soma.settle();

	expect(soma.agents.prompts).toEqual([
		{ agent: "card-a", text: expect.stringContaining("以下是任務卡：\n\n# card-a") },
	]);
	expect(soma.calls()).toBe(0);
});

test("the job records the repo as resolved, not as typed", async () => {
	const soma = await setup();

	expect(await soma.dispatch("card-a", "/Users/me/link")).toMatchObject({ dispatched: true, repo: REPO });
	expect(soma.agents.started).toMatchObject([{ cwd: REPO }]);
});

test("the same dispatch twice starts one agent and returns the job the first recorded", async () => {
	const soma = await setup();
	const first = await soma.dispatch("card-a");

	const second = await soma.dispatch("card-a");

	expect(soma.agents.started).toHaveLength(1);
	expect(await soma.jobs()).toHaveLength(1);
	expect(second).toEqual({ ...first, how: "existing" });
});

test("two dispatches of a card at once start one agent", async () => {
	const soma = await setup();

	const replies = await Promise.all([soma.dispatch("card-a"), soma.dispatch("card-a")]);

	expect(soma.agents.started).toHaveLength(1);
	expect(await soma.jobs()).toHaveLength(1);
	expect(replies.map((reply) => reply.dispatched && reply.how)).toEqual(["started", "existing"]);
});

test("a card with a job from another repo returns that job and starts nothing", async () => {
	const soma = await setup();
	await soma.dispatch("card-a");

	const reply = await soma.dispatch("card-a", "/Users/me/workspace/other");

	expect(reply).toMatchObject({ dispatched: true, how: "existing", repo: REPO });
	expect(soma.agents.started).toHaveLength(1);
});

test("an agent of the card's name already running is recorded as its job, not started again", async () => {
	const soma = await setup();
	soma.agents.emit("card-a", { state: "working" });

	const reply = await soma.dispatch("card-a");

	expect(soma.agents.started).toEqual([]);
	expect(reply).toMatchObject({ dispatched: true, how: "found", state: "working" });
	expect(await soma.jobs()).toMatchObject([{ card: "card-a", status: { state: "working" }, repo: REPO }]);
});

test("a rerun after a start that failed passes the session id the first one did", async () => {
	const agents = new Refusing("rex did not answer in 10000 ms");
	const soma = await setup(agents);
	expect(await soma.dispatch("card-a")).toEqual({
		dispatched: false,
		reason: "soma could not dispatch card card-a: rex did not answer in 10000 ms",
	});
	expect(await soma.jobs()).toEqual([]);

	// The window it may have opened shows up in the next listing; the rerun records it under the same session.
	agents.emit("card-a", { state: "idle" });
	const reply = await soma.dispatch("card-a");

	expect(reply).toMatchObject({ dispatched: true, how: "found", sessionId: agents.started[0]?.sessionId });
	expect(await soma.jobs()).toMatchObject([{ card: "card-a", sessionId: agents.started[0]?.sessionId }]);
});

test("a full hangar is refused with its message, and no job is recorded", async () => {
	const soma = await setup(new Refusing("hangar is full: 4 of 4 agents running"));

	expect(await soma.dispatch("card-a")).toEqual({
		dispatched: false,
		reason: "soma could not dispatch card card-a: hangar is full: 4 of 4 agents running",
	});
	expect(await soma.jobs()).toEqual([]);
	await soma.settle();
	expect(soma.calls()).toBe(0);
});

test("a card that cannot be read is refused before anything starts", async () => {
	const soma = await setup();

	expect(await soma.dispatch("missing")).toEqual({
		dispatched: false,
		reason: `card missing could not be read from ${REPO}'s vault project: Error: File not found: pm/soma/tasks/missing.md`,
	});
	expect(soma.agents.started).toEqual([]);
	expect(await soma.jobs()).toEqual([]);
	expect(await soma.sessions()).toEqual({});
});

test("a repo outside the folder is refused before the card is read or anything starts", async () => {
	const soma = await setup();

	expect(await soma.dispatch("card-a", "/Users/me/elsewhere/soma")).toEqual({
		dispatched: false,
		reason: "/Users/me/elsewhere/soma is not a folder directly under /Users/me/workspace",
	});
	expect(soma.agents.started).toEqual([]);
	expect(await soma.jobs()).toEqual([]);
});

test("a name that is not a card's file name is refused", async () => {
	const soma = await setup();

	for (const card of ["../secrets", "Card-A", "-a", ""]) {
		expect(await soma.dispatch(card)).toEqual({
			dispatched: false,
			reason: `"${card}" is not a card name: lowercase letters, digits and hyphens, not starting with a hyphen`,
		});
	}
	expect(soma.agents.started).toEqual([]);
});

test("a card whose name a ticket job holds is refused", async () => {
	const soma = await setup();
	await soma.root.commit(async (tx) => {
		(await tx.doc(Dispatches, soma.root.id)).jobs.push({
			card: "card-a",
			agent: "card-a",
			sessionId: "s",
			status: { state: "idle" },
			ticket: "write a card",
			decisions: [],
		});
	}, context);

	expect(await soma.dispatch("card-a")).toEqual({
		dispatched: false,
		reason: "the job name card-a is taken by a ticket job, so the card was not started",
	});
	expect(soma.agents.started).toEqual([]);
});
