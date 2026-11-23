import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { HUMAN_CHOSEN } from "../src/core/domain/dispatch.ts";
import { AGENT_BLOCKED, eventBridge, reconcileDispatches } from "../src/core/extensions/dispatch/bridge.ts";
import { answerJob, Dispatches, dispatchExtension, LEFT_UNDECIDED } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";
import { NOTICE } from "../src/core/notice.ts";
import type { AgentState } from "../src/ports/agent.ts";
import type { SomaEvent } from "../src/ports/human.ts";

const context = BACKGROUND_CONTEXT;
const open: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function database() {
	const directory = await mkdtemp(join(tmpdir(), "soma-undecided-"));
	directories.push(directory);
	return join(directory, "soma.sqlite");
}

/** What the faux model does with a wake of `card` on `fingerprint`; text only unless told otherwise. */
type Plan = (
	wake: { card: string; fingerprint: string },
	signal?: AbortSignal,
) => AssistantMessage | Promise<AssistantMessage>;

const textOnly: Plan = () => fauxAssistantMessage("你要選哪一個？");

const options = [
	{ id: "1", label: "Yes" },
	{ id: "2", label: "No" },
];
const prompt = {
	state: "blocked",
	kind: "permission",
	msg: "Bash command\nrm -rf /tmp/claude-txf\n1. Yes\n2. No",
	fingerprint: "f00d",
	options,
} as const satisfies AgentState;

/**
 * One core process over `db` with one job, card-a, recorded working; the faux model answers a wake by `plan`, and any
 * other input by `other`.
 */
async function core(
	db: string,
	agents: FakeAgentPort,
	plan: Plan = textOnly,
	other: () => AssistantMessage = () => fauxAssistantMessage("好。"),
) {
	const faux = fauxProvider();
	faux.setResponses(
		Array.from(
			{ length: 20 },
			() =>
				async (request: { messages: { role: string; content: unknown }[] }, streaming?: { signal?: AbortSignal }) => {
					const last = request.messages.at(-1);
					if (last?.role === "toolResult") return fauxAssistantMessage("好。");
					const said = JSON.stringify(last?.content ?? "");
					const wake = /卡片 ([a-z0-9-]+)）卡住了(?:.*?fingerprint=([0-9a-z]+))?/.exec(said);
					if (wake === null) return other();
					return plan({ card: wake[1] ?? "", fingerprint: wake[2] ?? "" }, streaming?.signal);
				},
		),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await openHarness(db, [dispatchExtension(agents, async (_repo, card) => `# ${card}`)], context, {
		models,
	});
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	await root.commit(async (tx) => {
		const doc = await tx.doc(Dispatches, root.id);
		if (doc.jobs.length > 0) return;
		doc.jobs.push({ card: "card-a", agent: "card-a", sessionId: "s", status: { state: "working" }, decisions: [] });
	}, context);
	harness.resume();
	const bridge = eventBridge(root, agents, context);
	const handled: Promise<void>[] = [];
	agents.onStatus((event) => handled.push(bridge.handle(event)));
	const handledAll = async () => {
		for (let seen = -1; seen !== handled.length; ) {
			seen = handled.length;
			await Promise.all(handled);
		}
	};
	const undecided = () =>
		root.commit(async (tx) => (await tx.scanTasks({ kind: "soma.dispatch.undecided" }, 100)).items, context);
	return {
		harness,
		root,
		bridge,
		calls: () => faux.state.callCount,
		handledAll,
		undecided,
		/** Every status handled, every run it started finished, and every wake's round looked at. */
		settle: async () => {
			await handledAll();
			await root.waitForIdle(context);
			for (const deadline = Date.now() + 5_000; ; await new Promise((resolve) => setTimeout(resolve, 10))) {
				if ((await undecided()).every((task) => task.state.status === "terminal")) break;
				expect(Date.now()).toBeLessThan(deadline);
			}
		},
		job: async () => (await harness.snapshot(Dispatches, root.id, context))?.jobs.find((job) => job.card === "card-a"),
		notices: async () =>
			(await root.entries({ order: "ascending" }, 1000, undefined, context)).items
				.filter((entry) => entry.kind === NOTICE)
				.map((entry) => entry.data as { kind: string; class: string; content: string; choices?: unknown }),
		wakes: async () =>
			(await root.entries({}, 1000, undefined, context)).items.filter((entry) => entry.kind === AGENT_BLOCKED),
	};
}

async function stop(soma: { harness: Harness }) {
	await soma.harness.close(context);
	open.splice(open.indexOf(soma.harness), 1);
}

test("a wake the model's round answers with text only reaches the human as one question offering the prompt's options", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(await database(), agents);

	agents.emit("card-a", prompt);
	await soma.settle();

	expect(soma.calls()).toBe(1);
	expect(agents.responses).toEqual([]);
	const notices = await soma.notices();
	expect(notices).toEqual([
		{
			kind: "question",
			class: "action",
			content: expect.stringContaining("agent card-a（卡片 card-a）卡在提示上"),
			choices: { card: "card-a", fingerprint: "f00d", options },
		},
	]);
	expect(notices[0]?.content).toContain("kind=permission");
	expect(notices[0]?.content).toContain(prompt.msg);
	expect(notices[0]?.content).not.toContain("你要選哪一個");
	expect((await soma.job())?.decisions).toEqual([
		{ at: expect.any(String), kind: "permission", action: "escalated", reason: LEFT_UNDECIDED },
	]);
});

test("a prompt whose screen gave no options is still handed over, as a question with no buttons", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(await database(), agents);

	agents.emit("card-a", { state: "blocked", kind: "question", msg: "Which branch?" });
	await soma.settle();

	expect(await soma.notices()).toEqual([
		{ kind: "question", class: "action", content: expect.stringContaining("Which branch?") },
	]);
	expect((await soma.job())?.decisions).toMatchObject([{ kind: "question", action: "escalated" }]);
});

test("a wake round that fails is handed over too, as a question offering the prompt's options", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(await database(), agents, () =>
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_request_error: the request was refused" }),
	);

	agents.emit("card-a", prompt);
	await soma.settle();

	const settled = await soma.root.commit(
		async (tx) => (await tx.submissionByRequest(soma.root.id, `agent:card-a:${(await soma.job())?.seq}`))?.status,
		context,
	);
	expect(settled).toBe("unanswered");
	expect(await soma.notices()).toEqual([
		{
			kind: "question",
			class: "action",
			content: expect.stringContaining(prompt.msg),
			choices: { card: "card-a", fingerprint: "f00d", options },
		},
	]);
	expect((await soma.job())?.decisions).toMatchObject([{ action: "escalated", reason: LEFT_UNDECIDED }]);
});

const refused = () =>
	fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_request_error: the request was refused" });

/** What the HumanPort over `soma` emits; `pushed` keeps what reaches the human: notices, and pushed answers or failures. */
async function listening(soma: Awaited<ReturnType<typeof core>>, agents: FakeAgentPort) {
	const human = await openHumanPort(soma.harness, soma.root, agents, context);
	const seen: SomaEvent[] = [];
	human.subscribe((event) => seen.push(event));
	return {
		seen,
		close: () => human.close(),
		pushed: () =>
			seen.filter(
				(event) =>
					event.type === "notice" ||
					((event.type === "failure" || event.type === "answer") && event.class !== undefined),
			),
	};
}

test("a failed wake round on a job still blocked reaches the human as one message, the question saying the round failed", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(await database(), agents, refused, refused);
	const human = await listening(soma, agents);

	agents.emit("card-a", prompt);
	await soma.settle();
	await vi.waitFor(() => expect(human.seen.some((event) => event.type === "notice")).toBe(true));
	// A round of another kind that fails is still pushed on its own.
	await soma.root.submit({ type: "input", content: "fire", requestId: "schedule:r1:1" }, context);
	await soma.root.waitForIdle(context);
	await vi.waitFor(() => expect(human.pushed()).toHaveLength(2));
	await human.close();

	expect(human.pushed()).toEqual([
		{
			type: "notice",
			kind: "question",
			class: "action",
			content: expect.stringContaining(
				"soma 的模型這一輪失敗（模型出錯：invalid_request_error: the request was refused），沒有決定，要你決定。",
			),
			choices: { card: "card-a", fingerprint: "f00d", options },
		},
		{ type: "failure", requestId: "schedule:r1:1", reason: expect.stringContaining("模型出錯"), class: "outcome" },
	]);
	expect(human.seen).toContainEqual({
		type: "failure",
		requestId: `agent:card-a:${(await soma.job())?.seq}`,
		reason: expect.any(String),
	});
});

test("a failed wake round on a job that moved past the prompt is told once, as the failed round", async () => {
	const agents = new FakeAgentPort();
	let soma: Awaited<ReturnType<typeof core>> | undefined;
	soma = await core(await database(), agents, async () => {
		agents.emit("card-a", { state: "working" });
		await soma?.handledAll();
		return refused();
	});
	const human = await listening(soma, agents);

	agents.emit("card-a", prompt);
	await soma.settle();
	await vi.waitFor(() => expect(human.pushed()).toHaveLength(1));
	await human.close();

	expect(human.pushed()).toEqual([
		{
			type: "notice",
			kind: "report",
			class: "outcome",
			content: expect.stringMatching(/^agent:card-a:\d+ 那一輪失敗：模型出錯：invalid_request_error/),
		},
	]);
	expect((await soma.job())?.decisions).toEqual([]);
});

test("a wake round the human stopped with HumanPort.stop is handed over as undecided, not as failed", async () => {
	const agents = new FakeAgentPort();
	let asked = () => {};
	const requested = new Promise<void>((resolve) => {
		asked = resolve;
	});
	const soma = await core(await database(), agents, (_wake, signal) => {
		asked();
		return new Promise<AssistantMessage>((resolve) =>
			signal?.addEventListener("abort", () =>
				resolve(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" })),
			),
		);
	});
	const human = await openHumanPort(soma.harness, soma.root, agents, context);
	const seen: SomaEvent[] = [];
	human.subscribe((event) => seen.push(event));

	agents.emit("card-a", prompt);
	await soma.handledAll();
	await requested;
	const requestId = `agent:card-a:${(await soma.job())?.seq}`;
	expect(await human.stop(requestId)).toBe(true);
	await soma.settle();
	await vi.waitFor(() => expect(seen.some((event) => event.type === "notice")).toBe(true));
	await human.close();

	expect(seen).toContainEqual({ type: "stopped", requestId });
	expect(seen.filter((event) => event.type === "notice" || event.type === "failure")).toEqual([
		expect.objectContaining({
			type: "notice",
			kind: "question",
			content: expect.stringContaining("soma 的模型沒有決定"),
		}),
	]);
});

test("a wake round the human stopped is handed over too, while the job still waits on the prompt", async () => {
	const agents = new FakeAgentPort();
	let asked = () => {};
	const requested = new Promise<void>((resolve) => {
		asked = resolve;
	});
	const soma = await core(await database(), agents, (_wake, signal) => {
		asked();
		return new Promise<AssistantMessage>((resolve) =>
			signal?.addEventListener("abort", () =>
				resolve(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" })),
			),
		);
	});

	agents.emit("card-a", prompt);
	await soma.handledAll();
	await requested;
	await soma.root.abort(context);
	await soma.settle();

	const settled = await soma.root.commit(
		async (tx) => (await tx.submissionByRequest(soma.root.id, `agent:card-a:${(await soma.job())?.seq}`))?.status,
		context,
	);
	expect(settled).toBe("unanswered");
	expect(await soma.notices()).toEqual([
		expect.objectContaining({ kind: "question", choices: { card: "card-a", fingerprint: "f00d", options } }),
	]);
	expect((await soma.job())?.decisions).toMatchObject([{ action: "escalated", reason: LEFT_UNDECIDED }]);
});

test("a prompt with no fingerprint that gave way to another during the round is left to that one's round", async () => {
	const agents = new FakeAgentPort();
	let soma: Awaited<ReturnType<typeof core>> | undefined;
	let first = true;
	soma = await core(await database(), agents, async ({ card }) => {
		if (first) {
			first = false;
			// Answered in the agent's own pane, which then stops at another prompt with no options either.
			agents.emit("card-a", { state: "working" });
			agents.emit("card-a", { state: "blocked", kind: "question", msg: "Which file?" });
			await soma?.handledAll();
			return fauxAssistantMessage("你要選哪一個？");
		}
		return fauxAssistantMessage(
			[fauxToolCall("escalate", { card, question: "要改哪個檔案？", reason: "畫面讀不出選項" })],
			{
				stopReason: "toolUse",
			},
		);
	});

	agents.emit("card-a", { state: "blocked", kind: "question", msg: "Which branch?" });
	await soma.settle();

	expect(await soma.wakes()).toHaveLength(2);
	expect(await soma.notices()).toEqual([
		{ kind: "question", class: "action", content: "agent card-a（卡片 card-a）：要改哪個檔案？" },
	]);
	expect((await soma.job())?.decisions).toMatchObject([{ action: "escalated", reason: "畫面讀不出選項" }]);
});

test("a round that answers the prompt with respond writes no notice", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(await database(), agents, ({ card, fingerprint }) =>
		fauxAssistantMessage([fauxToolCall("respond", { card, option: "1", fingerprint, reason: "a temp dir" })], {
			stopReason: "toolUse",
		}),
	);

	agents.emit("card-a", prompt);
	await soma.settle();

	expect(agents.responses).toEqual([{ agent: "card-a", answer: { option: "1", fingerprint: "f00d" } }]);
	expect(await soma.notices()).toEqual([]);
	expect((await soma.job())?.decisions).toMatchObject([{ action: "answered" }]);
});

test("a round that escalates the prompt writes only its own notice, on a job still blocked on it", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(await database(), agents, ({ card }) =>
		fauxAssistantMessage(
			[fauxToolCall("escalate", { card, question: "要刪 /tmp/claude-txf 嗎？", reason: "rm -rf" })],
			{ stopReason: "toolUse" },
		),
	);

	agents.emit("card-a", prompt);
	await soma.settle();

	expect((await soma.job())?.status).toEqual(prompt);
	expect(await soma.notices()).toEqual([
		{
			kind: "question",
			class: "action",
			content: "agent card-a（卡片 card-a）：要刪 /tmp/claude-txf 嗎？",
			choices: { card: "card-a", fingerprint: "f00d", options },
		},
	]);
	expect((await soma.job())?.decisions).toMatchObject([{ action: "escalated", reason: "rm -rf" }]);
});

test.each([
	["a prompt", prompt],
	["a prompt whose screen gave no fingerprint", { state: "blocked", kind: "question", msg: "Which branch?" } as const],
])("a job that moved past %s before the round ended gets no notice", async (_name, blocked: AgentState) => {
	const agents = new FakeAgentPort();
	let soma: Awaited<ReturnType<typeof core>> | undefined;
	soma = await core(await database(), agents, async () => {
		// Answered in the agent's own pane while the model wrote.
		agents.emit("card-a", { state: "working" });
		await soma?.handledAll();
		return fauxAssistantMessage("你要選哪一個？");
	});

	agents.emit("card-a", blocked);
	await soma.settle();

	expect((await soma.job())?.status).toEqual({ state: "working" });
	expect(await soma.notices()).toEqual([]);
	expect((await soma.job())?.decisions).toEqual([]);
});

test("a job blocked on another prompt when the round ended is left to that prompt's own round", async () => {
	const agents = new FakeAgentPort();
	let soma: Awaited<ReturnType<typeof core>> | undefined;
	soma = await core(await database(), agents, async ({ card, fingerprint }) => {
		if (fingerprint === "f00d") {
			agents.emit("card-a", { ...prompt, fingerprint: "be4d", msg: "Bash command\nls\n1. Yes\n2. No" });
			await soma?.handledAll();
			return fauxAssistantMessage("你要選哪一個？");
		}
		return fauxAssistantMessage(
			[fauxToolCall("respond", { card, option: "1", fingerprint, reason: "ls only reads" })],
			{
				stopReason: "toolUse",
			},
		);
	});

	agents.emit("card-a", prompt);
	await soma.settle();

	expect(await soma.wakes()).toHaveLength(2);
	expect(agents.responses).toEqual([{ agent: "card-a", answer: { option: "1", fingerprint: "be4d" } }]);
	expect(await soma.notices()).toEqual([]);
	expect((await soma.job())?.decisions).toMatchObject([{ action: "answered", fingerprint: "be4d" }]);
});

test("the same prompt blocked on again while its first round ran is handed over once", async () => {
	const agents = new FakeAgentPort();
	let soma: Awaited<ReturnType<typeof core>> | undefined;
	let first = true;
	soma = await core(await database(), agents, async () => {
		if (first) {
			first = false;
			// The agent went on and stopped at a prompt that reads the same: a second wake, queued behind this round.
			agents.emit("card-a", { state: "working" });
			agents.emit("card-a", prompt);
			await soma?.handledAll();
		}
		return fauxAssistantMessage("你要選哪一個？");
	});

	agents.emit("card-a", prompt);
	await soma.settle();

	expect(await soma.wakes()).toHaveLength(2);
	expect(soma.calls()).toBe(2);
	expect(await soma.notices()).toHaveLength(1);
	expect((await soma.job())?.decisions).toMatchObject([{ action: "escalated", reason: LEFT_UNDECIDED }]);
});

test("a prompt the human answered by its button during the round gets no notice, before the agent reports moving on", async () => {
	const agents = new FakeAgentPort();
	const pressed: unknown[] = [];
	// The key went out, and the agent side has not reported a status since: the job still reads blocked on the prompt.
	const pane = {
		respond: async (agent: string, answer: unknown) => {
			pressed.push({ agent, answer });
			return { sent: true as const };
		},
	};
	let soma: Awaited<ReturnType<typeof core>> | undefined;
	soma = await core(await database(), agents, async () => {
		const root = soma?.root;
		if (root !== undefined) {
			await answerJob(pane, (change) => root.commit(change, context), root.id, {
				card: "card-a",
				answer: { option: "2", fingerprint: "f00d" },
				reason: HUMAN_CHOSEN,
			});
		}
		return fauxAssistantMessage("你要選哪一個？");
	});

	agents.emit("card-a", prompt);
	await soma.settle();

	expect(pressed).toEqual([{ agent: "card-a", answer: { option: "2", fingerprint: "f00d" } }]);
	expect((await soma.job())?.status).toEqual(prompt);
	expect(await soma.notices()).toEqual([]);
	expect((await soma.job())?.decisions).toMatchObject([{ action: "answered", reason: HUMAN_CHOSEN }]);
});

test("a resent blocked event, the same prompt under a new seq, and a restart hand the prompt over once", async () => {
	const db = await database();
	const agents = new FakeAgentPort();
	const first = await core(db, agents);
	agents.emit("card-a", prompt, 7);
	await first.settle();
	await first.bridge.handle({ agent: "card-a", status: prompt, seq: 7 });
	agents.emit("card-a", prompt, 8);
	await first.settle();
	expect(await first.notices()).toHaveLength(1);
	await stop(first);

	const again = new FakeAgentPort();
	again.emit("card-a", prompt, 9);
	const second = await core(db, again);
	await reconcileDispatches(second.root, again, context);
	await second.settle();

	expect(second.calls()).toBe(0);
	expect(await second.wakes()).toHaveLength(1);
	expect(await second.notices()).toHaveLength(1);
	expect((await second.job())?.decisions).toMatchObject([{ action: "escalated", reason: LEFT_UNDECIDED }]);
});

test("a restart while the wake's round runs hands the prompt over once, when the resumed round ends", async () => {
	const db = await database();
	const agents = new FakeAgentPort();
	let asked = () => {};
	const requested = new Promise<void>((resolve) => {
		asked = resolve;
	});
	const first = await core(db, agents, (_wake, signal) => {
		asked();
		// Answers nothing before the process stops while the model writes.
		return new Promise<AssistantMessage>((resolve) =>
			signal?.addEventListener("abort", () =>
				resolve(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" })),
			),
		);
	});
	agents.emit("card-a", prompt, 7);
	await first.handledAll();
	await requested;
	expect((await first.undecided()).map((task) => task.state.status)).not.toContain("terminal");
	expect(await first.notices()).toEqual([]);
	const calls = first.calls();
	await stop(first);

	const again = new FakeAgentPort();
	again.emit("card-a", prompt, 7);
	const second = await core(db, again);
	await reconcileDispatches(second.root, again, context);
	await second.settle();

	expect(calls).toBe(1);
	expect(second.calls()).toBe(1);
	expect(await second.wakes()).toHaveLength(1);
	expect(await second.notices()).toEqual([expect.objectContaining({ kind: "question", choices: expect.any(Object) })]);
	expect((await second.job())?.decisions).toMatchObject([{ action: "escalated", reason: LEFT_UNDECIDED }]);
});
