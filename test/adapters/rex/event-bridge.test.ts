import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, test } from "vitest";
import { createRexAgentPort } from "../../../src/adapters/rex/agent-port.ts";
import { eventBridge, JOB_DONE } from "../../../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../../../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../../../src/core/harness.ts";
import { NOTICE } from "../../../src/core/notice.ts";
import type { AgentStatusEvent } from "../../../src/ports/agent.ts";
import { type Block, git, HANGAR, rex } from "./fake.ts";

const context = BACKGROUND_CONTEXT;
const open: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function until(ok: () => boolean, ms = 2_000): Promise<void> {
	for (const deadline = Date.now() + ms; !ok(); await new Promise((resolve) => setTimeout(resolve, 5))) {
		if (Date.now() > deadline) throw new Error("timed out");
	}
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The real core over the rex adapter on the in-memory rex, with card-a dispatched and idle. `report` records a status
 * for the block and resolves once the bridge has handled it; `write` appends records to claude's transcript; `events`
 * counts the statuses the adapter emitted.
 */
async function dispatched({ replyMs = REPLY_MS, recheckMs }: { replyMs?: number; recheckMs?: number } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "soma-rex-bridge-"));
	directories.push(directory);
	const projects = join(directory, "projects");
	const blocks: Block[] = [];
	const fake = rex(blocks);
	// The window start() opens becomes a block of the in-memory rex, labelled with the session id it was started with.
	const original = fake.client.call.bind(fake.client);
	fake.client.call = async (method, payload, schema) => {
		if (method === "session.new_window") {
			const { window_label, layout } = payload as {
				window_label: string;
				layout: { block: { label: string; options: { cwd: string } } };
			};
			const { label, options } = layout.block;
			blocks.push({ name: window_label, block: "block:a", label, argv0: "claude", cwd: options.cwd, records: [] });
		}
		return original(method, payload, schema);
	};
	const agents = createRexAgentPort({
		client: fake.client,
		sessionId: HANGAR,
		git: git().git,
		projectsDir: projects,
		processStart: async () => undefined,
		confirmMs: 10,
		replyMs,
		redrawMs: 10,
		...(recheckMs === undefined ? {} : { recheckMs }),
	});

	const faux = fauxProvider();
	faux.setResponses([
		() =>
			fauxAssistantMessage([fauxToolCall("dispatch", { card: "card-a", repo: "/repo" })], { stopReason: "toolUse" }),
		...Array.from({ length: 10 }, () => () => fauxAssistantMessage("好。")),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await openHarness(
		join(directory, "soma.sqlite"),
		[dispatchExtension(agents, async (_repo, card) => `# ${card}`)],
		context,
		{ models },
	);
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const bridge = eventBridge(root, agents, context);
	const handled: Promise<void>[] = [];
	const off = agents.onStatus((event) => handled.push(bridge.handle(event)));
	const job = async () =>
		(await harness.snapshot(Dispatches, root.id, context))?.jobs.find((each) => each.agent === "card-a");
	const entries = async (kind: string) =>
		(await root.entries({}, 1000, undefined, context)).items.filter((e) => e.kind === kind);
	const done = () => entries(JOB_DONE);
	const questions = async () =>
		(await entries(NOTICE)).filter((e) => (e.data as { kind?: string } | undefined)?.kind === "question");

	const submission = await root.submit({ type: "input", content: "派 card-a", requestId: "t:card-a" }, context);
	expect((await submission.wait(context)).status).toBe("done");
	const [block] = blocks as [Block];
	const report = async (record: { state: string; updated_at: string }) => {
		const count = handled.length;
		block.records = [record];
		fake.emit(fake.status(block.block, record));
		await until(() => handled.length > count);
		await Promise.all(handled);
	};
	const path = join(projects, (block.cwd as string).replace(/[^a-zA-Z0-9]/g, "-"), `${block.label}.jsonl`);
	mkdirSync(join(path, ".."), { recursive: true });
	const write = (...records: object[]) =>
		writeFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""), { flag: "a" });
	const close = async () => {
		off();
		await root.waitForIdle(context);
	};
	const settled = async () => {
		await Promise.all(handled);
		await root.waitForIdle(context);
	};
	return { agents, block, report, write, job, done, questions, events: () => handled.length, settled, close };
}

const REPLY_MS = 300;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const user = (uuid: string, content: unknown) => ({ type: "user", uuid, message: { role: "user", content } });
const reply = (uuid: string, text: string) => ({
	type: "assistant",
	uuid,
	message: { id: `msg-${uuid}`, content: [{ type: "text", text }] },
});

test("a re-stamped done after a 需要你 turn records no second turn and keeps the outcome", async () => {
	const { report, write, job, done, close } = await dispatched();

	await report({ state: "idle", updated_at: ago(3_000) });
	await report({ state: "working", updated_at: ago(2_000) });
	write(user("u-1", "go"), reply("a-1", "結果：需要你\nwhich branch?"));
	await report({ state: "done", updated_at: ago(1_000) });
	expect(await job()).toMatchObject({ status: { state: "done" }, outcome: "需要你", resultId: "a-1" });
	expect(await done()).toHaveLength(1);

	// rex re-stamps the done a minute after claude last wrote the transcript, with no turn in between.
	await report({ state: "done", updated_at: later(59_000) });

	expect(await job()).toMatchObject({ outcome: "需要你", resultId: "a-1" });
	expect(await done()).toHaveLength(1);
	await close();
});

test("a turn that ends on the user is recorded once as 未知, and its re-stamps record nothing at once", async () => {
	const { report, write, job, done, close } = await dispatched();
	await report({ state: "idle", updated_at: ago(3_000) });
	await report({ state: "working", updated_at: ago(2_000) });
	write(user("u-1", "go"), reply("a-1", "結果：需要你\nwhich branch?"));
	await report({ state: "done", updated_at: ago(1_000) });

	// A second turn the human interrupts: the transcript ends on the user, and no reply is ever written.
	await report({ state: "working", updated_at: ago(800) });
	write(user("u-2", "go2"), user("u-stop", [{ type: "text", text: "[Request interrupted by user]" }]));
	await report({ state: "idle", updated_at: ago(500) });
	expect(await job()).toMatchObject({ status: { state: "idle" }, outcome: "未知", resultId: "u-stop" });
	expect(await done()).toHaveLength(2);

	// rex re-stamps the idle twice, with no working in between: nothing is waited for, since no turn ended.
	for (const ahead of [59_000, 119_000]) {
		const reported = Date.now();
		await report({ state: "idle", updated_at: later(ahead) });
		expect(Date.now() - reported).toBeLessThan(REPLY_MS);
		expect(await job()).toMatchObject({ outcome: "未知", resultId: "u-stop" });
		expect(await done()).toHaveLength(2);
	}
	await close();
});

test.each([
	[
		"an interrupted turn is recorded once as 未知, and re-stamps add nothing",
		[user("u-2", "go2"), user("u-stop", [{ type: "text", text: "[Request interrupted by user]" }])],
		"idle",
		{ outcome: "未知", resultId: "u-stop" },
	],
	[
		"a turn ending on a 需要你 reply is recorded once as 需要你, not 未知 first",
		[user("u-2", "go2"), reply("a-2", "結果：需要你\nwhich?")],
		"done",
		{ outcome: "需要你", resultId: "a-2" },
	],
] as const)("a turn written just before rex stamped its end: %s", async (_turn, records, state, recorded) => {
	const { report, write, job, done, close } = await dispatched();
	await report({ state: "idle", updated_at: ago(3_000) });
	await report({ state: "working", updated_at: ago(2_000) });
	write(user("u-1", "go"), reply("a-1", "結果：完成"));
	await report({ state: "done", updated_at: ago(1_000) });
	await report({ state: "working", updated_at: ago(800) });
	write(...records);

	// claude wrote its last record, then rex stamped the end 30 ms later; nothing is written after.
	await report({ state, updated_at: later(30) });
	expect(await job()).toMatchObject(recorded);
	expect(await done()).toHaveLength(2);

	for (const ahead of [59_000, 119_000]) {
		await report({ state, updated_at: later(ahead) });
		expect(await job()).toMatchObject(recorded);
		expect(await done()).toHaveLength(2);
	}
	await close();
});

describe("a read replyMs cut short is checked again recheckMs later", () => {
	const RECHECK_MS = 400;
	/** A turn of card-a whose end rex stamps now and whose prompt claude wrote, but not its reply, within replyMs. */
	async function cutShort() {
		const bridge = await dispatched({ replyMs: 100, recheckMs: RECHECK_MS });
		await bridge.report({ state: "idle", updated_at: ago(3_000) });
		await bridge.report({ state: "working", updated_at: ago(2_000) });
		bridge.write(user("u-1", "go"));
		await bridge.report({ state: "done", updated_at: later(20) });
		expect(await bridge.job()).toMatchObject({ status: { state: "done" }, outcome: "未知", resultId: "u-1" });
		expect(await bridge.done()).toHaveLength(1);
		return bridge;
	}

	test("a reply written after the timeout is recorded once at the re-check, with its notice", async () => {
		const { write, job, done, questions, events, settled, close } = await cutShort();
		expect(await questions()).toHaveLength(0);
		const before = events();
		write(reply("a-1", "結果：需要你\nwhich branch?"));

		await until(() => events() > before, RECHECK_MS * 3);
		await settled();
		expect(await job()).toMatchObject({ status: { state: "done" }, outcome: "需要你", resultId: "a-1" });
		// Newest first.
		expect((await done()).map((entry) => (entry.data as { outcome: string }).outcome)).toEqual(["需要你", "未知"]);
		expect(await questions()).toHaveLength(1);

		// The re-check's done was read at once, so it scheduled none: no third completion.
		await pause(RECHECK_MS * 2);
		await settled();
		expect(events()).toBe(before + 1);
		expect(await done()).toHaveLength(2);
		await close();
	});

	test("a reply written after the timeout, its done settled into idle before the re-check, is recorded once", async () => {
		const { report, write, job, done, questions, events, settled, close } = await cutShort();
		// claude writes the reply, then settles the done into idle: the core reads nothing at done → idle.
		write(reply("a-1", "結果：需要你\nwhich branch?"));
		await report({ state: "idle", updated_at: later(40) });
		expect(await job()).toMatchObject({ status: { state: "idle" }, outcome: "未知", resultId: "u-1" });
		const before = events();

		await until(() => events() > before, RECHECK_MS * 3);
		await settled();
		expect(await job()).toMatchObject({ status: { state: "idle" }, outcome: "需要你", resultId: "a-1" });
		// Newest first.
		expect((await done()).map((entry) => (entry.data as { outcome: string }).outcome)).toEqual(["需要你", "未知"]);
		expect(await questions()).toHaveLength(1);

		await pause(RECHECK_MS * 2);
		await settled();
		expect(events()).toBe(before + 1);
		expect(await done()).toHaveLength(2);
		await close();
	});

	test("an idle on record but not yet reported is re-emitted, and the real idle after it reads the turn", async () => {
		const { block, report, write, job, done, questions, events, settled, close } = await cutShort();
		write(reply("a-1", "結果：需要你\nwhich branch?"));
		const idle = { state: "idle", updated_at: later(40) };
		// rex has settled the done into idle, but its event has not reached the watch by the re-check.
		block.records = [idle];
		const before = events();

		await until(() => events() > before, RECHECK_MS * 3);
		await settled();
		// The core reads nothing at done → idle.
		expect(await job()).toMatchObject({ status: { state: "idle" }, outcome: "未知", resultId: "u-1" });

		await report(idle);
		await settled();
		expect(await job()).toMatchObject({ status: { state: "idle" }, outcome: "需要你", resultId: "a-1" });
		expect(await done()).toHaveLength(2);
		expect(await questions()).toHaveLength(1);
		await close();
	});

	test.each([
		["a working", { state: "working" }],
		["a blocked", { state: "blocked", kind: "permission", msg: "approve?" }],
	])(
		"%s reported between the timeout and the re-check means no re-check, though the turn after ended",
		async (_case, between) => {
			const { report, write, job, done, events, settled, close } = await cutShort();
			await report({ ...between, updated_at: ago(20) });
			// The turn after ends on a reply written by the time rex stamps its end, so it is read at once.
			const end = { state: "done", updated_at: ago(10) };
			write(user("u-2", "go2"), reply("a-2", "結果：完成"));
			await report(end);
			await settled();
			expect(await job()).toMatchObject({ status: { state: "done" }, outcome: "完成", resultId: "a-2" });
			const before = events();

			await pause(RECHECK_MS * 2);
			expect(events()).toBe(before);
			expect(await done()).toHaveLength(2);
			await close();
		},
	);

	test("a turn written before the timeout schedules no re-check", async () => {
		const { report, write, job, done, events, close } = await dispatched({ replyMs: 100, recheckMs: RECHECK_MS });
		await report({ state: "idle", updated_at: ago(3_000) });
		await report({ state: "working", updated_at: ago(2_000) });
		write(user("u-1", "go"), reply("a-1", "結果：完成"));
		await report({ state: "done", updated_at: ago(1_000) });
		expect(await job()).toMatchObject({ outcome: "完成", resultId: "a-1" });
		const before = events();

		await pause(RECHECK_MS * 2);
		expect(events()).toBe(before);
		expect(await done()).toHaveLength(1);
		await close();
	});

	test.each([
		["working, as the watch reported", "reported"],
		["working, before rex's event for it reached the watch", "unreported"],
		["claude left the foreground, its done still on record", "exited"],
	] as const)("a block that moved on before the re-check gets nothing from it: %s", async (_case, how) => {
		const { block, report, write, job, done, events, close } = await cutShort();
		const working = { state: "working", updated_at: later(100) };
		if (how === "reported") await report(working);
		else if (how === "unreported") block.records = [working];
		else block.argv0 = "-fish";
		write(reply("a-1", "結果：需要你\nwhich branch?"));
		const before = events();

		await pause(RECHECK_MS * 2);
		expect(events()).toBe(before);
		expect(await job()).toMatchObject({ status: { state: how === "reported" ? "working" : "done" }, resultId: "u-1" });
		expect(await done()).toHaveLength(1);
		await close();
	});

	test("closing the watch cancels the re-check", async () => {
		const { agents, write, close } = await cutShort();
		await close();
		write(reply("a-1", "結果：需要你\nwhich branch?"));
		// A watch opened afterwards reports the done once, as its resync reads it, and nothing for the closed one.
		const seen: AgentStatusEvent[] = [];
		const off = agents.onStatus((event) => seen.push(event));
		await until(() => seen.length > 0);

		await pause(RECHECK_MS * 2);
		expect(seen.map((event) => event.status.state)).toEqual(["done"]);
		off();
	});

	test("a second read cut short replaces the block's pending re-check", async () => {
		const { agents, job, done, events, settled, close } = await cutShort();
		const before = events();
		await pause(RECHECK_MS / 2);
		// Read again while the first re-check is pending; claude still has not written the reply.
		expect(await agents.readResult("card-a")).toEqual({ id: "u-1" });
		// The first re-check's time has passed, and it was replaced.
		await pause(RECHECK_MS / 2 + 50);
		expect(events()).toBe(before);

		await until(() => events() > before, RECHECK_MS * 3);
		await pause(RECHECK_MS * 2);
		await settled();
		expect(events()).toBe(before + 1);
		expect(await job()).toMatchObject({ outcome: "未知", resultId: "u-1" });
		expect(await done()).toHaveLength(1);
		await close();
	});
});
