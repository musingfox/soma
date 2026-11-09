import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { NOTICE } from "../src/core/notice.ts";
import type { AgentHandover, HandoverOutcome } from "../src/ports/handover.ts";

const context = BACKGROUND_CONTEXT;
const open: Harness[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
});

const MOVED: HandoverOutcome = {
	handedOver: true,
	window: "card-a",
	session: "soma-hangar",
	sessionId: "the-claude-session",
	ready: true,
};

/** The real core with one job dispatched, over a fake agent side and `handover`, or none. */
async function setup(handover?: AgentHandover) {
	const agents = new FakeAgentPort();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(dispatchExtension(agents, async (_repo, card) => `# ${card}`, handover));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const call = async (tool: string, args: Record<string, string>, requestId: string) => {
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
	};
	await call("dispatch", { card: "card-a", repo: "/repo" }, "dispatch");
	const job = async () => (await harness.snapshot(Dispatches, root.id, context))?.jobs[0];
	const notices = async () =>
		(await root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter((each) => each.kind === NOTICE);
	return { call, job, notices, root };
}

/** A handover that answers `outcome` and counts its calls. */
function stub(outcome: HandoverOutcome) {
	const asked: string[] = [];
	return {
		asked,
		handOver: async (agent: string, record?: (outcome: HandoverOutcome) => Promise<void>) => {
			asked.push(agent);
			await record?.(outcome);
			return outcome;
		},
	};
}

test("the tool tells the model to use it when the human asks to see, show or take over a job", () => {
	const tool = (dispatchExtension(new FakeAgentPort(), async () => "").tools ?? []).find(
		(each) => each.name === "show_job",
	);
	expect(tool?.description).toMatch(/when the human asks to see, show or take over a job/);
	expect(tool?.replay).toBe("unsafe");
});

test("the tool says it interrupts a running job and cancels a pending prompt, so is only for when the human asks", () => {
	const tool = (dispatchExtension(new FakeAgentPort(), async () => "").tools ?? []).find(
		(each) => each.name === "show_job",
	);
	expect(tool?.description).toMatch(/interrupts a running job/);
	expect(tool?.description).toMatch(/cancels a pending prompt/);
	expect(tool?.description).toMatch(/use it only when the human asks/);
	expect(tool?.description).toMatch(/A deferred instruction the job sets as it moves is cancelled/);
	expect(tool?.description).toMatch(/in a notice quoting the reason: do not repeat either/);
});

test("a soma with no rex hangar refuses, saying so, with nothing done", async () => {
	const { call, job, notices } = await setup();
	const before = await job();

	expect(await call("show_job", { card: "card-a" }, "show")).toEqual({
		handedOver: false,
		refusal: "no_hangar",
		reason: "no rex hangar is configured: rex.sessionId names one",
	});

	expect(await job()).toEqual(before);
	expect(await notices()).toEqual([]);
});

test("an unknown card is refused before the agent side is asked", async () => {
	const handover = stub(MOVED);
	const { call, notices } = await setup(handover);

	expect(await call("show_job", { card: "nobody" }, "show")).toEqual({
		handedOver: false,
		refusal: "unknown",
		reason: "no job for card nobody",
	});

	expect(handover.asked).toEqual([]);
	expect(await notices()).toEqual([]);
});

test("what the agent side refuses comes back with its reason, with the job as it was and no notice", async () => {
	const refused: HandoverOutcome = { handedOver: false, refusal: "not_at_rest", reason: "card-a is working" };
	const handover = stub(refused);
	const { call, job, notices } = await setup(handover);
	const before = await job();

	expect(await call("show_job", { card: "card-a" }, "show")).toEqual(refused);

	expect(handover.asked).toEqual(["card-a"]);
	expect(await job()).toEqual(before);
	expect(await notices()).toEqual([]);
});

test("a handover that throws is a refusal with its message, with no notice", async () => {
	const { call, notices } = await setup({ handOver: () => Promise.reject(new Error("rex is away")) });

	expect(await call("show_job", { card: "card-a" }, "show")).toEqual({
		handedOver: false,
		refusal: "cannot_resume",
		reason: "rex is away",
	});
	expect(await notices()).toEqual([]);
});

test.each(["due", "sending", "resuming", "stopping", "stopped"] as const)(
	"a job whose deferral holds it (%s) is refused before the agent side is asked",
	async (phase) => {
		const handover = stub(MOVED);
		const { call, job, root, notices } = await setup(handover);
		await root.commit(async (tx) => {
			const doc = await tx.doc(Dispatches, root.id);
			doc.jobs[0] = { ...(doc.jobs[0] as NonNullable<(typeof doc.jobs)[0]>), reclaim: { phase } };
		}, context);

		expect(await call("show_job", { card: "card-a" }, "show")).toMatchObject({
			handedOver: false,
			refusal: "not_at_rest",
			reason: expect.stringContaining(phase),
		});

		expect(handover.asked).toEqual([]);
		expect((await job())?.reclaim).toEqual({ phase });
		expect(await notices()).toEqual([]);
	},
);

test("a job whose stop failed may still be handed over", async () => {
	const handover = stub(MOVED);
	const { call, root } = await setup(handover);
	await root.commit(async (tx) => {
		const doc = await tx.doc(Dispatches, root.id);
		doc.jobs[0] = { ...(doc.jobs[0] as NonNullable<(typeof doc.jobs)[0]>), reclaim: { phase: "failed", error: "x" } };
	}, context);

	expect(await call("show_job", { card: "card-a" }, "show")).toEqual(MOVED);
});

test("a move takes the session id the window runs, lets go of a brief it still holds, and tells the human once, naming the window", async () => {
	const { call, job, notices } = await setup(stub(MOVED));
	const before = await job();
	expect(before?.launch).toBeDefined();

	expect(await call("show_job", { card: "card-a" }, "show")).toEqual(MOVED);

	const { launch: _sent, ...kept } = before as NonNullable<typeof before>;
	// This agent side's transcript reads nothing, so a `complete` before the window's next working takes what it reads then.
	expect(await job()).toEqual({ ...kept, sessionId: "the-claude-session", resultUnread: true });
	const told = await notices();
	expect(told).toHaveLength(1);
	expect(told[0]?.data).toEqual({
		kind: "report",
		class: "outcome",
		content: expect.stringContaining("its window is card-a in session soma-hangar"),
	});
});

test("a window not up yet says so in the notice", async () => {
	const { call, notices } = await setup(stub({ ...MOVED, ready: false } as HandoverOutcome));

	await call("show_job", { card: "card-a" }, "show");

	expect((await notices())[0]?.data).toMatchObject({ content: expect.stringContaining("has not reported itself up") });
});
