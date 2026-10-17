import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { fauxModels } from "../smoke/faux.ts";
import { runScheduleSmoke } from "../smoke/schedule.ts";
import { Schedules, schedule } from "../src/core/extensions/schedule/index.ts";
import { openHarness } from "../src/core/harness.ts";

const context = BACKGROUND_CONTEXT;

test("a scheduled reminder survives SIGKILL and reaches the root conversation once, on time", {
	timeout: 30_000,
}, async () => {
	const report = await runScheduleSmoke(4_000, 1_500, "提醒我 喝水");
	expect(report.firedAt).toBeGreaterThanOrEqual(report.at);
	expect(report.reply).toBe("提醒你：喝水");
});

test("cancel stops only the named reminder, which never fires, while the other still does", {
	timeout: 30_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "soma-schedule-cancel-"));
	const { models, model } = fauxModels("PT2S");
	const harness: Harness = await openHarness(
		join(directory, "soma.sqlite"),
		[schedule((id, c) => harness.abortTask(id, c))],
		context,
		{ models },
	);
	try {
		const root = await harness.root(context, { agent: { model } });
		harness.resume();
		const say = async (content: string) => {
			await (await root.submit({ type: "input", content }, context)).wait(context);
			const [answer] = (await root.entries({}, 1, undefined, context)).items;
			const parts = answer?.model?.[0]?.content;
			return Array.isArray(parts) ? parts.map((part) => ("text" in part ? part.text : "")).join("") : "";
		};

		await say("提醒我 開會");
		await say("提醒我 喝水");
		const scheduled = (await harness.snapshot(Schedules, root.id, context))?.items ?? {};
		const [meeting, water] = Object.keys(scheduled);
		expect(Object.values(scheduled).map((item) => item.instruction)).toEqual(["開會", "喝水"]);
		expect(await say("列出排程")).toMatch(new RegExp(`${meeting}: .* 開會\n${water}: .* 喝水`));
		expect(await say(`取消排程 ${meeting}`)).toBe(`好。Cancelled ${meeting}.`);
		expect(await say("列出排程")).toMatch(new RegExp(`^好。${water}: .* 喝水$`));

		const task = await harness.getTask(Number(meeting) as TaskId, context);
		expect(task?.state).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
		await harness.waitForTask(Number(water) as TaskId, context);
		await root.waitForIdle(context);
		await new Promise((resolve) => setTimeout(resolve, 500));
		const { items } = await root.entries({ order: "ascending" }, 1000, undefined, context);
		const fired = items.filter((entry) => entry.kind === "schedule").map((entry) => entry.model?.[0]?.content);
		expect(fired).toEqual([`[schedule ${water}] 喝水`]);
		expect(await say("列出排程")).toBe("好。Nothing scheduled.");
	} finally {
		await harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});
