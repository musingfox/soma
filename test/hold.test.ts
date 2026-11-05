import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { type Policies, PRESETS } from "../src/core/domain/push.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { Holds } from "../src/core/hold.ts";
import { openHumanPort, Pushes } from "../src/core/human-port.ts";
import { noticeEntry } from "../src/core/notice.ts";
import type { AgentState } from "../src/ports/agent.ts";
import type { SomaEvent } from "../src/ports/human.ts";

const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

const MIN = 60_000;
const TELEGRAM = "chat.telegram";
const TERMINAL = "chat.terminal";
const SUMMARY = { [TELEGRAM]: PRESETS.summary, [TERMINAL]: PRESETS.instant };
const choices = { card: "a", fingerprint: "fp", options: [{ id: "1", label: "Yes" }] };

const boom = () => {
	throw new Error("401 invalid x-api-key");
};

type Model = (prompt: string) => AssistantMessage | Promise<AssistantMessage>;
const writes: Model = (prompt) =>
	fauxAssistantMessage(prompt.startsWith("[summary]") ? "摘要：三件事和一個問題。" : "好。");

/**
 * A HumanPort with Telegram as the default target, on a clock the test moves and a model answering each input's text
 * with `model`, every text kept in `prompts`; `open` reopens it on the same store, as a restart does.
 */
async function holdingPort(model: Model = writes) {
	const faux = fauxProvider();
	const prompts: string[] = [];
	faux.setResponses(
		Array.from({ length: 50 }, () => (transcript: { messages: { role: string; content: unknown }[] }) => {
			const last = transcript.messages.findLast((message) => message.role === "user")?.content;
			const prompt =
				typeof last === "string"
					? last
					: ((last as { type: string; text?: string }[] | undefined) ?? []).map((part) => part.text ?? "").join("");
			prompts.push(prompt);
			return model(prompt);
		}),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(dispatchExtension(new FakeAgentPort(), async (_repo, card) => `# ${card}`));
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { models, registry }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	let clock = 100 * MIN;
	// The human typed on the terminal just now, so nothing is summarized before the clock moves.
	await root.commit(async (tx) => {
		(await tx.doc(Pushes, root.id)).presence[TERMINAL] = clock;
	}, context);
	const open = async (policies: Policies = SUMMARY) => {
		const human = await openHumanPort(harness, root, new FakeAgentPort(), context, {
			defaultTarget: TELEGRAM,
			policies,
			now: () => clock,
			checkMs: 10,
			storage,
		});
		cleanup.push(() => human.close());
		const seen: SomaEvent[] = [];
		human.subscribe((event) => seen.push(event));
		return { human, seen };
	};
	const notices = (seen: SomaEvent[]) =>
		seen.flatMap((event) => (event.type === "notice" && event.kind !== "forwarded" ? [event] : []));
	const held = () =>
		root.commit(async (tx) => JSON.parse(JSON.stringify((await tx.doc(Holds, root.id)).held)), context);
	const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
	const job = (status: AgentState) =>
		root.commit(async (tx) => {
			(await tx.doc(Dispatches, root.id)).jobs = [{ card: "a", agent: "a", sessionId: "s", status, decisions: [] }];
		}, context);
	return {
		root,
		prompts,
		job,
		open,
		notices,
		held,
		settle,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

describe("holding", () => {
	test("Telegram at summary holds every class while the terminal beside it pushes as before", async () => {
		const { root, open, notices, held } = await holdingPort();
		const { human, seen } = await open();
		await human.submit({ content: "嗨", entry: { kind: TERMINAL }, requestId: "terminal:1" });
		await root.waitForIdle(context);
		await root.submit(
			{
				type: "write",
				entry: noticeEntry("question", "action", "trust it?", choices, {
					id: "pane-1",
					told: { fingerprint: "fp", msg: "approve" },
				}),
			},
			context,
		);
		await human.notify("card b 完成", "report", "outcome");
		await human.notify("記下了", "report", "ambient");

		await vi.waitFor(() => expect(notices(seen)).toHaveLength(3));
		expect(notices(seen).map((notice) => notice.delivery)).toEqual([
			{ [TELEGRAM]: "log", [TERMINAL]: "ring" },
			{ [TELEGRAM]: "log", [TERMINAL]: "ring" },
			{ [TELEGRAM]: "log", [TERMINAL]: "ring" },
		]);
		await vi.waitFor(async () => expect(await held()).toHaveLength(3));
		expect(await held()).toEqual([
			{
				key: expect.stringMatching(/^notice:\d+$/),
				at: 100 * MIN,
				kind: "question",
				class: "action",
				content: "trust it?",
				choices,
				foreign: { id: "pane-1", told: { fingerprint: "fp", msg: "approve" } },
				to: [TELEGRAM],
			},
			{
				key: expect.any(String),
				at: 100 * MIN,
				kind: "report",
				class: "outcome",
				content: "card b 完成",
				to: [TELEGRAM],
			},
			{ key: expect.any(String), at: 100 * MIN, kind: "report", class: "ambient", content: "記下了", to: [TELEGRAM] },
		]);
	});

	test("a custom table holds only the classes it sets to hold; nothing is held with no interface at hold", async () => {
		const { open, notices, held, settle } = await holdingPort();
		const custom = { action: "ring", outcome: "hold", ambient: "log" } as const;
		const first = await open({ [TELEGRAM]: custom, [TERMINAL]: PRESETS.summary });
		await first.human.notify("which one?", "question", "action");
		await first.human.notify("card b 完成", "report", "outcome");
		await vi.waitFor(() => expect(notices(first.seen)).toHaveLength(2));
		await vi.waitFor(async () => expect(await held()).toHaveLength(2));
		expect((await held()).map((push: { content: string; to: string[] }) => [push.content, push.to])).toEqual([
			["which one?", [TERMINAL]],
			["card b 完成", [TELEGRAM, TERMINAL]],
		]);
		expect(notices(first.seen).map((notice) => notice.delivery)).toEqual([
			// The terminal, typed on last, is the target and holds it: nobody rings.
			{ [TELEGRAM]: "quiet", [TERMINAL]: "log" },
			{ [TELEGRAM]: "log", [TERMINAL]: "log" },
		]);
		await first.human.close();

		const second = await open({ [TELEGRAM]: PRESETS.ask, [TERMINAL]: PRESETS.instant });
		await second.human.notify("card c 完成", "report", "outcome");
		await vi.waitFor(() => expect(notices(second.seen)).toHaveLength(1));
		await settle();
		expect(await held()).toHaveLength(2);
	});

	test("a notice a crash left unheld is held at the next start, and nothing held is held twice", async () => {
		const { root, open, held, settle } = await holdingPort();
		const first = await open();
		await first.human.notify("before the crash", "report", "outcome");
		await vi.waitFor(async () => expect(await held()).toHaveLength(1));
		await first.human.close();
		// Committed while nothing handled it, as when soma dies between the notice's commit and its handling.
		await root.commit(async (tx) => {
			await tx.appendEntry(root.id, noticeEntry("report", "outcome", "in the crash"));
		}, context);

		for (const _restart of [1, 2]) {
			const again = await open();
			await settle();
			await again.human.close();
		}
		expect((await held()).map((push: { content: string }) => push.content)).toEqual([
			"before the crash",
			"in the crash",
		]);
	});

	test("a pushed round's failure a crash left unheld is held at the next start, once", async () => {
		const { root, open, held, settle } = await holdingPort(boom);
		const first = await open();
		await settle();
		await first.human.close();
		// A round the core started fails while nothing handles it.
		const round = await root.submit(
			{ type: "input", content: "wake", entry: { kind: "test" }, requestId: "agent:a:1" },
			context,
		);
		expect((await round.wait(context)).status).toBe("unanswered");

		for (const _restart of [1, 2]) {
			const again = await open();
			await settle();
			await again.human.close();
		}
		expect(await held()).toEqual([
			{
				key: `failure:${round.id}`,
				at: 100 * MIN,
				kind: "report",
				class: "outcome",
				content: expect.stringMatching(/^agent:a:1 那一輪失敗：模型出錯：401 invalid x-api-key/),
				to: [TELEGRAM],
			},
		]);
	});

	test("a doc that never held starts from now: nothing before the first start with hold is held", async () => {
		const { root, open, held, settle } = await holdingPort();
		await root.commit(async (tx) => {
			await tx.appendEntry(root.id, noticeEntry("report", "outcome", "long ago"));
		}, context);
		await open();
		await settle();
		expect(await held()).toEqual([]);
	});

	test("a start with nothing at hold forgets where holding was, so a later one holds nothing from between", async () => {
		const { root, open, held, settle } = await holdingPort();
		const first = await open();
		await settle();
		await first.human.close();
		const instant = await open({ [TELEGRAM]: PRESETS.instant });
		await instant.human.notify("shown at once", "report", "outcome");
		await settle();
		await instant.human.close();
		await root.commit(async (tx) => {
			await tx.appendEntry(root.id, noticeEntry("report", "outcome", "after the instant run"));
		}, context);

		await open();
		await settle();
		expect(await held()).toEqual([]);
	});

	test("a question Telegram holds never escalates, though the human typed on the terminal and left", async () => {
		const { root, open, notices, settle, advance } = await holdingPort();
		const { human, seen } = await open();
		await human.submit({ content: "嗨", entry: { kind: TERMINAL }, requestId: "terminal:1" });
		await root.waitForIdle(context);
		await human.notify("which one?", "question", "action");
		await vi.waitFor(() => expect(notices(seen)).toHaveLength(1));
		expect(await root.commit(async (tx) => (await tx.doc(Pushes, root.id)).pending.length, context)).toBe(0);
		advance(16 * MIN);
		await settle();
		expect(notices(seen).filter((notice) => notice.delivery?.[TELEGRAM] === "ring")).toEqual([]);
	});
});

const blocked: AgentState = { state: "blocked", kind: "permission", fingerprint: "fp", options: choices.options };

describe("summary", () => {
	/** Three results and one question, held for Telegram while the human was last on the terminal. */
	async function heldFour(port: Awaited<ReturnType<typeof holdingPort>>) {
		const { root, open, job, held } = port;
		await job(blocked);
		const opened = await open();
		await opened.human.notify("card b 完成", "report", "outcome");
		await root.submit({ type: "write", entry: noticeEntry("question", "action", "要讓 a 執行嗎？", choices) }, context);
		await opened.human.notify("card c 失敗", "report", "outcome");
		await opened.human.notify("記下了", "report", "ambient");
		await vi.waitFor(async () => expect(await held()).toHaveLength(4));
		return opened;
	}
	const summariesOf = (events: SomaEvent[]) =>
		events.flatMap((event) =>
			event.type === "notice" && event.kind === "report" && event.content.startsWith("摘要") ? [event] : [],
		);

	test("after the idle time with no input, one summary rings on Telegram alone, then the question with its buttons, silent", async () => {
		const port = await holdingPort();
		const { advance, notices, held, prompts, settle } = port;
		const { seen } = await heldFour(port);
		const before = notices(seen).length;

		advance(29 * MIN);
		await settle();
		expect(notices(seen)).toHaveLength(before);
		advance(MIN);
		await vi.waitFor(() => expect(notices(seen)).toHaveLength(before + 2));
		await settle();
		expect(notices(seen).slice(before)).toEqual([
			{
				type: "notice",
				kind: "report",
				class: "action",
				content: "摘要：三件事和一個問題。",
				delivery: { [TELEGRAM]: "ring", [TERMINAL]: "log" },
			},
			{
				type: "notice",
				kind: "question",
				class: "action",
				content: "要讓 a 執行嗎？",
				choices,
				delivery: { [TELEGRAM]: "quiet", [TERMINAL]: "log" },
			},
		]);
		expect(await held()).toEqual([]);
		const prompt = prompts.find((each) => each.startsWith("[summary]")) ?? "";
		expect(prompt.indexOf("要讓 a 執行嗎？")).toBeLessThan(prompt.indexOf("card b 完成"));
		for (const content of ["card b 完成", "card c 失敗", "記下了"]) expect(prompt).toContain(content);
	});

	test("input on any interface restarts the wait; a button press does not count", async () => {
		const port = await holdingPort();
		const { root, advance, notices, settle } = port;
		const { human, seen } = await heldFour(port);
		const before = notices(seen).length;

		advance(20 * MIN);
		await human.submit({ content: "等等", entry: { kind: TELEGRAM }, requestId: "telegram:1" });
		await root.waitForIdle(context);
		advance(20 * MIN);
		await human.respond("a", { option: "1", fingerprint: "fp" });
		advance(9 * MIN);
		await settle();
		expect(notices(seen)).toHaveLength(before);
		advance(MIN);
		await vi.waitFor(() => expect(summariesOf(seen)).toHaveLength(1));
	});

	test("a summary rings once per idle stretch: the next one in the same stretch is silent, and rings after input", async () => {
		const port = await holdingPort();
		const { root, advance, settle } = port;
		const { human, seen } = await heldFour(port);
		advance(30 * MIN);
		await vi.waitFor(() => expect(summariesOf(seen)).toHaveLength(1));

		await human.notify("card d 完成", "report", "outcome");
		await vi.waitFor(() => expect(summariesOf(seen)).toHaveLength(2));
		advance(MIN);
		await human.submit({ content: "回來了", entry: { kind: TERMINAL }, requestId: "terminal:9" });
		await root.waitForIdle(context);
		await human.notify("card e 完成", "report", "outcome");
		advance(29 * MIN);
		await settle();
		expect(summariesOf(seen)).toHaveLength(2);
		advance(MIN);
		await vi.waitFor(() => expect(summariesOf(seen)).toHaveLength(3));
		expect(summariesOf(seen).map((summary) => summary.delivery?.[TELEGRAM])).toEqual(["ring", "quiet", "ring"]);
	});

	test("a held question whose prompt is gone is dropped from the summary; every held report is kept", async () => {
		const port = await holdingPort();
		const { root, advance, job, notices, held, prompts, settle } = port;
		const { seen } = await heldFour(port);
		await root.submit(
			{
				type: "write",
				entry: noticeEntry("question", "action", "foreign prompt", undefined, {
					id: "pane-1",
					told: { fingerprint: "fp9", msg: "approve" },
				}),
			},
			context,
		);
		await vi.waitFor(async () => expect(await held()).toHaveLength(5));
		await job({ state: "working" });
		const before = notices(seen).length;

		advance(30 * MIN);
		await vi.waitFor(() => expect(summariesOf(seen)).toHaveLength(1));
		await settle();
		expect(
			notices(seen)
				.slice(before)
				.map((notice) => notice.kind),
		).toEqual(["report"]);
		const prompt = prompts.find((each) => each.startsWith("[summary]")) ?? "";
		expect(prompt).not.toContain("要讓 a 執行嗎？");
		expect(prompt).not.toContain("foreign prompt");
		for (const content of ["card b 完成", "card c 失敗", "記下了"]) expect(prompt).toContain(content);
		expect(await held()).toEqual([]);
	});

	test("nothing is summarized when every held push is a question whose prompt is gone", async () => {
		const { root, open, advance, job, held, notices, prompts, settle } = await holdingPort();
		await job(blocked);
		const { seen } = await open();
		await root.submit({ type: "write", entry: noticeEntry("question", "action", "要讓 a 執行嗎？", choices) }, context);
		await vi.waitFor(async () => expect(await held()).toHaveLength(1));
		await job({ state: "idle" });
		advance(30 * MIN);
		await vi.waitFor(async () => expect(await held()).toEqual([]));
		await settle();
		expect(notices(seen)).toHaveLength(1);
		expect(prompts.filter((each) => each.startsWith("[summary]"))).toEqual([]);
	});

	test("a failed round keeps what it covers held, pushes nothing, and the next check tries again", async () => {
		let fail = true;
		const port = await holdingPort((prompt) => {
			if (prompt.startsWith("[summary]") && fail) throw new Error("401 invalid x-api-key");
			return writes(prompt);
		});
		const { root, advance, held, notices, prompts } = port;
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		cleanup.push(async () => errors.mockRestore());
		const { seen } = await heldFour(port);
		const before = notices(seen).length;

		advance(30 * MIN);
		await vi.waitFor(() =>
			expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^\[soma\] summary summary:1 failed/)),
		);
		expect(await held()).toHaveLength(4);
		expect(await root.commit(async (tx) => (await tx.doc(Holds, root.id)).round, context)).toBeUndefined();
		expect(notices(seen)).toHaveLength(before);
		expect(seen.filter((event) => event.type === "failure" && event.class !== undefined)).toEqual([]);

		fail = false;
		await vi.waitFor(() => expect(summariesOf(seen)).toHaveLength(1));
		expect(await held()).toEqual([]);
		expect(prompts.filter((each) => each.startsWith("[summary]")).length).toBeGreaterThanOrEqual(2);
	});

	test("what is held when the round begins is covered; what comes in while it runs waits for the next", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const port = await holdingPort(async (prompt) => {
			if (prompt.startsWith("[summary]")) await gate;
			return writes(prompt);
		});
		const { root, advance, held, prompts } = port;
		const { human, seen } = await heldFour(port);
		advance(30 * MIN);
		await vi.waitFor(async () =>
			expect(await root.commit(async (tx) => (await tx.doc(Holds, root.id)).round, context)).toBeDefined(),
		);
		await human.notify("card f 完成", "report", "outcome");
		await vi.waitFor(async () => expect(await held()).toHaveLength(5));
		release();
		// Still idle, so the next check summarizes what waited, without a sound.
		await vi.waitFor(() => expect(summariesOf(seen)).toHaveLength(2));
		const [first, next] = prompts.filter((each) => each.startsWith("[summary]"));
		expect(first).toContain("card b 完成");
		expect(first).not.toContain("card f 完成");
		expect(next).toContain("card f 完成");
		expect(next).not.toContain("card b 完成");
		expect(summariesOf(seen).map((summary) => summary.delivery?.[TELEGRAM])).toEqual(["ring", "quiet"]);
	});

	test("a core restarted while pushes are held, twice, sends the summary once", async () => {
		const port = await holdingPort();
		const { open, advance, held, settle } = port;
		const first = await heldFour(port);
		await first.human.close();
		advance(30 * MIN);

		const second = await open();
		await vi.waitFor(() => expect(summariesOf(second.seen)).toHaveLength(1));
		await settle();
		await second.human.close();
		const third = await open();
		await settle();
		expect(summariesOf(third.seen)).toEqual([]);
		expect(await held()).toEqual([]);
	});

	test("a summary cut short by a restart is finished by the next start, once", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const port = await holdingPort(async (prompt) => {
			if (prompt.startsWith("[summary]")) await gate;
			return writes(prompt);
		});
		const { root, open, advance, settle, prompts } = port;
		const first = await heldFour(port);
		advance(30 * MIN);
		await vi.waitFor(async () =>
			expect(await root.commit(async (tx) => (await tx.doc(Holds, root.id)).round, context)).toBeDefined(),
		);
		await first.human.close();
		const second = await open();
		release();

		await vi.waitFor(() => expect(summariesOf(second.seen)).toHaveLength(1));
		await settle();
		expect(summariesOf(second.seen)).toHaveLength(1);
		expect(prompts.filter((each) => each.startsWith("[summary]"))).toHaveLength(1);
	});

	test("with no interface at hold, nothing is held and no summary runs", async () => {
		const { open, advance, notices, held, prompts, settle } = await holdingPort();
		const { human, seen } = await open({ [TELEGRAM]: PRESETS.instant, [TERMINAL]: PRESETS.instant });
		await human.notify("card b 完成", "report", "outcome");
		advance(60 * MIN);
		await settle();
		expect(notices(seen)).toHaveLength(1);
		expect(await held()).toEqual([]);
		expect(prompts).toEqual([]);
	});
});
