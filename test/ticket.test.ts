import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { composeLaunchPrompt, composeTicketPrompt, TICKET_CARD_LINE } from "../src/core/domain/launch-prompt.ts";
import { PRESETS } from "../src/core/domain/push.ts";
import { eventBridge, JOB_DONE } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { reflection } from "../src/core/extensions/reflection/index.ts";
import { openHumanPort } from "../src/core/human-port.ts";
import { NOTICE } from "../src/core/notice.ts";
import type { SomaEvent } from "../src/ports/human.ts";

const context = BACKGROUND_CONTEXT;
const open: Harness[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
});

const REQUEST = "幫我開一張票：soma 的 digest 太長了，要短一點";

type Request = { messages: { role: string; content: unknown }[] };

/**
 * A core with dispatch and reflection, so the model sees open_card beside dispatch as it does in prod. Every card read
 * or created is recorded; none is real.
 */
async function core() {
	const agents = new FakeAgentPort();
	const reads: string[] = [];
	const created: string[] = [];
	const readCard = async (_repo: string, card: string) => {
		reads.push(card);
		return `# ${card}`;
	};
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(dispatchExtension(agents, readCard));
	registry.install(
		reflection({
			repo: "/soma",
			readCard,
			createCard: async (_repo, card) => {
				created.push(card);
				return true;
			},
			agents,
		}).extension,
	);
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { models, registry }, context);
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const bridge = eventBridge(root, agents, context);
	const handled: Promise<void>[] = [];
	agents.onStatus((event) => handled.push(bridge.handle(event)));
	const settle = async () => {
		for (let seen = -1; seen !== handled.length; ) {
			seen = handled.length;
			await Promise.all(handled);
		}
	};
	const entries = async () => (await root.entries({ order: "ascending" }, 1000, undefined, context)).items;
	const jobs = async () => (await harness.snapshot(Dispatches, root.id, context))?.jobs ?? [];
	return { agents, faux, harness, storage, root, reads, created, settle, entries, jobs };
}

test("a ticket the human asks for is dispatched with their request as the brief, not opened with open_card", async () => {
	const { agents, faux, root, reads, created, settle, entries, jobs } = await core();
	let tools = "";
	faux.setResponses([
		(request) => {
			tools = JSON.stringify((request as unknown as Request).messages.filter((message) => message.role === "system"));
			return fauxAssistantMessage(
				[fauxToolCall("dispatch", { card: "ticket-short-digest", repo: "/soma", ticket: REQUEST })],
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage("派了一個 agent 去寫這張卡，寫好會告訴你卡名。"),
	]);

	const submission = await root.submit({ type: "input", content: REQUEST, requestId: "telegram:1" }, context);
	expect((await submission.wait(context)).status).toBe("done");
	// The agent side reports the new agent idle once it is up, after the job is recorded.
	agents.emit("ticket-short-digest", { state: "idle" });
	await settle();

	// What the model is told: a ticket goes to dispatch, and open_card is not for it.
	expect(tools).toContain("When the human asks for a ticket");
	expect(tools).toContain("Never for a ticket the human asks for");
	// No card is written or read by soma, and nothing asks for evidence ids.
	expect(created).toEqual([]);
	expect(reads).toEqual([]);
	expect(agents.started).toMatchObject([{ name: "ticket-short-digest", cwd: "/soma" }]);
	expect(await jobs()).toMatchObject([{ card: "ticket-short-digest", ticket: REQUEST }]);
	// The bridge sends the brief once the agent is idle: the request word for word, with where the card goes.
	const [brief] = agents.prompts;
	expect(brief?.agent).toBe("ticket-short-digest");
	expect(brief?.text).toContain(`The human's request:\n\n${REQUEST}`);
	expect(brief?.text).toContain("under pm/<project>/tasks/");
	expect(brief?.text).toContain("quote it word for word");
	expect(brief?.text).toContain("結果：完成");

	agents.finish("ticket-short-digest", `結果：完成\n${TICKET_CARD_LINE}soma-digest-too-long\n寫好了。`);
	await settle();

	// The card's name goes to the human at once, not at the next digest, nobody having touched the job.
	const notices = (await entries()).filter((entry) => entry.kind === NOTICE);
	expect(notices).toHaveLength(1);
	expect(notices[0]?.data).toMatchObject({
		kind: "report",
		class: "outcome",
		content: expect.stringContaining(`${TICKET_CARD_LINE}soma-digest-too-long`),
	});
	const done = (await entries()).filter((entry) => entry.kind === JOB_DONE);
	expect(done.map((entry) => entry.data)).toMatchObject([{ outcome: "完成", notified: true }]);
});

test("a ticket job is not started twice, and a plain dispatch still reads its card", async () => {
	const { agents, faux, root, reads } = await core();
	const say = async (calls: ReturnType<typeof fauxToolCall>[], requestId: string) => {
		faux.setResponses([fauxAssistantMessage(calls, { stopReason: "toolUse" }), fauxAssistantMessage("ok")]);
		const submission = await root.submit({ type: "input", content: requestId, requestId }, context);
		expect((await submission.wait(context)).status).toBe("done");
	};

	await say([fauxToolCall("dispatch", { card: "ticket-a", repo: "/soma", ticket: REQUEST })], "r1");
	await say([fauxToolCall("dispatch", { card: "ticket-a", repo: "/soma", ticket: REQUEST })], "r2");
	await say([fauxToolCall("dispatch", { card: "card-b", repo: "/soma" })], "r3");

	expect(agents.started.map((request) => request.name)).toEqual(["ticket-a", "card-b"]);
	expect(reads).toEqual(["card-b"]);
});

test.each([
	["drops", ""],
	["keeps", `\n- ${TICKET_CARD_LINE}soma-digest-too-long。`],
] as const)(
	"a ticket job's 完成 held for a summary-mode Telegram reaches it with the card's name once when the summary's model %s it",
	async (_label, kept) => {
		const { agents, faux, harness, storage, root, settle } = await core();
		const TELEGRAM = "chat.telegram";
		const human = await openHumanPort(harness, root, agents, context, {
			defaultTarget: TELEGRAM,
			policies: { [TELEGRAM]: PRESETS.summary },
			checkMs: 10,
			summaryIdleMs: 0,
			storage,
		});
		const seen: SomaEvent[] = [];
		human.subscribe((event) => seen.push(event));
		let summarized = "";
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("dispatch", { card: "ticket-short-digest", repo: "/soma", ticket: REQUEST })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("派了一個 agent 去寫這張卡。"),
			(request) => {
				const last = (request as unknown as Request).messages.findLast((message) => message.role === "user")?.content;
				summarized = typeof last === "string" ? last : JSON.stringify(last);
				return fauxAssistantMessage(`摘要：寫好了一張卡。${kept}`);
			},
		]);

		const submission = await root.submit({ type: "input", content: REQUEST, requestId: "terminal:1" }, context);
		expect((await submission.wait(context)).status).toBe("done");
		agents.emit("ticket-short-digest", { state: "idle" });
		await settle();
		agents.finish("ticket-short-digest", `結果：完成\n${TICKET_CARD_LINE}soma-digest-too-long\n寫好了。`);
		await settle();

		const summaries = () =>
			seen.flatMap((event) =>
				event.type === "notice" && event.kind === "report" && event.content.startsWith("摘要") ? [event] : [],
			);
		await vi.waitFor(() => expect(summaries()).toHaveLength(1));
		await human.close();
		// The 完成 notice itself was held, not shown on Telegram; the summary that covers it carries the card's line once.
		const told = seen.find(
			(event) => event.type === "notice" && event.kind === "report" && event.content.includes("這一輪結束了"),
		);
		expect(told).toMatchObject({ delivery: { [TELEGRAM]: "log" } });
		expect(summarized).toContain(`${TICKET_CARD_LINE}soma-digest-too-long`);
		const [summary] = summaries();
		expect(summary).toMatchObject({ delivery: { [TELEGRAM]: "ring" } });
		expect(summary?.type === "notice" && summary.content.split(`${TICKET_CARD_LINE}soma-digest-too-long`)).toHaveLength(
			2,
		);
	},
);

test("a blocked ticket job wakes the model saying it is a ticket job, to refuse an Edit or Write outside the vault and reply after", async () => {
	const { agents, faux, root, settle } = await core();
	const said: string[] = [];
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("dispatch", { card: "ticket-a", repo: "/soma", ticket: REQUEST }),
				fauxToolCall("dispatch", { card: "card-b", repo: "/soma" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("ok"),
		...Array.from({ length: 4 }, () => (request: unknown) => {
			const last = (request as Request).messages.findLast((message) => message.role === "user")?.content;
			said.push(typeof last === "string" ? last : JSON.stringify(last));
			return fauxAssistantMessage("好。");
		}),
	]);
	const submission = await root.submit({ type: "input", content: REQUEST, requestId: "terminal:1" }, context);
	expect((await submission.wait(context)).status).toBe("done");

	const edit = { state: "blocked", kind: "permission", msg: "Edit src/main.ts?", fingerprint: "fp1" } as const;
	agents.emit("ticket-a", edit);
	agents.emit("card-b", edit);
	await settle();
	await root.waitForIdle(context);

	const ticket = said.find((each) => each.includes("（卡片 ticket-a）卡住了")) ?? "";
	const plain = said.find((each) => each.includes("（卡片 card-b）卡住了")) ?? "";
	expect(ticket).toContain("This is a ticket job: its agent must only write one task card in the vault");
	expect(ticket).toContain("Refuse an Edit or Write of any file outside the vault");
	// claude stops and waits after a "no", so the wake says to follow the refusal with a reply.
	expect(ticket).toContain(
		"right after refusing, use the reply tool (card=ticket-a) to tell it to write only the card in the vault and to " +
			"finish with its result line",
	);
	expect(ticket).toContain("fingerprint=fp1");
	expect(plain).toContain("fingerprint=fp1");
	expect(plain).not.toContain("ticket job");
});

test("a ticket on a job name already taken by another request is not dispatched, and the model is told why", async () => {
	const { agents, faux, root, jobs } = await core();
	let result: unknown;
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("dispatch", { card: "ticket-a", repo: "/soma", ticket: REQUEST })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("ok"),
		fauxAssistantMessage(
			[fauxToolCall("dispatch", { card: "ticket-a", repo: "/soma", ticket: "幫我開一張票：hangar 滿了要排隊" })],
			{ stopReason: "toolUse" },
		),
		(request) => {
			const last = (request as unknown as Request).messages.at(-1)?.content as { text: string }[];
			result = JSON.parse(last[0]?.text ?? "null");
			return fauxAssistantMessage("ok");
		},
	]);
	for (const requestId of ["r1", "r2"]) {
		const submission = await root.submit({ type: "input", content: requestId, requestId }, context);
		expect((await submission.wait(context)).status).toBe("done");
	}

	expect(result).toEqual({
		dispatched: false,
		reason: expect.stringContaining("the job name ticket-a is taken by another ticket"),
	});
	expect(JSON.stringify(result)).toContain("the same ticket and a new job name");
	expect(agents.started.map((request) => request.name)).toEqual(["ticket-a"]);
	expect(await jobs()).toMatchObject([{ card: "ticket-a", ticket: REQUEST }]);
});

test("a ticket and a card clashing on a job name are told what fits each", async () => {
	const { agents, root, jobs } = await core();
	const tool = dispatchExtension(agents, async (_repo, card) => `# ${card}`).tools?.find(
		(each) => each.name === "dispatch",
	) as { execute(args: object, api: ToolExecutionApi, context: Context): Promise<{ output: unknown }> } | undefined;
	// Each call its own api, as each tool call has its own memos.
	const call = async (args: object) => {
		const memos = new Map<string, unknown>();
		const api = {
			conversationId: root.id,
			memo: async (name: string, candidate: unknown) => {
				if (!memos.has(name)) memos.set(name, candidate);
				return memos.get(name);
			},
			commit: <T>(change: (tx: Tx) => Promise<T>) => root.commit(change, context),
		} as unknown as ToolExecutionApi;
		const result = await tool?.execute(args, api, context);
		return JSON.parse((result?.output as { text: string }[] | undefined)?.[0]?.text ?? "null");
	};
	await call({ card: "card-b", repo: "/soma" });
	await call({ card: "ticket-a", repo: "/soma", ticket: REQUEST });

	const ticketOnCard = await call({ card: "card-b", repo: "/soma", ticket: REQUEST });
	const cardOnTicket = await call({ card: "ticket-a", repo: "/soma" });

	expect(ticketOnCard).toEqual({ dispatched: false, reason: expect.stringContaining("taken by a card's job") });
	expect(ticketOnCard.reason).toContain("the same ticket and a new job name, such as ticket-<topic>");
	expect(cardOnTicket).toEqual({ dispatched: false, reason: expect.stringContaining("taken by a ticket job") });
	expect(cardOnTicket.reason).toContain("tell the human");
	expect(cardOnTicket.reason).not.toContain("new job name");
	expect(agents.started.map((request) => request.name)).toEqual(["card-b", "ticket-a"]);
	expect(await jobs()).toHaveLength(2);
});

test("the same ticket call rerun after a crash gets its first job back and starts nothing again", async () => {
	const { agents, root, jobs } = await core();
	const tool = dispatchExtension(agents, async () => "").tools?.find((each) => each.name === "dispatch") as
		| { execute(args: object, api: ToolExecutionApi, context: Context): Promise<{ output: unknown }> }
		| undefined;
	// One call's api: a rerun of the call after a crash gets the same memos back, over the same conversation.
	const memos = new Map<string, unknown>();
	const api = {
		conversationId: root.id,
		memo: async (name: string, candidate: unknown) => {
			if (!memos.has(name)) memos.set(name, candidate);
			return memos.get(name);
		},
		commit: <T>(change: (tx: Tx) => Promise<T>) => root.commit(change, context),
	} as unknown as ToolExecutionApi;
	const args = { card: "ticket-a", repo: "/soma", ticket: REQUEST };

	const first = await tool?.execute(args, api, context);
	const rerun = await tool?.execute(args, api, context);

	expect(rerun).toEqual(first);
	expect(JSON.parse((first?.output as { text: string }[] | undefined)?.[0]?.text ?? "")).toMatchObject({
		card: "ticket-a",
		ticket: REQUEST,
	});
	expect(agents.started).toHaveLength(1);
	expect(await jobs()).toHaveLength(1);
});

test("an empty ticket is refused before anything starts", async () => {
	const { agents, faux, root, reads, jobs } = await core();
	const results: string[] = [];
	const refused = (request: unknown) => {
		results.push(JSON.stringify((request as Request).messages.at(-1)?.content));
		return fauxAssistantMessage("ok");
	};
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("dispatch", { card: "ticket-a", repo: "/soma", ticket: "" })], {
			stopReason: "toolUse",
		}),
		refused,
		fauxAssistantMessage([fauxToolCall("dispatch", { card: "ticket-a", repo: "/soma", ticket: " \n " })], {
			stopReason: "toolUse",
		}),
		refused,
	]);
	for (const requestId of ["r1", "r2"]) {
		const submission = await root.submit({ type: "input", content: requestId, requestId }, context);
		expect((await submission.wait(context)).status).toBe("done");
	}

	expect(results).toHaveLength(2);
	for (const result of results) expect(result).toContain("ticket: expected to match");
	expect(agents.started).toEqual([]);
	expect(reads).toEqual([]);
	expect(await jobs()).toEqual([]);
});

test("a ticket job's launch rules speak of the job, not of a task card it does not have yet", () => {
	const brief = composeTicketPrompt(REQUEST);
	expect(brief).toContain("2. Never run /clear: it replaces the session id");
	expect(brief).not.toContain("任務卡");
	expect(composeLaunchPrompt("# card-b")).toContain("以下是任務卡：\n\n# card-b");
});
