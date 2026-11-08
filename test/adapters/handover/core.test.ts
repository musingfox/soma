import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { RexTransportError } from "../../../src/adapters/rex/client.ts";
import { deferExtension } from "../../../src/core/extensions/defer/index.ts";
import {
	eventBridge,
	handoverBridge,
	JOB_DONE,
	reconcileDispatches,
} from "../../../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../../../src/core/extensions/dispatch/index.ts";
import { reclaimer } from "../../../src/core/extensions/dispatch/reclaim.ts";
import { openHarness } from "../../../src/core/harness.ts";
import { NOTICE } from "../../../src/core/notice.ts";
import { cleanUp } from "../acp/fake.ts";
import { type Block, HANGAR, type Session } from "../rex/fake.ts";
import { AT_IDLE, fakeClock, sides, sleep } from "./fake.ts";

const context = BACKGROUND_CONTEXT;
// A request id goes with the db: the soma after this one must not get its words back as already said.
let said = 0;
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
async function core(
	options: {
		others?: Session[];
		opened?: Partial<Block>;
		brief?: string;
		blocks?: Block[];
		restartOf?: string;
		rexDown?: boolean;
		clock?: ReturnType<typeof fakeClock>;
		graceMs?: number;
	} = {},
) {
	const both = await sides(options);
	const results: unknown[] = [];
	const faux = fauxProvider();
	faux.setResponses(
		Array.from({ length: 30 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
			const last = request.messages.at(-1);
			if (last?.role === "toolResult") {
				const content = last.content as { text: string }[];
				// A tool that threw answers with the error's message, which is no JSON.
				const answer = content[0]?.text ?? "null";
				results.push(/^[[{]|^null$/.test(answer) ? JSON.parse(answer) : answer);
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
	const quietOnceClosed = (error: unknown) => {
		if (open.includes(harness)) throw error;
	};
	const offSettled = handoverBridge(root, both.agents, context).listen(quietOnceClosed);
	await both.agents.heard();
	await reconcileDispatches(root, both.agents, context, await both.agents.dormant());
	reconciled();
	const offEvents = eventBridge(root, both.agents, context).listen(quietOnceClosed);
	const off = () => {
		offEvents();
		offSettled();
	};
	const job = async (agent = "card-a") =>
		(await harness.snapshot(Dispatches, root.id, context))?.jobs.find((each) => each.agent === agent);
	const entries = async (kind: string) =>
		(await root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter((entry) => entry.kind === kind);
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
		/** The job's status becomes `idle`, as after a cancelled turn: one a reconcile would report gone if it is not listed. */
		rest: () =>
			root.commit(async (tx) => {
				const doc = await tx.doc(Dispatches, root.id);
				doc.jobs = doc.jobs.map((each) => ({ ...each, status: { state: "idle" } }));
			}, context),
		/** Ends this soma as a kill would for what the next one finds: its agents gone, its db closed. */
		end: async () => {
			off();
			await both.acp.end();
			open.splice(open.indexOf(harness), 1);
			await harness.close(context);
		},
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

/**
 * A soma that went down with the job's handover in progress: the entry marked and the ACP process gone. `window`: its
 * window opened first.
 */
async function leftMidHandover(
	window: boolean,
	mark: Record<string, unknown> = { handingOver: true },
	{ rested = true }: { rested?: boolean } = {},
) {
	const soma = await core();
	await dispatched(soma);
	if (rested) await soma.rest();
	const entry = await soma.entry();
	await writeFile(soma.acp.sessionsFile, `${JSON.stringify({ "card-a": { ...entry, ...mark } })}\n`);
	await soma.end();
	if (window) {
		soma.blocks.push({
			name: "card-a",
			block: "block:left",
			label: entry.acpSessionId,
			argv0: "claude",
			cwd: entry.cwd,
			records: [AT_IDLE],
		});
	}
	return { cwd: soma.acp.cwd, blocks: soma.blocks, entry };
}

test("a restart that finds a handover cut short with no window has the job dormant on ACP: named once, not gone, and it goes on", async () => {
	const { cwd, blocks } = await leftMidHandover(false);

	const soma = await core({ restartOf: cwd, blocks });

	expect(await soma.job()).toMatchObject({ status: { state: "idle" } });
	expect(await soma.notices()).toEqual([expect.stringContaining("agent card-a（卡片 card-a）")]);
	expect(await soma.pids()).toEqual([]);
	await soma.say("回覆 card-a RECALL");
	expect(soma.results.at(-1)).toEqual({ sent: true });
	await soma.until(
		async () => (await soma.agents.readResult("card-a"))?.text?.startsWith("recall:") === true,
		"the turn",
	);
	expect(soma.windowsOpened()).toEqual([]);
	expect(soma.typed()).toEqual([]);
	soma.off();
});

test("a restart that finds a handover cut short with its window open has the job on rex: not gone, no ACP process, and a reply goes into the pane", async () => {
	const { cwd, blocks, entry } = await leftMidHandover(true);

	const soma = await core({ restartOf: cwd, blocks });

	expect((await soma.entry()).handedOver).toBe(true);
	expect(await soma.job()).toMatchObject({ status: { state: "idle" } });
	expect(await soma.agents.list()).toMatchObject([{ name: "card-a", sessionId: entry.acpSessionId }]);
	await soma.say("回覆 card-a the word again");
	expect(soma.results.at(-1)).toEqual({ sent: true });
	expect(soma.typed()).toEqual(["the word again"]);
	expect(await soma.pids()).toEqual([]);
	soma.off();
});

test("show_job on a take that gave up tells the model the job is undecided and why, not that it stays on ACP", async () => {
	const soma = await core({ clock: fakeClock() });
	await dispatched(soma);
	const original = soma.hangar.client.call.bind(soma.hangar.client);
	soma.hangar.client.call = async (method, payload, schema) => {
		if (method === "session.new_window") throw new RexTransportError("session.new_window: no response within 10000 ms");
		return original(method, payload, schema);
	};

	await soma.say("看 card-a");

	const told = soma.results.at(-1) as { handedOver: boolean; refusal: string; reason: string };
	expect(told).toMatchObject({ handedOver: false, refusal: "cannot_resume" });
	expect(told.reason).toContain("no response within 10000 ms");
	expect(told.reason).toContain("the job is undecided");
	expect(told.reason).toContain("its window may still open");
	expect(told.reason).toContain("grace period");
	expect(told.reason).not.toContain("stays on ACP");
	expect(await soma.notices()).toEqual([]);
	expect(await soma.job()).toMatchObject({ status: { state: "done" } });
	soma.off();
});

test("a labelled block in no window, through the listing and the real core: undecided, never gone, then its window", async () => {
	const { cwd, blocks, entry } = await leftMidHandover(true);
	(blocks[0] as Block).detached = true;

	const soma = await core({ restartOf: cwd, blocks });

	const left = await soma.entry();
	expect(left.handedOver).toBeUndefined();
	expect(left.handingOver).toBe(true);
	expect(await soma.agents.list()).toEqual([{ name: "card-a", sessionId: (await soma.job())?.sessionId }]);
	expect(await soma.job()).toMatchObject({ status: { state: "idle" } });
	expect(await soma.notices()).toEqual([]);
	expect((await soma.turns()).filter((turn) => turn.outcome === "失敗")).toEqual([]);
	await soma.say("回覆 card-a too soon");
	expect(soma.results.at(-1)).toEqual(expect.stringContaining("in no window a listing reads"));

	(blocks[0] as Block).detached = false;
	expect(await soma.agents.list()).toMatchObject([{ name: "card-a", sessionId: entry.acpSessionId }]);
	expect((await soma.entry()).handedOver).toBe(true);
	await soma.say("回覆 card-a now");
	expect(soma.typed()).toEqual(["now"]);
	soma.off();
});

test("a labelled block in no window, gone by the next look, through the listing and the real core: back on ACP, never gone", async () => {
	const { cwd, blocks } = await leftMidHandover(true);
	(blocks[0] as Block).detached = true;
	const soma = await core({ restartOf: cwd, blocks });
	blocks.length = 0;

	expect(await soma.agents.list()).toEqual([{ name: "card-a", sessionId: (await soma.job())?.sessionId }]);

	const entry = await soma.entry();
	expect(entry.handedOver).toBeUndefined();
	expect(entry.handingOver).toBeUndefined();
	expect(await soma.job()).toMatchObject({ status: { state: "idle" } });
	expect((await soma.turns()).filter((turn) => turn.outcome === "失敗")).toEqual([]);
	soma.off();
});

test.each([
	["with no window", false],
	["with its window open", true],
])(
	"a restart with rex down keeps the job undecided %s, not gone, then the right side once rex answers",
	async (_name, window) => {
		const { cwd, blocks } = await leftMidHandover(window);

		const soma = await core({ restartOf: cwd, blocks, rexDown: true });

		expect(await soma.job()).toMatchObject({ status: { state: "idle" } });
		expect(await soma.notices()).toEqual([]);
		expect((await soma.turns()).filter((turn) => turn.outcome === "失敗")).toEqual([]);
		await soma.say("回覆 card-a too soon");
		expect(soma.results.at(-1)).toEqual(expect.stringContaining("being handed over"));
		expect(await soma.pids()).toEqual([]);

		soma.rexUp();
		const before = soma.hangar.calls.length;
		await soma.say("工作");
		expect(soma.results.at(-1)).toMatchObject([{ card: "card-a", status: { state: "idle" } }]);
		expect(soma.hangar.calls.length).toBe(before);

		await soma.say("回覆 card-a now");
		expect(soma.results.at(-1)).toEqual({ sent: true });
		expect(soma.typed()).toEqual(window ? ["now"] : []);
		expect(await soma.pids()).toHaveLength(window ? 0 : 1);
		soma.off();
	},
);

test("a window whose reply was lost is handed over all the same: the core tells the human once, and the job takes its session", async () => {
	const soma = await core();
	await dispatched(soma);
	const { acpSessionId } = await soma.entry();
	const original = soma.hangar.client.call.bind(soma.hangar.client);
	soma.hangar.client.call = async (method, payload, schema) => {
		const reply = await original(method, payload, schema);
		if (method === "session.new_window") throw new Error("session.new_window: no response within 10000 ms");
		return reply;
	};

	await soma.say("看 card-a");

	expect(soma.results.at(-1)).toEqual({
		handedOver: true,
		window: "card-a",
		session: "hangar",
		sessionId: acpSessionId,
		ready: true,
	});
	expect(await soma.notices()).toEqual([expect.stringContaining("its window is card-a in session hangar")]);
	expect((await soma.job())?.sessionId).toBe(acpSessionId);
	await soma.say("回覆 card-a go on");
	expect(soma.typed()).toEqual(["go on"]);
	soma.off();
});

const onRex = "its window is card-a in session hangar";
const backOnAcp = "is back on ACP";
const counted = (notices: string[], text: string) => notices.filter((notice) => notice.includes(text)).length;

/** The next soma on what `soma` left, after a kill: its agents gone, its db closed. */
async function again(soma: Soma, options: Parameters<typeof core>[0] = {}) {
	await soma.end();
	return core({ restartOf: soma.acp.cwd, blocks: soma.blocks, ...options });
}

/** One notice names the window and its session, and block label, listing and job all hold the claude session. */
async function toldOnRexOnce(soma: Soma, acpSessionId: string) {
	await soma.until(async () => counted(await soma.notices(), onRex) === 1, "the notice of the move");
	await soma.until(async () => (await soma.job())?.sessionId === acpSessionId, "the job to take the session");
	expect(soma.blocks.at(-1)?.label).toBe(acpSessionId);
	expect(await soma.agents.list()).toMatchObject([{ name: "card-a", sessionId: acpSessionId }]);
}

test("a crash landing on rex found at startup tells the human once, across restarts, and the job takes the session", async () => {
	const { cwd, blocks, entry } = await leftMidHandover(true);

	const soma = await core({ restartOf: cwd, blocks });

	await toldOnRexOnce(soma, entry.acpSessionId);
	expect(await soma.notices()).toEqual([expect.stringContaining("Its handover was cut short and ended there")]);

	const next = await again(soma);
	await sleep(50);
	expect(counted(await next.notices(), onRex)).toBe(1);
	expect((await next.job())?.sessionId).toBe(entry.acpSessionId);
	const last = await again(next);
	await sleep(50);
	expect(counted(await last.notices(), onRex)).toBe(1);
	last.off();
});

test("a soma killed after the final mark and before the commit: the next one tells the human, once", async () => {
	const { cwd, blocks, entry } = await leftMidHandover(true, { handedOver: true });

	const soma = await core({ restartOf: cwd, blocks });

	await toldOnRexOnce(soma, entry.acpSessionId);
	const next = await again(soma);
	await sleep(50);
	expect(counted(await next.notices(), onRex)).toBe(1);
	next.off();
});

test("a window found by a later look, with rex back: the human is told once and the job takes the session", async () => {
	const { cwd, blocks, entry } = await leftMidHandover(true);
	const soma = await core({ restartOf: cwd, blocks, rexDown: true });
	expect(await soma.notices()).toEqual([]);
	soma.rexUp();

	await soma.say("回覆 card-a go on");

	expect(soma.typed()).toEqual(["go on"]);
	await toldOnRexOnce(soma, entry.acpSessionId);
	await soma.agents.list();
	await sleep(50);
	expect(counted(await soma.notices(), onRex)).toBe(1);

	const next = await again(soma);
	await sleep(50);
	expect(counted(await next.notices(), onRex)).toBe(1);
	next.off();
});

/** A running soma whose show_job on card-a gave up on `session.new_window`, whose window has not opened. */
async function showGaveUp(options: Parameters<typeof core>[0] = {}) {
	const soma = await core(options);
	await dispatched(soma);
	const entry = await soma.entry();
	const original = soma.hangar.client.call.bind(soma.hangar.client);
	soma.hangar.client.call = async (method, payload, schema) => {
		if (method === "session.new_window") throw new RexTransportError("no response within 10000 ms");
		return original(method, payload, schema);
	};
	await soma.say("看 card-a");
	expect(soma.results.at(-1)).toMatchObject({ handedOver: false, reason: expect.stringContaining("undecided") });
	return { soma, entry };
}

const lateWindow = (soma: Soma, { acpSessionId, cwd }: { acpSessionId: string; cwd: string }) =>
	soma.blocks.push({
		name: "card-a",
		block: "block:late",
		label: acpSessionId,
		argv0: "claude",
		cwd,
		records: [AT_IDLE],
	});

test("a window that opens within the grace period, in a running soma: the next reply goes to it, and the human is told once", async () => {
	const clock = fakeClock();
	const { soma, entry } = await showGaveUp({ clock });
	clock.advance(59_000);
	lateWindow(soma, entry);

	await soma.say("回覆 card-a go on");

	expect(soma.typed()).toEqual(["go on"]);
	await toldOnRexOnce(soma, entry.acpSessionId);
	expect(counted(await soma.notices(), backOnAcp)).toBe(0);
	soma.off();
});

test("a window that never opens, in a running soma: back on ACP at the next look past the end, the human told once", async () => {
	const clock = fakeClock();
	const { soma, entry } = await showGaveUp({ clock });
	clock.advance(60_000);

	await soma.agents.list();

	await soma.until(async () => counted(await soma.notices(), backOnAcp) === 1, "the notice of the return");
	expect(await soma.notices()).toEqual([expect.stringContaining("agent card-a (card card-a) is back on ACP")]);
	expect((await soma.job())?.sessionId).not.toBe(entry.acpSessionId);
	await soma.agents.list();
	await soma.say("回覆 card-a RECALL");
	expect(soma.results.at(-1)).toEqual({ sent: true });
	await soma.until(async () => (await soma.pids()).length === 2, "ACP to start again");
	expect(counted(await soma.notices(), backOnAcp)).toBe(1);

	const next = await again(soma);
	await sleep(50);
	expect(counted(await next.notices(), backOnAcp)).toBe(1);
	next.off();
});

test("with no one asking, the end of the grace period tells the human where the job is: back on ACP", async () => {
	const { soma } = await showGaveUp({ graceMs: 40 });

	await soma.until(async () => counted(await soma.notices(), backOnAcp) === 1, "the notice of the return");
	soma.off();
});

test("with no one asking, the end of the grace period tells the human where the job is: on rex", async () => {
	const { soma, entry } = await showGaveUp({ graceMs: 40 });
	lateWindow(soma, entry);

	await toldOnRexOnce(soma, entry.acpSessionId);
	soma.off();
});

test("a job waiting out the rest of the grace period at a restart is not gone, and its return is told once", async () => {
	const clock = fakeClock();
	const { cwd, blocks } = await leftMidHandover(false, {
		handingOver: true,
		hangar: HANGAR,
		handingOverAt: clock.now(),
	});

	const soma = await core({ restartOf: cwd, blocks, clock });

	expect(await soma.notices()).toEqual([]);
	expect(await soma.job()).toMatchObject({ status: { state: "idle" } });
	expect((await soma.turns()).filter((turn) => turn.outcome === "失敗")).toEqual([]);
	await soma.say("回覆 card-a too soon");
	expect(soma.results.at(-1)).toEqual(expect.stringContaining("grace period"));
	clock.advance(60_000);

	await soma.say("回覆 card-a RECALL");

	expect(soma.results.at(-1)).toEqual({ sent: true });
	await soma.until(async () => counted(await soma.notices(), backOnAcp) === 1, "the notice of the return");
	soma.off();
});

test("a startup look that gives the job back tells once, by the reconcile, and not again as a return", async () => {
	const { cwd, blocks } = await leftMidHandover(false);

	const soma = await core({ restartOf: cwd, blocks });

	await sleep(50);
	const notices = await soma.notices();
	expect(notices).toEqual([expect.stringContaining("agent card-a（卡片 card-a）")]);
	expect(counted(notices, backOnAcp)).toBe(0);
	soma.off();
});

const gone = "不見了";
const noWindow = "no window of it is open now";

test("a crash between the final mark and the commit, the window closed since: the job is gone, with no claim of a window", async () => {
	const { cwd, blocks, entry } = await leftMidHandover(false, { handedOver: true });

	const soma = await core({ restartOf: cwd, blocks });

	expect(await soma.notices()).toEqual([expect.stringContaining(gone)]);
	expect(await soma.agents.list()).toEqual([]);
	expect((await soma.job())?.sessionId).toBe(entry.acpSessionId);
	expect((await soma.job())?.status.state).toBe("error");

	const next = await again(soma);
	await sleep(50);
	expect(await next.notices()).toEqual([expect.stringContaining(gone)]);
	next.off();
});

test("the same for a job done by a real turn, which the reconcile leaves alone: told once, with no claim of a window", async () => {
	const { cwd, blocks } = await leftMidHandover(false, { handedOver: true }, { rested: false });

	const soma = await core({ restartOf: cwd, blocks });

	expect(await soma.notices()).toEqual([expect.stringContaining(noWindow)]);
	expect(counted(await soma.notices(), onRex)).toBe(0);
	expect((await soma.job())?.status.state).toBe("done");

	const next = await again(soma);
	await sleep(50);
	expect(await next.notices()).toEqual([expect.stringContaining(noWindow)]);
	next.off();
});

test("a later look gives a done job back and soma dies before the commit: the next one tells it, once, across restarts", async () => {
	const clock = fakeClock();
	const { soma } = await showGaveUp({ clock });
	expect((await soma.job())?.status.state).toBe("done");
	soma.off();
	clock.advance(60_000);
	await soma.agents.list();
	expect((await soma.entry()).handingOver).toBeUndefined();
	expect(counted(await soma.notices(), backOnAcp)).toBe(0);

	const next = await again(soma, { clock });

	expect(counted(await next.notices(), backOnAcp)).toBe(1);
	const last = await again(next, { clock });
	await sleep(50);
	expect(counted(await last.notices(), backOnAcp)).toBe(1);
	expect(await last.notices()).toHaveLength(1);
	last.off();
});

test("a startup past the grace period gives a done job back: told once, across restarts, and not named as a restart's", async () => {
	const { cwd, blocks } = await leftMidHandover(false, { handingOver: true }, { rested: false });

	const soma = await core({ restartOf: cwd, blocks });

	expect(await soma.job()).toMatchObject({ status: { state: "done" } });
	expect(await soma.notices()).toEqual([expect.stringContaining(backOnAcp)]);
	const next = await again(soma);
	await sleep(50);
	expect(await next.notices()).toEqual([expect.stringContaining(backOnAcp)]);
	next.off();
});

test("a startup that gives a done job back and dies before anything is committed: the next one tells it, once", async () => {
	const { cwd, blocks } = await leftMidHandover(false, { handingOver: true }, { rested: false });
	const between = await sides({ restartOf: cwd, blocks });
	expect(await between.agents.dormant()).toEqual(["card-a"]);
	await between.acp.end();

	const soma = await core({ restartOf: cwd, blocks });

	expect(await soma.notices()).toEqual([expect.stringContaining(backOnAcp)]);
	soma.off();
});

test("a job told by the restart's notice is not told again as a return, by this restart or the next", async () => {
	const { cwd, blocks } = await leftMidHandover(false);

	const soma = await core({ restartOf: cwd, blocks });

	expect(counted(await soma.notices(), backOnAcp)).toBe(0);
	await sleep(50);
	const next = await again(soma);
	await sleep(50);
	expect(counted(await next.notices(), backOnAcp)).toBe(0);
	next.off();
});

test("a job never handed over gets nothing new at a restart, done by a real turn or not", async () => {
	const first = await core();
	await dispatched(first);
	expect((await first.job())?.status.state).toBe("done");

	const soma = await again(first);

	await sleep(50);
	expect(await soma.notices()).toEqual([]);
	expect((await soma.job())?.toldBack).toBeUndefined();
	expect((await soma.entry()).givenBack).toBeUndefined();
	soma.off();
});

test("a job moved by show_job is told once, and no restart tells it again", async () => {
	const soma = await core();
	await dispatched(soma);
	await soma.say("看 card-a");
	const { acpSessionId } = await soma.entry();
	expect(counted(await soma.notices(), onRex)).toBe(1);

	const next = await again(soma);

	await sleep(50);
	expect(counted(await next.notices(), onRex)).toBe(1);
	expect((await next.job())?.sessionId).toBe(acpSessionId);
	next.off();
});

test("a job never handed over reaches rex in no way at startup, through the real core, whatever bears its label", async () => {
	const first = await core();
	await dispatched(first);
	const { acpSessionId } = await first.entry();
	first.blocks.push({ name: "card-a", block: "block:namesake", label: acpSessionId, argv0: "claude" });

	const soma = await again(first);

	await sleep(50);
	// The status watch reads the hangar, as it does for any soma, and drops what it finds: nothing looks for the job or acts.
	const methods = soma.hangar.methods();
	for (const method of ["session.list_blocks", "session.attach_all", "session.new_window", "block.event"]) {
		expect(methods).not.toContain(method);
	}
	expect(methods).not.toContain("com.superlogical.terminal.write");
	expect(await soma.agents.list()).toEqual([{ name: "card-a", sessionId: (await soma.job())?.sessionId }]);
	expect(counted(await soma.notices(), onRex)).toBe(0);
	expect((await soma.job())?.sessionId).not.toBe(acpSessionId);
	soma.off();
});
