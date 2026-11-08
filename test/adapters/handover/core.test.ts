import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { deferExtension } from "../../../src/core/extensions/defer/index.ts";
import { eventBridge, JOB_DONE, reconcileDispatches } from "../../../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../../../src/core/extensions/dispatch/index.ts";
import { reclaimer } from "../../../src/core/extensions/dispatch/reclaim.ts";
import { openHarness } from "../../../src/core/harness.ts";
import { NOTICE } from "../../../src/core/notice.ts";
import { cleanUp } from "../acp/fake.ts";
import type { Block, Session } from "../rex/fake.ts";
import { AT_IDLE, sides, sleep } from "./fake.ts";

const context = BACKGROUND_CONTEXT;
const open: Harness[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
	await cleanUp();
});

/**
 * The real core over both sides, started as main.ts starts it, with a faux model that takes the human's words: 派 <card>
 * dispatches, 看 <card> shows the job, 回覆 <card> <text> replies, 畫面 <card> reads its screen, 工作 lists the jobs and 外面
 * the foreign agents. `results` holds every tool result the model was handed.
 */
async function core(options: { others?: Session[]; opened?: Partial<Block>; brief?: string } = {}) {
	const both = await sides(options);
	const results: unknown[] = [];
	const faux = fauxProvider();
	faux.setResponses(
		Array.from({ length: 30 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
			const last = request.messages.at(-1);
			if (last?.role === "toolResult") {
				const content = last.content as { text: string }[];
				results.push(JSON.parse(content[0]?.text ?? "null"));
				return fauxAssistantMessage("好。");
			}
			const [, verb, card = "", rest = ""] =
				/(派|看|回覆|畫面|工作|外面) ?([a-z0-9-]*) ?([^"]*)/.exec(JSON.stringify(last?.content ?? "")) ?? [];
			const call = (name: string, args: Record<string, string>) =>
				fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
			if (verb === "派") return call("dispatch", { card, repo: both.acp.cwd });
			if (verb === "看") return call("show_job", { card });
			if (verb === "回覆") return call("reply", { card, text: rest, reason: "the human answered" });
			if (verb === "畫面") return call("screen", { card });
			if (verb === "工作") return call("jobs", {});
			if (verb === "外面") return call("foreign_agents", {});
			return fauxAssistantMessage("好。");
		}),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	let reconciled: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		reconciled = resolve;
	});
	const defers = deferExtension(both.agents, {
		pollMs: 20,
		readyMs: 5_000,
		reclaim: (agent) => ready.then(() => reclaimer(root, both.agents, context)(agent)),
	});
	const harness = await openHarness(
		join(both.acp.cwd, "..", "soma.sqlite"),
		[
			dispatchExtension(
				both.agents,
				async (_repo, card) => `# ${card}\n\n${options.brief ?? "the word is KIWI"}`,
				both.agents,
			),
			defers.extension,
		],
		context,
		{ models },
	);
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	await reconcileDispatches(root, both.agents, context, await both.acp.port.dormant());
	reconciled();
	const off = eventBridge(root, both.agents, context).listen((error) => {
		if (open.includes(harness)) throw error;
	});
	const job = async (agent = "card-a") =>
		(await harness.snapshot(Dispatches, root.id, context))?.jobs.find((each) => each.agent === agent);
	const entries = async (kind: string) =>
		(await root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter((entry) => entry.kind === kind);
	let said = 0;
	return {
		...both,
		off,
		results,
		job,
		notices: async () => (await entries(NOTICE)).map((entry) => (entry.data as { content: string }).content),
		turns: async () => (await entries(JOB_DONE)).map((entry) => entry.data as { outcome: string }),
		say: async (content: string) => {
			const submission = await root.submit({ type: "input", content, requestId: `t:${said++}` }, context);
			expect((await submission.wait(context)).status).toBe("done");
			await root.waitForIdle(context);
		},
		until: async (ok: () => boolean | Promise<boolean>, what = "the condition") => {
			for (const deadline = Date.now() + 8_000; !(await ok()); await sleep(10)) {
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			}
		},
		defer: async (at: string, instruction: string) => {
			const reply = await defers.defer(root, { agent: "card-a", at, instruction }, context);
			if (!reply.accepted) throw new Error(reply.reason);
			return reply.id;
		},
		outcome: async (id: string) => (await harness.waitForTask(Number(id) as TaskId, context)).state.outcome,
	};
}

type Soma = Awaited<ReturnType<typeof core>>;

/** Dispatches card-a over ACP and waits for its brief's turn to be recorded. */
async function dispatched(soma: Soma) {
	await soma.say("派 card-a");
	await soma.until(async () => (await soma.job())?.outcome !== undefined, "the brief's turn");
}

/** Now, as rex stamps a record: a transcript written after it is written after the turn's end. */
const stamped = (state: string) => ({ state, updated_at: new Date().toISOString().replace("Z", "000+00:00") });

/** The window's claude runs a turn as real claude does: it reports working, then done, and writes its reply a little later. */
async function turn(soma: Soma, reply: string) {
	const window = soma.blocks.at(-1) as Block;
	const working = stamped("working");
	window.records = [working];
	soma.hangar.emit(soma.hangar.status(window.block, working));
	await sleep(5);
	const done = stamped("done");
	window.records = [done];
	soma.hangar.emit(soma.hangar.status(window.block, done));
	const entry = await soma.entry();
	// What the ACP side would read now: the transcript's last record, the turn before this one.
	const before = await soma.acp.port.readResult("card-a");
	await sleep(30);
	soma.wrote(entry, reply);
	return before;
}

test("the human asks to see a job: it moves, they are told once naming the window, and jobs lists it under its name and card", async () => {
	const soma = await core();
	await dispatched(soma);
	const before = await soma.job();
	const { acpSessionId } = await soma.entry();
	expect(before?.sessionId).not.toBe(acpSessionId);

	await soma.say("看 card-a");

	expect(soma.results.at(-1)).toEqual({
		handedOver: true,
		window: "card-a",
		session: "hangar",
		sessionId: acpSessionId,
		ready: true,
	});
	const notices = await soma.notices();
	expect(notices).toEqual([expect.stringContaining("its window is card-a in session hangar")]);
	expect(soma.windowsOpened()).toHaveLength(1);
	expect(await soma.job()).toEqual({ ...before, sessionId: acpSessionId, status: expect.anything() });
	await soma.say("工作");
	expect(soma.results.at(-1)).toMatchObject([{ card: "card-a", agent: "card-a", sessionId: acpSessionId }]);

	// Asked again, it is refused and no one is told again.
	await soma.say("看 card-a");
	expect(soma.results.at(-1)).toMatchObject({ handedOver: false, refusal: "not_acp" });
	expect(await soma.notices()).toEqual(notices);
	expect(soma.windowsOpened()).toHaveLength(1);
	soma.off();
});

test("after the handover screen reads the pane, and a reply goes into the pane and its turn is recorded by the bridge", async () => {
	const soma = await core();
	await dispatched(soma);
	await soma.say("看 card-a");
	(soma.blocks[0] as Block).screen = "❯ what the pane shows";

	await soma.say("畫面 card-a");
	expect(soma.results.at(-1)).toEqual({ text: "❯ what the pane shows" });

	await soma.say("回覆 card-a the word again");
	expect(soma.typed()).toEqual(["the word again"]);
	expect(soma.results.at(-1)).toEqual({ sent: true });
	expect((await soma.job())?.decisions).toMatchObject([{ action: "replied", text: "the word again" }]);

	const before = await soma.onRex.readResult("card-a");
	const acpRead = await turn(soma, "結果：完成\nKIWI");
	await soma.until(async () => (await soma.job())?.outcome === "完成", "the reply's turn");

	// The turn's end came before its reply: the ACP side reads the record before it, and the rex side waits for the reply.
	expect(acpRead?.id).toBe(before?.id);
	const result = await soma.agents.readResult("card-a");
	expect(result?.text).toBe("結果：完成\nKIWI");
	expect(result?.id).not.toBe(before?.id);
	expect(await soma.job()).toMatchObject({ status: { state: "done" }, outcome: "完成", resultId: result?.id });
	expect((await soma.turns()).at(-1)).toMatchObject({ outcome: "完成" });
	expect(await soma.pids()).toHaveLength(1);
	soma.off();
});

test("a window that reports its first idle and settles records no turn, and sends no brief again", async () => {
	const soma = await core();
	await dispatched(soma);
	const turns = (await soma.turns()).length;

	await soma.say("看 card-a");

	const window = soma.blocks[0] as Block;
	soma.hangar.emit(soma.hangar.status(window.block, AT_IDLE));
	const settled = { state: "idle", updated_at: "2026-10-27T01:02:09.000000+08:00" };
	window.records = [settled];
	soma.hangar.emit(soma.hangar.status(window.block, settled));
	await soma.until(async () => (await soma.job())?.status.state === "idle", "the window's idle");
	await sleep(100);

	expect(await soma.turns()).toHaveLength(turns);
	expect(soma.typed()).toEqual([]);
	soma.off();
});

test("a job that deferred after the handover is stopped and resumed the rex way, and gets its instruction in the new window", async () => {
	const soma = await core();
	await dispatched(soma);
	await soma.say("看 card-a");
	const { acpSessionId } = await soma.entry();
	const pids = await soma.pids();

	const id = await soma.defer("PT1S", "the instruction");
	await soma.until(() => soma.hangar.methods().includes("block.close"), "the reclaim");
	await soma.until(async () => (await soma.job())?.reclaim?.phase === "stopped", "the job stopped");
	expect(soma.blocks).toEqual([]);
	expect(await soma.notices()).toHaveLength(1);

	expect(await soma.outcome(id)).toEqual({ status: "completed", result: "sent" });

	const [first, second, ...more] = soma.windowsOpened();
	expect(more).toEqual([]);
	expect(second?.payload).toEqual(first?.payload);
	expect(JSON.stringify(second?.payload)).toContain(`claude --resume ${acpSessionId} --model 'claude-fake-1'`);
	expect(soma.typed()).toEqual([expect.stringContaining("the instruction")]);
	// No process over ACP came back for it, and no one was told of anything more.
	expect(await soma.pids()).toEqual(pids);
	expect(await readFile(join(soma.acp.cwd, "..", "projects", "loaded"), "utf8").catch(() => "")).toBe("");
	expect(await soma.notices()).toHaveLength(1);
	soma.off();
});

test("foreign_agents names the human's panes, never a job over ACP or a job handed over", async () => {
	const human: Block = { name: "mine", block: "block:human", argv0: "claude", cwd: "/home/me", records: [AT_IDLE] };
	const soma = await core({ others: [{ id: "session:work", label: "work", blocks: [human] }] });
	await dispatched(soma);
	const ids = () => (soma.results.at(-1) as { id: string }[]).map((agent) => agent.id);

	await soma.say("外面");
	expect(ids()).toEqual(["block:human"]);
	expect(soma.windowsOpened()).toEqual([]);

	await soma.say("看 card-a");
	await soma.say("外面");
	expect(ids()).toEqual(["block:human"]);
	soma.off();
});

test("a job that is working when the human asks is refused, with no notice, and goes on over ACP", async () => {
	const soma = await core({ brief: "HANG" });
	await soma.say("派 card-a");
	await soma.until(async () => (await soma.job())?.status.state === "working", "the job at work");

	await soma.say("看 card-a");

	expect(soma.results.at(-1)).toMatchObject({ handedOver: false, refusal: "not_at_rest" });
	expect(await soma.notices()).toEqual([]);
	expect(soma.windowsOpened()).toEqual([]);
	expect(await soma.closed()).toBe("");
	soma.off();
});
