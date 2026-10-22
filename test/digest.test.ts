import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { runDigestSmoke } from "../smoke/digest.ts";
import { digestModels } from "../smoke/digest-faux.ts";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { DIGEST, Digests, digest, NOTICE } from "../src/core/extensions/digest/index.ts";
import { eventBridge } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";

const context = BACKGROUND_CONTEXT;
const PERIOD = 1_500;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("two jobs finishing in one period make one report and one model call; a quiet period makes none", {
	timeout: 30_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "soma-digest-"));
	const agents = new FakeAgentPort();
	const { models, model, calls } = digestModels();
	const { extension, startDigest } = digest(agents);
	const harness: Harness = await openHarness(
		join(directory, "soma.sqlite"),
		[dispatchExtension(agents, async () => ""), extension],
		context,
		{ models },
	);
	try {
		const root = await harness.root(context, { agent: { model } });
		harness.resume();
		await root.commit(async (tx) => {
			(await tx.doc(Dispatches, root.id)).jobs = ["a", "b"].map((card) => ({
				card,
				agent: card,
				sessionId: card,
				status: { state: "working" },
				decisions: [],
			}));
		}, context);
		const errors: unknown[] = [];
		eventBridge(root, agents, context).listen((error) => errors.push(error));
		const human = await openHumanPort(harness, root, agents, context);
		const notices: string[] = [];
		human.subscribe((event) => {
			if (event.type === "notice" && event.kind === "report") notices.push(event.content);
		});
		await startDigest(root, PERIOD, context);
		await startDigest(root, PERIOD, context);

		agents.finish("a", "結果：完成\n三項都過。");
		agents.finish("b", "做完了，但沒寫結果行。");
		for (const deadline = Date.now() + 5 * PERIOD; notices.length === 0; await delay(100)) {
			expect(Date.now()).toBeLessThan(deadline);
		}
		expect(errors).toEqual([]);
		expect(calls()).toBe(1);
		expect(notices).toEqual(["報告：a 完成；b 未知"]);

		const taskId = (await harness.snapshot(Digests, root.id, context))?.taskId as TaskId;
		const nextTick = async () =>
			((await harness.getTask(taskId, context))?.state as { checkpoint?: { next: number } } | undefined)?.checkpoint
				?.next ?? 0;
		const before = await nextTick();
		await delay(2.5 * PERIOD);
		expect(calls()).toBe(1);
		expect(notices).toHaveLength(1);
		expect(await nextTick()).toBeGreaterThanOrEqual(before + 2 * PERIOD);
		const { items } = await root.entries({ order: "ascending" }, 1000, undefined, context);
		expect(items.filter((entry) => entry.kind === DIGEST)).toHaveLength(1);
		await human.close();
	} finally {
		await harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("a report the model fails to write still reaches the human, as the raw job list", {
	timeout: 30_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "soma-digest-"));
	const agents = new FakeAgentPort();
	const { models, model } = digestModels(true);
	const { extension, startDigest } = digest(agents);
	const harness: Harness = await openHarness(
		join(directory, "soma.sqlite"),
		[dispatchExtension(agents, async () => ""), extension],
		context,
		{ models },
	);
	try {
		const root = await harness.root(context, { agent: { model } });
		harness.resume();
		await root.commit(async (tx) => {
			(await tx.doc(Dispatches, root.id)).jobs = [
				{ card: "a", agent: "a", sessionId: "a", status: { state: "working" }, decisions: [] },
			];
		}, context);
		eventBridge(root, agents, context).listen(() => {});
		await startDigest(root, PERIOD, context);
		agents.finish("a", "結果：完成");
		const notices = async () =>
			(await root.entries({ order: "ascending" }, 1000, undefined, context)).items.flatMap((entry) =>
				entry.kind === NOTICE ? [(entry.data as { content: string }).content] : [],
			);
		for (const deadline = Date.now() + 5 * PERIOD; (await notices()).length === 0; await delay(100)) {
			expect(Date.now()).toBeLessThan(deadline);
		}
		const [notice] = await notices();
		expect(notice).toMatch(/^模型沒有寫出報告（.+）。\n\[digest /);
		expect(notice).toContain("- 卡片 a（agent a）結果：完成");
	} finally {
		await harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("SIGKILL while waiting and again during the report's run neither drops nor repeats a report", {
	timeout: 60_000,
}, async () => {
	await runDigestSmoke(4_000);
});
