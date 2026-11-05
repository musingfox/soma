import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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

/**
 * A HumanPort with Telegram as the default target, on a clock the test moves and a model answering `responses`;
 * `open` reopens it on the same store, as a restart does.
 */
async function holdingPort(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0] = []) {
	const faux = fauxProvider();
	faux.setResponses([...responses, ...Array.from({ length: 20 }, () => fauxAssistantMessage("好。"))]);
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
	const blocked = () =>
		root.commit(async (tx) => {
			(await tx.doc(Dispatches, root.id)).jobs = [
				{
					card: "a",
					agent: "a",
					sessionId: "s",
					status: { state: "blocked", kind: "permission", fingerprint: "fp", options: choices.options },
					decisions: [],
				},
			];
		}, context);
	return {
		root,
		open,
		notices,
		held,
		settle,
		blocked,
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
			{ [TELEGRAM]: "ring", [TERMINAL]: "log" },
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
		const { root, open, held, settle } = await holdingPort([boom]);
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
