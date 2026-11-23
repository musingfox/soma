import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	type ConversationId,
	defineExtension,
	defineTask,
	type JsonObject,
	type TaskId,
} from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { composeTicketPrompt } from "../src/core/domain/launch-prompt.ts";
import { MODEL_LINE_PREFIX } from "../src/core/domain/memory.ts";
import { askExtension, Questions } from "../src/core/extensions/ask/index.ts";
import { eventBridge } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { inspectExtension } from "../src/core/extensions/inspect/index.ts";
import { Curated, memory } from "../src/core/extensions/memory/index.ts";
import { openHarness, openStorage } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";
import { isPrompt, type SomaEvent } from "../src/ports/human.ts";

const context = BACKGROUND_CONTEXT;
const TERMINAL = "chat.terminal";
const TICKET = "請開一張票：soma 的排程要能每週跑一次";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

type Call = { readonly tool: string; readonly args: JsonObject };

/**
 * Makes a conversation it owns, which starts as a copy of the root's agent and so keeps the root's tools, and runs one
 * round there: the scheduled work the home rule is for. Its result is the conversation's id.
 */
const InChild = defineTask<null, { phase: "run" }, ConversationId>({
	name: "test.in-child",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (_task, runtime, context) => {
			let child: ConversationId | undefined;
			await runtime.commit(async (tx, current) => {
				child = (await tx.createConversation({ ownership: { kind: "task", taskId: current.id } })).id;
			}, context);
			const conversation = await runtime.conversation(child as ConversationId, context);
			const submission = await conversation?.submit({ type: "input", content: "排程的工作" }, context);
			await submission?.wait(context);
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: child as ConversationId } }),
				context,
			);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "soma-home-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const storage = await openStorage(join(directory, "soma.sqlite"));
	const agents = new FakeAgentPort();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await openHarness(
		storage,
		[
			memory,
			inspectExtension(storage),
			askExtension({ storage, interfaces: [TERMINAL] }),
			dispatchExtension(agents, async (_repo, card) => `# ${card}`),
			defineExtension({ name: "test.home", tasks: [InChild] }),
		],
		context,
		{ models },
	);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	await root.commit(async (tx) => {
		const curated = await tx.doc(Curated);
		curated.lines.push({
			id: 1,
			by: "model",
			text: `${MODEL_LINE_PREFIX}2026-11-01T00:00:00.000Z：使用者早上九點開會`,
		});
		curated.next = 2;
	}, context);
	harness.resume();
	const bridge = eventBridge(root, agents, context);
	const handled: Promise<void>[] = [];
	agents.onStatus((event) => handled.push(bridge.handle(event)));
	const human = await openHumanPort(harness, root, agents, context);
	cleanup.push(() => human.close());
	const events: SomaEvent[] = [];
	human.subscribe((event) => events.push(event));

	/** One round in a task-owned conversation in which the model makes `calls` in order; their results as it saw them. */
	async function inChild(calls: readonly Call[]) {
		const results: string[] = [];
		const lastResult = (request: { messages: readonly unknown[] }) => {
			const message = JSON.parse(JSON.stringify(request.messages.at(-1)));
			results.push(message.content[0].text);
		};
		faux.setResponses([
			...calls.map((call, index) => (request: { messages: readonly unknown[] }) => {
				if (index > 0) lastResult(request);
				return fauxAssistantMessage([fauxToolCall(call.tool, call.args)], { stopReason: "toolUse" });
			}),
			(request) => {
				lastResult(request);
				return fauxAssistantMessage("好了。");
			},
		]);
		let task: TaskId<ConversationId> | undefined;
		await root.commit(async (tx) => {
			task = await tx.createTask(InChild, null, { ownership: { kind: "conversation" }, background: true });
		}, context);
		const settled = await harness.waitForTask(task as TaskId<ConversationId>, context);
		if (settled.state.outcome.status !== "completed") throw new Error("the child's task did not complete");
		const child = settled.state.outcome.result;
		return {
			child,
			results,
			/** The child's own conversation-scoped documents, as they were made. */
			own: async () => ({
				jobs: (await harness.snapshot(Dispatches, child, context))?.jobs ?? [],
				questions: (await harness.snapshot(Questions, child, context))?.questions ?? {},
			}),
		};
	}
	const settle = async () => {
		for (let seen = -1; seen !== handled.length; ) {
			seen = handled.length;
			await Promise.all(handled);
		}
	};
	const rootJobs = async () => (await harness.snapshot(Dispatches, root.id, context))?.jobs ?? [];
	const rootQuestions = async () => (await harness.snapshot(Questions, root.id, context))?.questions;
	const notices = () => events.flatMap((event) => (event.type === "notice" ? [event] : []));
	return { agents, inChild, settle, rootJobs, rootQuestions, notices };
}

const dispatchTicket: Call = { tool: "dispatch", args: { card: "ticket-weekly", repo: "/repo", ticket: TICKET } };
const initial = { jobs: [], questions: {} };

test("a dispatch in a task-owned conversation is the root's job, which the bridge launches at its first idle", async () => {
	const { agents, inChild, settle, rootJobs } = await setup();

	const { results, own } = await inChild([dispatchTicket, { tool: "jobs", args: {} }]);

	expect(agents.started).toMatchObject([{ name: "ticket-weekly", card: "ticket-weekly", cwd: "/repo" }]);
	expect(await rootJobs()).toMatchObject([
		{ card: "ticket-weekly", ticket: TICKET, launch: composeTicketPrompt(TICKET) },
	]);
	expect(JSON.parse(results[1] ?? "")).toMatchObject([{ card: "ticket-weekly", ticket: TICKET }]);
	expect(await own()).toEqual(initial);

	agents.emit("ticket-weekly", { state: "idle" });
	await settle();
	expect(agents.prompts).toEqual([{ agent: "ticket-weekly", text: composeTicketPrompt(TICKET) }]);
	expect(await rootJobs()).toMatchObject([{ card: "ticket-weekly", status: { state: "working" } }]);
});

test("a memory revision in a task-owned conversation reaches the human through HumanPort", async () => {
	const { inChild, notices } = await setup();

	const { own } = await inChild([
		{
			tool: "revise_memory",
			args: { line: 1, text: "使用者早上十點開會", reason: "使用者改了時間", evidence: ["entry:1"] },
		},
	]);

	expect(notices()).toEqual([
		{
			type: "notice",
			kind: "report",
			class: "ambient",
			content: expect.stringMatching(/修改了長期記憶 #1：.*九點.*→.*十點/),
		},
	]);
	expect(await own()).toEqual(initial);
});

test("a question asked in a task-owned conversation reaches the human with its choices", async () => {
	const { inChild, notices, rootQuestions } = await setup();

	const { own } = await inChild([{ tool: "ask", args: { question: "要現在跑嗎？", options: ["現在", "晚點"] } }]);

	const [notice] = notices();
	expect(notice).toEqual({
		type: "notice",
		kind: "question",
		class: "action",
		content: "要現在跑嗎？",
		choices: {
			question: expect.stringMatching(/^[0-9a-f]{16}$/),
			options: [
				{ id: "1", label: "現在" },
				{ id: "2", label: "晚點" },
			],
		},
	});
	const choices = notice?.kind === "question" ? notice.choices : undefined;
	const question = choices !== undefined && !isPrompt(choices) ? choices.question : undefined;
	expect(Object.keys((await rootQuestions()) ?? {})).toEqual([question]);
	expect(await own()).toEqual(initial);
});

test("inspect for jobs in a task-owned conversation lists the root's", async () => {
	const { inChild } = await setup();
	await inChild([dispatchTicket]);

	const { results, own } = await inChild([{ tool: "inspect", args: { what: "jobs" } }]);

	expect(JSON.parse(results[0] ?? "")).toMatchObject({
		total: 1,
		items: [{ card: "ticket-weekly", agent: "ticket-weekly" }],
	});
	expect(await own()).toEqual(initial);
});
