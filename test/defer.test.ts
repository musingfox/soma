import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Harness, TaskId } from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { deferAt, deferredPrompt } from "../src/core/domain/defer.ts";
import type { Job } from "../src/core/domain/dispatch.ts";
import { type DeferOptions, Deferrals, deferExtension } from "../src/core/extensions/defer/index.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";
import { NOTICE } from "../src/core/notice.ts";
import { startCore } from "../src/core/startup.ts";
import { type AgentPort, PromptRefused, type ResumeRequest } from "../src/ports/agent.ts";
import type { SomaEvent } from "../src/ports/human.ts";
import * as shared from "./defer-core.ts";

const context = BACKGROUND_CONTEXT;
const job: Job = { card: "card-a", agent: "card-a", sessionId: "s-1", status: { state: "idle" }, decisions: [] };
const directories: string[] = [];
const open: Harness[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function database() {
	const directory = await mkdtemp(join(tmpdir(), "soma-defer-"));
	directories.push(directory);
	return join(directory, "soma.sqlite");
}

/** A core on `db` with the dispatch list holding `job`; the model is never set up, so a turn it ran would fail. */
async function core(
	db: string,
	agents: Pick<AgentPort, "list" | "prompt" | "resume" | "stop">,
	options: DeferOptions = {},
) {
	const defers = deferExtension(agents, options);
	const harness = await openHarness(
		db,
		[dispatchExtension(new FakeAgentPort(), async () => ""), defers.extension],
		context,
	);
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	await root.commit(async (tx) => {
		const doc = await tx.doc(Dispatches, root.id);
		if (!doc.jobs.some((each) => each.card === job.card)) doc.jobs.push(job);
	}, context);
	return {
		harness,
		root,
		defer: (at: string, agent = "card-a") => defers.defer(root, { agent, at, instruction: "run the tests" }, context),
	};
}

const pending = async (harness: Harness, root: Conversation) =>
	Object.keys((await harness.snapshot(Deferrals, root.id, context))?.items ?? {});
const entries = async (root: Conversation) =>
	(await root.entries({ order: "ascending" }, 1000, undefined, context)).items;
const outcome = async (harness: Harness, id: string) =>
	(await harness.waitForTask(Number(id) as TaskId, context)).state.outcome;

/** An agent side whose agents, once gone, cannot be started again, as when the session's worktree was removed. */
class NotResumable extends FakeAgentPort {
	override async resume(request: ResumeRequest): Promise<void> {
		this.resumed.push(request);
		throw new Error(`the worktree of claude session ${request.sessionId} no longer exists`);
	}
}

test("a defer at or after now: an offset date-time or a duration; anything else is refused in words for the agent", () => {
	const now = Date.parse("2026-11-04T10:00:00Z");
	expect(deferAt("PT2M", now)).toBe(now + 120_000);
	expect(deferAt("2026-11-04T18:05:00+08:00", now)).toBe(now + 300_000);
	expect(() => deferAt("2026-11-04T18:05:00", now)).toThrow(/with an offset/);
	expect(() => deferAt("in two minutes", now)).toThrow(/ISO 8601 duration, such as PT2M; got "in two minutes"/);
	expect(() => deferAt("", now)).toThrow(/--at must be/);
	expect(() => deferAt("PT", now)).toThrow(/ISO 8601/);
	expect(() => deferAt("2026-11-04T09:59:00Z", now)).toThrow(/past/);
});

test("the deferred prompt says it comes from soma and carries the instruction", () => {
	const text = deferredPrompt("7", { agent: "a", card: "a", instruction: "run the tests", at: 0, setAt: 0 });
	expect(text).toBe(
		"[soma deferred instruction 7] You asked soma with `soma defer` at 1970-01-01T00:00:00.000Z to send you this instruction now: run the tests",
	);
});

test("an accepted defer creates one task, recorded as pending until it falls", async () => {
	const agents = new FakeAgentPort();
	const { harness, root, defer } = await core(await database(), agents);

	const reply = await defer("PT1H");

	expect(reply).toMatchObject({ accepted: true });
	if (!reply.accepted) return;
	expect(Date.parse(reply.at) - Date.now()).toBeGreaterThan(3_590_000);
	expect(await pending(harness, root)).toEqual([reply.id]);
	let task = await harness.getTask(Number(reply.id) as TaskId, context);
	for (let tries = 0; task?.state.status !== "sleeping" && tries < 40; tries++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		task = await harness.getTask(Number(reply.id) as TaskId, context);
	}
	expect(task).toMatchObject({ kind: "soma.defer", input: { agent: "card-a" }, state: { status: "sleeping" } });
	expect(agents.prompts).toEqual([]);
});

test("a defer whose SOMA_AGENT names no dispatched job is refused and creates nothing", async () => {
	const { harness, root, defer } = await core(await database(), new FakeAgentPort());

	const reply = await defer("PT1M", "card-b");

	expect(reply).toEqual({
		accepted: false,
		reason:
			'soma dispatched no agent for card "card-b" (SOMA_AGENT); it defers instructions only for agents it dispatched',
	});
	expect(await pending(harness, root)).toEqual([]);
});

test("a missing or malformed --at is refused and creates nothing", async () => {
	const { harness, root, defer } = await core(await database(), new FakeAgentPort());

	for (const at of ["", "tomorrow", "2026-11-04 18:00"]) {
		expect(await defer(at)).toMatchObject({ accepted: false, reason: expect.stringMatching(/^--at must be/) });
	}
	expect(await pending(harness, root)).toEqual([]);
});

test("at fire time a listed agent gets one prompt, and the root conversation gets no input", async () => {
	const agents = new FakeAgentPort();
	// At work when it defers, as an agent running `soma defer` is: one at rest is stopped at once.
	agents.emit("card-a", { state: "working" });
	const { harness, root, defer } = await core(await database(), agents);

	const reply = await defer("PT1S");
	if (!reply.accepted) throw new Error(reply.reason);

	expect(await outcome(harness, reply.id)).toEqual({ status: "completed", result: "sent" });
	expect(agents.prompts).toEqual([
		{ agent: "card-a", text: expect.stringMatching(/^\[soma deferred instruction \d+\] .*: run the tests$/) },
	]);
	expect(await entries(root)).toEqual([]);
	expect(await pending(harness, root)).toEqual([]);
});

test("an agent not listed at fire time that cannot be started again is not prompted, and the human gets one notice", async () => {
	const agents = new NotResumable();
	const { harness, root, defer } = await core(await database(), agents);

	const reply = await defer("PT1S");
	if (!reply.accepted) throw new Error(reply.reason);

	expect(await outcome(harness, reply.id)).toEqual({ status: "completed", result: "unresumed" });
	expect(agents.resumed).toEqual([{ name: "card-a", card: "card-a", sessionId: "s-1" }]);
	expect(agents.prompts).toEqual([]);
	const notices = await entries(root);
	expect(notices.map((entry) => [entry.kind, entry.data])).toEqual([
		[
			NOTICE,
			{
				kind: "report",
				class: "outcome",
				content: expect.stringMatching(
					new RegExp(
						`^Deferred instruction ${reply.id} for agent card-a \\(card card-a\\) was not sent: .*run the tests$`,
					),
				),
			},
		],
	]);
});

test("a restart while waiting still fires once", { timeout: 20_000 }, async () => {
	const db = await database();
	const agents = new FakeAgentPort();
	// At work when it defers, as an agent running `soma defer` is: one at rest is stopped at once.
	agents.emit("card-a", { state: "working" });
	const first = await core(db, agents);
	const reply = await first.defer("PT2S");
	if (!reply.accepted) throw new Error(reply.reason);
	await first.harness.close(context);
	open.splice(open.indexOf(first.harness), 1);
	expect(agents.prompts).toEqual([]);

	const second = await core(db, agents);

	expect(await outcome(second.harness, reply.id)).toEqual({ status: "completed", result: "sent" });
	expect(agents.prompts.length).toBe(1);
	expect(await entries(second.root)).toEqual([]);
	await second.harness.close(context);
	open.splice(open.indexOf(second.harness), 1);
	const third = await core(db, agents);
	await new Promise((resolve) => setTimeout(resolve, 500));
	expect(agents.prompts.length).toBe(1);
	expect(await pending(third.harness, third.root)).toEqual([]);
});

test("a core stopped while the prompt was going out does not prompt again, and tells the human once", {
	timeout: 20_000,
}, async () => {
	const db = await database();
	const prompts: string[] = [];
	// Stands in for the process dying mid-prompt: the prompt never settles until the core is closing, and then
	// fails, so nothing the first run does after it can commit.
	let sent: () => void = () => {};
	let cut: (error: Error) => void = () => {};
	const reached = new Promise<void>((resolve) => {
		sent = resolve;
	});
	const hanging: Pick<AgentPort, "list" | "prompt" | "resume" | "stop"> = {
		list: async () => [{ name: "card-a" }],
		resume: async () => {},
		stop: async () => {},
		prompt: (_agent, text) => {
			prompts.push(text);
			sent();
			return new Promise((_resolve, reject) => {
				cut = reject;
			});
		},
	};
	const first = await core(db, hanging);
	const reply = await first.defer("PT1S");
	if (!reply.accepted) throw new Error(reply.reason);
	await reached;
	const closed = first.harness.close(context);
	cut(new Error("soma went down"));
	await closed;
	open.splice(open.indexOf(first.harness), 1);
	const after = await openHarness(db, [deferExtension(hanging).extension], context);
	expect((await after.getTask(Number(reply.id) as TaskId, context))?.state).toMatchObject({
		checkpoint: { phase: "sending" },
	});
	await after.close(context);

	const second = await core(db, hanging);

	expect(await outcome(second.harness, reply.id)).toEqual({ status: "completed", result: "unsure" });
	expect(prompts.length).toBe(1);
	const notices = await entries(second.root);
	expect(notices.map((entry) => entry.data)).toEqual([
		{ kind: "report", class: "outcome", content: expect.stringMatching(/may not have reached the agent/) },
	]);
});

test("a prompt the agent side refuses, as for a busy agent, is tried again; one that never goes tells the human", {
	timeout: 20_000,
}, async () => {
	let refusals = 1;
	const prompts: string[] = [];
	const busy: Pick<AgentPort, "list" | "prompt" | "resume" | "stop"> = {
		list: async () => [{ name: "card-a" }],
		resume: async () => {},
		stop: async () => {},
		prompt: async (_agent, text) => {
			if (refusals-- > 0) throw new PromptRefused("rex agent card-a is working: a prompt goes only to idle or done");
			prompts.push(text);
		},
	};
	const { harness, root, defer } = await core(await database(), busy, { retryMs: 200, tries: 3 });
	const once = await defer("PT1S");
	if (!once.accepted) throw new Error(once.reason);
	expect(await outcome(harness, once.id)).toEqual({ status: "completed", result: "sent" });
	expect(prompts.length).toBe(1);
	expect(await entries(root)).toEqual([]);

	refusals = 10;
	const never = await defer("PT1S");
	if (!never.accepted) throw new Error(never.reason);
	expect(await outcome(harness, never.id)).toEqual({ status: "completed", result: "failed" });
	expect(prompts.length).toBe(1);
	expect((await entries(root)).map((entry) => entry.data)).toEqual([
		{
			kind: "report",
			class: "outcome",
			content: expect.stringMatching(/was not sent after 3 tries: rex agent card-a is working/),
		},
	]);
});

test("an adapter error that may come after typing is not tried again, and tells the human once", {
	timeout: 20_000,
}, async () => {
	const prompts: string[] = [];
	// As rex's prompt can: the paste went out, then pressing Enter failed.
	const typedThenFailed: Pick<AgentPort, "list" | "prompt" | "resume" | "stop"> = {
		list: async () => [{ name: "card-a" }],
		resume: async () => {},
		stop: async () => {},
		prompt: async (_agent, text) => {
			prompts.push(text);
			throw new Error("rex connection lost");
		},
	};
	const { harness, root, defer } = await core(await database(), typedThenFailed, { retryMs: 200, tries: 3 });
	const reply = await defer("PT1S");
	if (!reply.accepted) throw new Error(reply.reason);

	expect(await outcome(harness, reply.id)).toEqual({ status: "completed", result: "unsure" });
	expect(prompts.length).toBe(1);
	expect((await entries(root)).map((entry) => entry.data)).toEqual([
		{
			kind: "report",
			class: "outcome",
			content: expect.stringMatching(/may not have reached the agent: .*rex connection lost/),
		},
	]);
	expect(await pending(harness, root)).toEqual([]);
});

test("a deferral that ends as soma starts reaches the human through the HumanPort, however long the other starts take", {
	timeout: 20_000,
}, async () => {
	const db = await database();
	const first = await core(db, new FakeAgentPort());
	const reply = await first.defer("PT1S");
	if (!reply.accepted) throw new Error(reply.reason);
	await first.harness.close(context);
	open.splice(open.indexOf(first.harness), 1);
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	// The agent left while soma was down, and its worktree with it, so the deferral ends at once with a notice.
	const agents = new NotResumable();
	const harness = await openHarness(
		db,
		[dispatchExtension(agents, async () => ""), deferExtension(agents).extension],
		context,
	);
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	// Stands in for main's digest and reflection starts, each a commit that may take a while.
	const slowStart = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

	const human = await startCore(harness, () => openHumanPort(harness, root, agents, context), [slowStart]);
	const seen: SomaEvent[] = [];
	human.subscribe((event) => seen.push(event));

	try {
		expect(await outcome(harness, reply.id)).toEqual({ status: "completed", result: "unresumed" });
		const notices = () => seen.filter((event) => event.type === "notice");
		await vi.waitFor(() => expect(notices()).toHaveLength(1));
		expect(notices()).toEqual([
			{
				type: "notice",
				kind: "report",
				class: "outcome",
				content: expect.stringMatching(`^Deferred instruction ${reply.id} `),
			},
		]);
	} finally {
		await human.close();
	}
});

/** An agent side whose listings, in order, each run the next of `afters` once taken; a throw is a listing that failed. */
class ListingHook extends FakeAgentPort {
	readonly afters: (() => Promise<void>)[] = [];
	override async list() {
		const listed = await super.list();
		await this.afters.shift()?.();
		return listed;
	}
}

/** The agent's turn ends and the reclaim's stop commits, as when it lands between a defer's listing and its commit. */
const stopCommits = (soma: shared.Core, agents: ListingHook) => async () => {
	agents.finish("card-a", "結果：完成");
	await soma.settle();
};

test("a stop that commits between an agent's listing and its defer's commit leaves the job stopped, and a restart tells of no vanished agent", {
	timeout: 20_000,
}, async () => {
	const db = await shared.database();
	const agents = new ListingHook();
	agents.emit("card-a", { state: "working" });
	const first = await shared.core(db, agents);
	// Deferred mid-turn, the job is due and the agent still open.
	await shared.accepted(await first.defer("PT1H"));
	expect(await first.job("card-a")).toMatchObject({ reclaim: { phase: "due" } });

	// The agent defers again and the defer lists it; before the defer commits, its turn ends and the reclaim's stop commits.
	agents.afters.push(stopCommits(first, agents));
	await shared.accepted(await first.defer("PT2H"));
	expect(agents.afters).toEqual([]);
	expect(agents.stopped).toEqual(["card-a"]);
	expect(await agents.list()).toEqual([]);
	expect(await first.job("card-a")).toMatchObject({ reclaim: { phase: "stopped" } });
	await first.close();

	const soma = await shared.core(db, agents);
	await soma.settle();
	expect(await soma.job("card-a")).toMatchObject({ reclaim: { phase: "stopped" } });
	expect(await soma.notices()).toEqual([]);
});

/** A stopped job whose agent is open again, as when its window reopened: the next defer lists it and arms the job due. */
async function stoppedThenReopened(agents: ListingHook) {
	agents.emit("card-a", { state: "idle" });
	const soma = await shared.core(await shared.database(), agents);
	await shared.accepted(await soma.defer("PT1H"));
	expect(await soma.job("card-a")).toMatchObject({ reclaim: { phase: "stopped" } });
	expect(agents.stopped).toEqual(["card-a"]);
	agents.emit("card-a", { state: "working" });
	return soma;
}

test("an agent still listed after the defer's commit leaves the re-armed job due", async () => {
	const agents = new ListingHook();
	const soma = await stoppedThenReopened(agents);

	agents.afters.push(
		async () => {},
		async () => {},
	);
	await shared.accepted(await soma.defer("PT2H"));
	expect(agents.afters).toEqual([]);
	expect(await soma.job("card-a")).toMatchObject({ reclaim: { phase: "due" } });
	expect(agents.stopped).toEqual(["card-a"]);
});

test("a listing that fails after the defer's commit leaves the re-armed job as it is", async () => {
	const agents = new ListingHook();
	const soma = await stoppedThenReopened(agents);

	agents.afters.push(
		async () => {},
		async () => {
			throw new Error("rex call block.list failed");
		},
	);
	await shared.accepted(await soma.defer("PT2H"));
	expect(agents.afters).toEqual([]);
	expect(await soma.job("card-a")).toMatchObject({ reclaim: { phase: "due" } });
	expect(await soma.notices()).toEqual([]);
});

test("a job that is no longer due when the agent is found gone is left to whatever changed it", async () => {
	const agents = new ListingHook();
	const soma = await stoppedThenReopened(agents);

	agents.afters.push(
		async () => {},
		async () => {
			// The window closes, and a later change to the job lands before the back-move: a stop that failed.
			agents.close("card-a");
			await soma.root.commit(async (tx) => {
				const doc = await tx.doc(Dispatches, soma.root.id);
				doc.jobs[0] = { ...job, reclaim: { phase: "failed", error: "rex call block.close failed" } };
			}, context);
		},
	);
	await shared.accepted(await soma.defer("PT2H"));
	expect(agents.afters).toEqual([]);
	expect(await soma.job("card-a")).toMatchObject({
		reclaim: { phase: "failed", error: "rex call block.close failed" },
	});
});

/** What a move does to a deferral armed as its job moved: off the pending ones, and off the job. */
const takenOff = (root: Conversation, reclaim?: "stopping") =>
	root.commit(async (tx) => {
		const { items } = await tx.doc(Deferrals, root.id);
		for (const id of Object.keys(items)) delete items[id];
		const doc = await tx.doc(Dispatches, root.id);
		doc.jobs = doc.jobs.map(({ reclaim: _armed, ...each }) =>
			reclaim ? { ...each, reclaim: { phase: reclaim } } : each,
		);
	}, context);

test.each([
	["listed, about to be prompted", [{ name: "card-a", status: { state: "working" as const } }]],
	["not listed, about to be started again", []],
])(
	"a deferral its job's move takes off as it wakes, %s, ends cancelled, and sends, starts and tells nothing",
	async (_name, listed) => {
		const prompted: string[] = [];
		const resumed: ResumeRequest[] = [];
		let listings = 0;
		const opened = await core(await database(), {
			// The defer itself lists twice; the next listing is the wake's, which the move's commit gets ahead of.
			list: async () => {
				if (++listings === 3) await takenOff(opened.root);
				return listed;
			},
			prompt: async (_agent, text) => void prompted.push(text),
			resume: async (request) => void resumed.push(request),
			stop: async () => {},
		});
		const { harness, root, defer } = opened;
		const reply = await defer("PT1S");
		if (!reply.accepted) throw new Error(reply.reason);

		expect(await outcome(harness, reply.id)).toEqual({ status: "completed", result: "cancelled" });

		expect(listings).toBe(3);
		expect(prompted).toEqual([]);
		expect(resumed).toEqual([]);
		expect((await entries(root)).filter((entry) => entry.kind === NOTICE)).toEqual([]);
	},
);

test("a deferral its job's move took off wakes to say nothing, whatever holds the job by then", async () => {
	let listings = 0;
	const opened = await core(await database(), {
		// Within the defer, so whatever the machine's load this is done before the deferral can wake.
		list: async () => {
			if (++listings === 2) await takenOff(opened.root, "stopping");
			return [{ name: "card-a", status: { state: "working" } }];
		},
		prompt: async () => {},
		resume: async () => {},
		stop: async () => {},
	});
	const { harness, root, defer } = opened;
	const reply = await defer("PT1S");
	if (!reply.accepted) throw new Error(reply.reason);

	expect(await outcome(harness, reply.id)).toEqual({ status: "completed", result: "cancelled" });

	expect((await entries(root)).filter((entry) => entry.kind === NOTICE)).toEqual([]);
});
