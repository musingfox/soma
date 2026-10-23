import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { runReflectionSmoke } from "../smoke/reflection.ts";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { subjectOf } from "../src/core/domain/reflection.ts";
import { SIGNAL, turnSignal } from "../src/core/domain/signal.ts";
import { eventBridge } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { Curated, Facts, memory } from "../src/core/extensions/memory/index.ts";
import { REFLECTION, Reflections, reflection } from "../src/core/extensions/reflection/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";

const context = BACKGROUND_CONTEXT;
const PERIOD = 1_500;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const each of open.splice(0).reverse()) await each.close();
});

type Request = { messages: { role: string; content: unknown }[] };
const said = (message: { content: unknown } | undefined) => JSON.stringify(message?.content ?? "");

/**
 * A core with memory, dispatch and reflection over a FakeAgentPort, the event bridge and the human port. The faux
 * model answers a blocked agent with option 1 on the fingerprint the wake names, unless it answered that one before.
 * Asked to reflect, it revises memory line 1 citing every decision id the input lists and opens a card on the same
 * ids, then writes the three sections. With `failStart`, starting an agent fails as herdr would refuse it.
 */
async function core({ failStart = false } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "soma-reflection-"));
	const agents = new FakeAgentPort();
	if (failStart)
		agents.start = async () => {
			throw new Error("agent_name_taken");
		};
	const faux = fauxProvider();
	const answered = new Set<string>();
	faux.setResponses(
		Array.from({ length: 60 }, () => (request: Request) => {
			// The memory section rides along as a trailing system message.
			const last = request.messages.findLast((message) => message.role !== "system");
			const input = said(request.messages.findLast((message) => message.role === "user"));
			if (input.includes("[reflection ")) {
				if (last?.role === "toolResult") return fauxAssistantMessage("觀察：…\n證據 id：…\n改動：…");
				const evidence = [...new Set(input.match(/decision:card-a#\d+/g))].sort();
				return fauxAssistantMessage(
					[
						fauxToolCall("revise_memory", {
							line: 1,
							text: "權限提示先看指令；同一個提示代答後又卡住，就轉給人。",
							reason: "一律選 1 之後 agent 又卡在同一個提示",
							evidence,
						}),
						fauxToolCall("open_card", {
							card: "fix-reblock",
							title: "代答後又卡住時停止代答",
							body: "事件橋看到 reblock 就不再叫醒模型代答。",
							evidence,
						}),
					],
					{ stopReason: "toolUse" },
				);
			}
			if (last?.role === "toolResult") return fauxAssistantMessage("好。");
			const [, card = "", fingerprint = ""] = /卡片 ([a-z0-9-]+)）卡住了.*?fingerprint=([0-9a-z]+)/.exec(input) ?? [];
			if (card === "" || answered.has(fingerprint)) return fauxAssistantMessage("好。");
			answered.add(fingerprint);
			const call = fauxToolCall("respond", { card, option: "1", fingerprint, reason: "建空檔" });
			return fauxAssistantMessage([call], { stopReason: "toolUse" });
		}),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const cards = new Map<string, string>();
	const reflections = reflection({
		repo: "/soma",
		createCard: async (_repo, card, { body }) => {
			if (cards.has(card)) return false;
			cards.set(card, body);
			return true;
		},
		readCard: async (_repo, card) => cards.get(card) ?? "",
		agents,
	});
	const harness: Harness = await openHarness(
		join(directory, "soma.sqlite"),
		[memory, dispatchExtension(agents, async () => ""), reflections.extension],
		context,
		{ models },
	);
	open.push({ close: () => rm(directory, { recursive: true, force: true }) });
	open.push({ close: () => harness.close(context) });
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const human = await openHumanPort(harness, root, agents, context);
	open.push(human);
	const notices: string[] = [];
	human.subscribe((event) => {
		if (event.type === "notice" && event.kind !== "forwarded") notices.push(event.content);
	});
	const bridge = eventBridge(root, agents, context);
	const handled: Promise<void>[] = [];
	agents.onStatus((event) => handled.push(bridge.handle(event)));
	const settle = async () => {
		for (let seen = -1; seen !== handled.length; ) {
			seen = handled.length;
			await Promise.all(handled);
		}
		await root.waitForIdle(context);
	};
	const prompt = { state: "blocked", kind: "permission", msg: "Bash command\ntouch x\n1. Yes\n2. No" } as const;
	const checkpoint = async () => {
		const taskId = (await harness.snapshot(Reflections, root.id, context))?.taskId as TaskId;
		const state = (await harness.getTask(taskId, context))?.state as unknown as {
			checkpoint: { next: number; cursor: number };
		};
		return state.checkpoint;
	};
	return {
		agents,
		harness,
		root,
		cards,
		notices,
		calls: () => faux.state.callCount,
		start: () => reflections.startReflection(root, PERIOD, context),
		checkpoint,
		/** Answers a block on each fingerprint, then blocks again on the last one, which records a reblock. */
		async trajectory(fingerprints: readonly string[]) {
			for (const fingerprint of [...fingerprints, fingerprints.at(-1)]) {
				agents.emit("card-a", { ...prompt, fingerprint });
				await settle();
			}
		},
		async dispatched() {
			await root.commit(async (tx) => {
				(await tx.doc(Dispatches, root.id)).jobs.push({
					card: "card-a",
					agent: "card-a",
					sessionId: "s",
					status: { state: "working" },
					decisions: [],
				});
				const curated = await tx.doc(Curated);
				curated.lines.push({ id: 1, by: "user", text: "權限提示一律選 1。" });
				curated.next = 2;
			}, context);
		},
		reflections: async () =>
			(await root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter(
				(entry) => entry.kind === REFLECTION,
			),
		history: async () => (await harness.snapshot(Curated, context))?.history ?? [],
		/** The text of every result the tool returned, oldest first. */
		results: (tool: string) =>
			root
				.entries({ order: "ascending" }, 1000, undefined, context)
				.then(({ items }) =>
					items.flatMap((entry) =>
						(entry.model ?? []).flatMap((message) =>
							message.role === "toolResult" && message.toolName === tool
								? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
								: [],
						),
					),
				),
	};
}

async function until(check: () => boolean | Promise<boolean>, ms = 5 * PERIOD) {
	for (const deadline = Date.now() + ms; !(await check()); await delay(100)) expect(Date.now()).toBeLessThan(deadline);
}

test("three answers of one kind and a block again lead to a memory revision citing those three decisions", {
	timeout: 30_000,
}, async () => {
	const soma = await core();
	await soma.dispatched();
	await soma.trajectory(["f001", "f002", "f003"]);
	const signals = ((await soma.harness.snapshot(Facts, context))?.rows ?? []).filter((row) =>
		row.kind.startsWith("signal."),
	);
	expect(signals).toEqual([
		expect.objectContaining({ kind: SIGNAL.reblocked, refs: expect.objectContaining({ decision: 2 }) }),
	]);

	await soma.start();
	await until(() => soma.notices.some((notice) => notice.startsWith("觀察：")));

	const [revision] = await soma.history();
	expect(revision).toMatchObject({
		line: 1,
		action: "revise",
		evidence: ["decision:card-a#0", "decision:card-a#1", "decision:card-a#2"],
	});
	expect((await soma.harness.snapshot(Curated, context))?.lines).toEqual([
		expect.objectContaining({ id: 1, by: "model", text: expect.stringContaining("轉給人") }),
	]);
	expect(soma.notices).toEqual([
		expect.stringContaining("soma 修改了長期記憶 #1"),
		expect.stringMatching(/^soma 開了一張改程式碼的卡 fix-reblock：.*已派進 fleet（agent fix-reblock）/),
		"觀察：…\n證據 id：…\n改動：…",
	]);
	expect(soma.agents.started).toEqual([expect.objectContaining({ name: "fix-reblock", cwd: "/soma" })]);
	expect(soma.cards.get("fix-reblock")).toContain("decision:card-a#0、decision:card-a#1、decision:card-a#2");
});

test("a tick with no new signal calls no model and still moves its checkpoint on", { timeout: 30_000 }, async () => {
	const soma = await core();
	await soma.start();
	const first = (await soma.checkpoint()).next;

	await delay(2.5 * PERIOD);

	expect(soma.calls()).toBe(0);
	expect((await soma.checkpoint()).next).toBeGreaterThanOrEqual(first + 2 * PERIOD);
	expect(await soma.reflections()).toEqual([]);
	expect(soma.notices).toEqual([]);
});

test("the same problem the next day wakes no model and tells the human once that its handling may not have worked", {
	timeout: 30_000,
}, async () => {
	const soma = await core();
	await soma.dispatched();
	await soma.trajectory(["f001", "f002", "f003"]);
	await soma.start();
	await until(() => soma.notices.some((notice) => notice.startsWith("觀察：")));
	expect(await soma.reflections()).toHaveLength(1);
	const handled = soma.notices.length;

	// The next day: the agent is answered again and blocks on that prompt again, a new reblock on the same card.
	const nextDay = async (fingerprint: string) => {
		await soma.trajectory([fingerprint]);
		const facts = (await soma.harness.snapshot(Facts, context))?.rows ?? [];
		const calls = soma.calls();
		const next = (await soma.checkpoint()).next;
		await until(async () => (await soma.checkpoint()).next > next);
		expect(soma.calls()).toBe(calls);
		expect((await soma.checkpoint()).cursor).toBe(facts.length);
	};
	await nextDay("f004");

	expect(soma.notices.slice(handled)).toEqual([
		"卡片 card-a 的問題處理過之後又出現新的訊號，處理可能沒有奏效。" +
			`先前的處理：長期記憶 #1 在 ${new Date((await soma.history())[0]?.at ?? 0).toISOString()} 的修改、卡片 fix-reblock。` +
			"新訊號的證據：decision:card-a#3。soma 不會自動再修訂或開卡，請你看看。",
	]);
	expect(await soma.reflections()).toHaveLength(1);
	expect(await soma.history()).toHaveLength(1);
	expect([...soma.cards.keys()]).toEqual(["fix-reblock"]);

	// The day after: the same handling has been reported already, so nothing is said again.
	await nextDay("f005");
	expect(soma.notices).toHaveLength(handled + 1);
	expect(await soma.reflections()).toHaveLength(1);
});

test("a card whose dispatch fails stays todo, and both the model and the human are told", {
	timeout: 30_000,
}, async () => {
	const soma = await core({ failStart: true });
	await soma.dispatched();
	await soma.trajectory(["f001", "f002", "f003"]);
	await soma.start();
	await until(() => soma.notices.some((notice) => notice.startsWith("觀察：")));

	expect(soma.notices).toContainEqual(
		expect.stringMatching(/^soma 開了一張改程式碼的卡 fix-reblock：.*派進 fleet 失敗：agent_name_taken。卡片停在 todo/),
	);
	expect(await soma.results("open_card")).toEqual([expect.stringContaining("派進 fleet 失敗：agent_name_taken")]);
	expect([...soma.cards.keys()]).toEqual(["fix-reblock"]);
});

test("failed rounds are one problem per cause, whatever ids or times they carry", () => {
	const turn = (submission: number, reason: string) =>
		turnSignal({ submission, requestId: `terminal:${submission}`, reason }, submission);
	const subjects = [
		turn(1, "模型出錯：401 invalid x-api-key (request req_011CVa1b2c3d4e5f)"),
		turn(2, "模型出錯：401 invalid x-api-key (request req_011CVf9e8d7c6b5a)"),
		turn(3, "模型出錯：429 rate limited, retry after 1792387555558"),
		turn(4, "模型出錯：429 rate limited, retry after 1792387600000"),
		turn(5, "找不到模型"),
	].map(subjectOf);
	expect(new Set(subjects).size).toBe(3);
	expect(subjects[0]).toBe(subjects[1]);
	expect(subjects[2]).toBe(subjects[3]);
	expect(subjects[0]).not.toBe(subjects[2]);
});

test("SIGKILL while waiting and again during the reflection's run keeps it on time and runs it once", {
	timeout: 60_000,
}, async () => {
	await runReflectionSmoke(4_000);
});
