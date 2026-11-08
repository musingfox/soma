import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { seqOf } from "../../../src/adapters/rex/agent-port.ts";
import { RexRpcError, RexTransportError } from "../../../src/adapters/rex/client.ts";
import { deferExtension } from "../../../src/core/extensions/defer/index.ts";
import {
	AGENT_BLOCKED,
	eventBridge,
	handoverBridge,
	JOB_DONE,
	reconcileDispatches,
} from "../../../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../../../src/core/extensions/dispatch/index.ts";
import { reclaimer } from "../../../src/core/extensions/dispatch/reclaim.ts";
import { openHarness } from "../../../src/core/harness.ts";
import { NOTICE } from "../../../src/core/notice.ts";
import type { AgentState } from "../../../src/ports/agent.ts";
import { cleanUp } from "../acp/fake.ts";
import { type Block, fixture, HANGAR } from "../rex/fake.ts";
import { AT_IDLE, alive, fakeClock, sides, sleep } from "./fake.ts";

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
 * dispatches, 看 <card> shows the job, 回覆 <card> <text> replies, 畫面 <card> reads its screen, 工作 lists the jobs, 外面
 * the foreign agents and 選 <card> <fingerprint> answers a prompt, as a wake it had pending would. It does nothing for a
 * wake itself. `results` holds every tool result the model was handed.
 */
async function core(options: Parameters<typeof sides>[0] & { brief?: string } = {}) {
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
			if (JSON.stringify(last?.content ?? "").includes("[bridge]")) return fauxAssistantMessage("好。");
			const [, verb, card = "", rest = ""] =
				/(派|看|回覆|畫面|工作|外面|選) ?([a-z0-9-]*) ?([^"]*)/.exec(JSON.stringify(last?.content ?? "")) ?? [];
			const call = (name: string, args: Record<string, string>) =>
				fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
			if (verb === "派") return call("dispatch", { card, repo: both.acp.cwd });
			if (verb === "看") return call("show_job", { card });
			if (verb === "回覆") return call("reply", { card, text: rest, reason: "the human answered" });
			if (verb === "畫面") return call("screen", { card });
			if (verb === "工作") return call("jobs", {});
			if (verb === "外面") return call("foreign_agents", {});
			if (verb === "選") return call("respond", { card, option: "1", fingerprint: rest, reason: "its wake" });
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
	const bridge = eventBridge(root, both.agents, context);
	const offEvents = bridge.listen(quietOnceClosed);
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
		bridge,
		wakes: async () => (await entries(AGENT_BLOCKED)).length,
		notices: async () => (await entries(NOTICE)).map((entry) => (entry.data as { content: string }).content),
		turns: async () => (await entries(JOB_DONE)).map((entry) => entry.data as { outcome: string; notified: boolean }),
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
	expect(await soma.job()).toEqual({
		...before,
		sessionId: acpSessionId,
		status: { state: "idle" },
		seq: seqOf(AT_IDLE),
	});
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

/** card-a has finished its brief, and now runs `prompt`, a turn still going as this returns, in `state`. */
async function busy(soma: Soma, prompt: string, state: "working" | "blocked" = "working") {
	await dispatched(soma);
	const told = await soma.notices();
	const turns = await soma.turns();
	const before = await soma.job();
	await soma.say(`回覆 card-a ${prompt}`);
	await soma.until(async () => (await soma.job())?.status.state === state, `the job ${state}`);
	return { told, turns, before };
}

const blockedOn = async (soma: Soma) => (await soma.job())?.status as Extract<AgentState, { state: "blocked" }>;

const cutTurn = "Its running turn was cut.";
const prompted = "approve touch probe.txt\nCreate probe.txt";

test("a working job: the human asks, its turn is cut and it moves, told once, and nothing of the cut turn is recorded", async () => {
	const soma = await core();
	const { turns, before } = await busy(soma, "SPIN");
	const { acpSessionId } = await soma.entry();

	await soma.say("看 card-a");

	expect(soma.results.at(-1)).toEqual({
		handedOver: true,
		window: "card-a",
		session: "hangar",
		sessionId: acpSessionId,
		ready: true,
		cut: {},
	});
	const notices = await soma.notices();
	expect(notices).toEqual([expect.stringContaining("its window is card-a in session hangar")]);
	expect(notices[0]).toContain(cutTurn);
	expect(notices[0]).toContain("Tell it in the window how to go on");
	expect(notices[0]).not.toContain("will not ask again");
	expect(notices[0]).not.toContain("partial");
	await sleep(100);
	expect(await soma.turns()).toEqual(turns);
	expect(await soma.notices()).toEqual(notices);
	const job = await soma.job();
	expect(job?.outcome).toBe(before?.outcome);
	expect(job?.outcome).toBe("未知");
	expect(job?.sessionId).toBe(acpSessionId);
	expect(job?.resultId).toBe((await soma.agents.readResult("card-a"))?.id);
	expect(job?.resultId).not.toBe(before?.resultId);
	soma.off();
});

test("after the cut, the window's idles record no turn, and jobs lists the window's state", async () => {
	const soma = await core();
	const { turns } = await busy(soma, "SPIN");
	await soma.say("看 card-a");

	const window = soma.blocks[0] as Block;
	const settled = { state: "idle", updated_at: "2026-10-27T01:02:09.000000+08:00" };
	window.records = [settled];
	soma.hangar.emit(soma.hangar.status(window.block, settled));
	await soma.until(async () => (await soma.job())?.seq === seqOf(settled), "the window's idle");
	await sleep(50);

	expect(await soma.turns()).toEqual(turns);
	await soma.say("工作");
	expect(soma.results.at(-1)).toMatchObject([{ card: "card-a", status: { state: "idle" }, seq: seqOf(settled) }]);
	soma.off();
});

test("after the cut, the next turn in the window is recorded as any turn is, told by its reply", async () => {
	const soma = await core();
	const { turns } = await busy(soma, "SPIN");
	await soma.say("看 card-a");

	await soma.say("回覆 card-a go on");
	expect(soma.typed()).toEqual(["go on"]);
	await turn(soma, "結果：完成\nKIWI");

	await soma.until(async () => (await soma.job())?.outcome === "完成", "the window's turn");
	expect((await soma.turns()).slice(turns.length)).toMatchObject([{ outcome: "完成" }]);
	expect(await soma.job()).toMatchObject({ status: { state: "done" }, resultId: expect.any(String) });
	soma.off();
});

test("a window still working as the move ends: jobs reads that, not the status from before", async () => {
	const working = { state: "working", updated_at: "2026-10-27T01:02:05.000000+08:00" };
	const soma = await core({ opened: { records: [working] } });
	await busy(soma, "SPIN");

	await soma.say("看 card-a");

	await soma.until(async () => (await soma.job())?.seq === seqOf(working), "the window's state");
	expect((await soma.job())?.status.state).toBe("working");
	soma.off();
});

test("a window with no claude up as the move ends: the job is no longer working, and the notice says to look", async () => {
	const soma = await core({ opened: { records: [], screen: "$ claude --resume" } });
	await busy(soma, "SPIN");

	await soma.say("看 card-a");

	expect(soma.results.at(-1)).toMatchObject({ handedOver: true, ready: false, cut: {} });
	expect((await soma.job())?.status).toEqual({ state: "idle" });
	const [notice] = await soma.notices();
	expect(notice).toContain(cutTurn);
	expect(notice).toContain("has not reported itself up");
	soma.off();
});

test("a blocked job: the prompt is cancelled and quoted once, the job is no longer blocked, and nothing is recorded of it", async () => {
	const soma = await core();
	const { turns } = await busy(soma, "ASK", "blocked");
	expect(await soma.wakes()).toBe(1);

	await soma.say("看 card-a");

	expect(soma.results.at(-1)).toMatchObject({ handedOver: true, cut: { prompt: expect.stringContaining("touch") } });
	const notices = await soma.notices();
	expect(notices).toEqual([expect.stringContaining("its window is card-a in session hangar")]);
	expect(notices[0]).toContain(`was cancelled, and its turn with it: "${prompted}`);
	expect(notices[0]).not.toContain("1. Yes");
	expect(notices[0]).toContain("will not ask again");
	const job = await soma.job();
	expect(job?.status.state).toBe("idle");
	expect(job?.handedOver).toBeUndefined();
	await sleep(50);
	expect(await soma.turns()).toEqual(turns);
	expect(await soma.notices()).toEqual(notices);
	soma.off();
});

test("the model's pending wake answers nothing into the window: refused not blocked, and no key is pressed", async () => {
	const soma = await core();
	await busy(soma, "ASK", "blocked");
	const { fingerprint } = await blockedOn(soma);
	await soma.say("看 card-a");
	const before = soma.hangar.methods().filter((method) => method === "block.event").length;

	await soma.say(`選 card-a ${fingerprint}`);

	expect(soma.results.at(-1)).toEqual({ sent: false, refusal: "not_blocked" });
	expect(soma.hangar.methods().filter((method) => method === "block.event")).toHaveLength(before);
	expect((await soma.job())?.decisions.filter((each) => each.action === "answered")).toEqual([]);
	soma.off();
});

test("the model's pending wake with another prompt on the window's screen: refused stale, and no key is pressed", async () => {
	const soma = await core();
	await busy(soma, "ASK", "blocked");
	const { fingerprint } = await blockedOn(soma);
	await soma.say("看 card-a");
	const window = soma.blocks[0] as Block;
	window.records = [{ state: "blocked", kind: "permission", updated_at: "2026-10-27T01:02:09.000000+08:00" }];
	window.screen = fixture("claude-bash-prompt-2.1.302.txt");
	const before = soma.hangar.methods().filter((method) => method === "block.event").length;

	await soma.say(`選 card-a ${fingerprint}`);

	expect(soma.results.at(-1)).toEqual({ sent: false, refusal: "stale" });
	expect(soma.hangar.methods().filter((method) => method === "block.event")).toHaveLength(before);
	soma.off();
});

test("a block handed over before the move is forgotten, so an identical prompt in the window is handed over", async () => {
	const soma = await core({ opened: { records: [], screen: "$ claude --resume" } });
	await busy(soma, "ASK", "blocked");
	const status = await blockedOn(soma);
	await soma.say("看 card-a");
	expect(await soma.wakes()).toBe(1);

	await soma.bridge.handle({ agent: "card-a", status, seq: Number.MAX_SAFE_INTEGER });

	expect(await soma.wakes()).toBe(2);
	expect((await soma.job())?.handedOver).toEqual({ fingerprint: status.fingerprint, msg: status.msg });
	soma.off();
});

test("a window blocked as the move ends reaches the model as any block does", async () => {
	const blocked = { state: "blocked", kind: "permission", updated_at: "2026-10-27T01:02:05.000000+08:00" };
	const soma = await core({ opened: { records: [blocked], screen: fixture("claude-bash-prompt-2.1.302.txt") } });
	await busy(soma, "ASK", "blocked");

	await soma.say("看 card-a");

	await soma.until(async () => (await soma.wakes()) === 2, "the window's block to wake the model");
	expect((await soma.job())?.status.state).toBe("blocked");
	soma.off();
});

test("a job in its first turn is handed over: its brief is not sent again, nothing is recorded of it, and the next turn is", async () => {
	const soma = await core({ brief: "QUIET the word is KIWI", fake: { FAKE_ACP_MODEL: "fake-alias" } });
	await soma.say("派 card-a");
	await soma.until(async () => (await soma.job())?.status.state === "working", "the brief to run");
	await soma.until(async () => (await soma.job())?.launch === undefined, "the brief to go");
	await soma.until(async () => (await soma.agents.readResult("card-a")) !== undefined, "the brief to be written");
	const { acpSessionId } = await soma.entry();

	await soma.say("看 card-a");

	expect(soma.results.at(-1)).toMatchObject({ handedOver: true, sessionId: acpSessionId, cut: {} });
	expect(JSON.stringify(soma.windowsOpened()[0]?.payload)).toContain(`--resume ${acpSessionId} --model 'fake-alias'`);
	const notices = await soma.notices();
	expect(notices).toEqual([expect.stringContaining("its window is card-a in session hangar")]);
	expect(notices[0]).toContain(cutTurn);
	await sleep(50);
	const window = soma.blocks[0] as Block;
	const settled = { state: "idle", updated_at: "2026-10-27T01:02:09.000000+08:00" };
	window.records = [settled];
	soma.hangar.emit(soma.hangar.status(window.block, settled));
	await soma.until(async () => (await soma.job())?.seq === seqOf(settled), "the window's idle");
	await sleep(50);
	expect(await soma.turns()).toEqual([]);
	expect(await soma.notices()).toEqual(notices);
	expect(soma.typed()).toEqual([]);
	const job = await soma.job();
	expect(job).toMatchObject({ sessionId: acpSessionId, status: { state: "idle" } });
	expect(job?.launch).toBeUndefined();
	expect(job?.outcome).toBeUndefined();

	await soma.say("回覆 card-a go on");
	expect(soma.typed()).toEqual(["go on"]);
	await turn(soma, "結果：完成\nKIWI");
	await soma.until(async () => (await soma.job())?.outcome === "完成", "the window's turn");
	expect(await soma.turns()).toMatchObject([{ outcome: "完成" }]);
	soma.off();
});

test("a job just dispatched whose transcript holds no conversation yet is refused, and its brief goes on as if nothing was asked", async () => {
	const soma = await core({ brief: "UNWRITTEN the word is KIWI", fake: { FAKE_ACP_MODEL: "fake-alias" } });
	await soma.say("派 card-a");
	await soma.until(async () => (await soma.job())?.status.state === "working", "the brief to run");
	const { acpSessionId, cwd } = await soma.entry();
	const written = join(soma.acp.cwd, "..", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${acpSessionId}.jsonl`);
	await soma.until(async () => (await readFile(written, "utf8").catch(() => "")) !== "", "claude's first record");

	await soma.say("看 card-a");

	expect(soma.results.at(-1)).toMatchObject({ handedOver: false, refusal: "cannot_resume" });
	expect(await soma.cancelled()).toBe("");
	expect(soma.windowsOpened()).toEqual([]);
	expect(await soma.notices()).toEqual([]);
	expect((await soma.job())?.status.state).toBe("working");
	soma.off();
});

test("a turn that does not stop in time: refused with the reason, nothing closed or opened, working, and no notice", async () => {
	const soma = await core({ cutMs: 50 });
	const { turns, told } = await busy(soma, "HANG");
	const [pid] = await soma.pids();

	await soma.say("看 card-a");

	expect(soma.results.at(-1)).toEqual({
		handedOver: false,
		refusal: "not_at_rest",
		reason: expect.stringContaining("did not stop"),
	});
	expect(await soma.closed()).toBe("");
	expect(soma.windowsOpened()).toEqual([]);
	expect(alive(pid as number)).toBe(true);
	expect((await soma.entry()).handingOver).toBeUndefined();
	expect((await soma.job())?.status.state).toBe("working");
	expect(await soma.turns()).toEqual(turns);
	expect(await soma.notices()).toEqual(told);
	soma.off();
});

test("blocked, with a turn that does not stop: refused, and the job is working with the block forgotten, its wake answering nothing", async () => {
	const soma = await core({ cutMs: 50 });
	await busy(soma, "ASKHANG", "blocked");
	const { fingerprint } = await blockedOn(soma);

	await soma.say("看 card-a");

	expect(soma.results.at(-1)).toMatchObject({ handedOver: false, refusal: "not_at_rest" });
	await soma.until(async () => (await soma.job())?.status.state === "working", "the job no longer blocked");
	expect((await soma.job())?.handedOver).toBeUndefined();
	await soma.say(`選 card-a ${fingerprint}`);
	expect(soma.results.at(-1)).toEqual({ sent: false, refusal: "not_blocked" });
	soma.off();
});

test("a cancelled turn that stops after the refusal: idle, recorded with no outcome read off its partial text, and no notice", async () => {
	const soma = await core({ cutMs: 20, fake: { FAKE_ACP_STOP_MS: "150" } });
	const { turns, told } = await busy(soma, "SPIN");

	await soma.say("看 card-a");
	expect(soma.results.at(-1)).toMatchObject({ handedOver: false, refusal: "not_at_rest" });

	await soma.until(async () => (await soma.job())?.status.state === "idle", "the turn to stop");
	await soma.until(async () => (await soma.turns()).length > turns.length, "the turn's end");
	expect((await soma.turns()).slice(turns.length)).toMatchObject([{ outcome: "未知", notified: false }]);
	expect((await soma.job())?.outcome).toBe("未知");
	expect(await soma.notices()).toEqual(told);
	soma.off();
});

test("a turn that ends by itself as the cancel goes out: refused, with nothing cut, and recorded with the outcome it states", async () => {
	const soma = await core();
	const { turns } = await busy(soma, "FINISH");

	await soma.say("看 card-a");

	const told = soma.results.at(-1) as object;
	expect(told).toMatchObject({ handedOver: false, refusal: "not_at_rest" });
	expect(told).not.toHaveProperty("cut");
	await soma.until(async () => (await soma.job())?.outcome === "完成", "the turn it finished");
	expect((await soma.turns()).slice(turns.length)).toMatchObject([{ outcome: "完成" }]);
	expect(counted(await soma.notices(), "moved to rex")).toBe(0);
	await soma.say("看 card-a");
	expect(soma.results.at(-1)).toMatchObject({ handedOver: true });
	expect(soma.results.at(-1)).not.toHaveProperty("cut");
	soma.off();
});

test("a job blocked on a login is refused, with nothing cancelled and the human's question standing", async () => {
	const soma = await core();
	await busy(soma, "AUTH", "blocked");
	const before = await soma.job();

	await soma.say("看 card-a");

	expect(soma.results.at(-1)).toMatchObject({
		handedOver: false,
		refusal: "not_at_rest",
		reason: expect.stringContaining("is blocked on a login"),
	});
	expect(await soma.cancelled()).toBe("");
	expect(await soma.job()).toEqual(before);
	soma.off();
});

test("a working job a deferral holds is refused, with nothing cancelled, and goes on over ACP", async () => {
	const soma = await core();
	await busy(soma, "SPIN");
	await soma.defer("PT1H", "later");

	await soma.say("看 card-a");

	expect(soma.results.at(-1)).toMatchObject({ handedOver: false, refusal: "not_at_rest" });
	expect(await soma.cancelled()).toBe("");
	expect(soma.windowsOpened()).toEqual([]);
	expect((await soma.job())?.status.state).toBe("working");
	soma.off();
});

/** The rex side refuses the window plainly, or as a client that gave up on it, with nothing opened. */
function failsWindow(soma: Soma, failure: Error) {
	const original = soma.hangar.client.call.bind(soma.hangar.client);
	soma.hangar.client.call = async (method, payload, schema) => {
		if (method === "session.new_window") throw failure;
		return original(method, payload, schema);
	};
}

test("a turn cut and a window rex refuses: the turn is over, told once with why, and the job goes on on ACP", async () => {
	const soma = await core();
	const { turns } = await busy(soma, "SPIN");
	failsWindow(soma, new RexRpcError("session.new_window", "refused", "no window for you", 400));

	await soma.say("看 card-a");

	const told = soma.results.at(-1) as object;
	expect(told).toMatchObject({ handedOver: false, refusal: "cannot_resume", cut: {} });
	expect(told).not.toHaveProperty("back");
	const notices = await soma.notices();
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain(cutTurn);
	expect(notices[0]).toContain("no window for you");
	expect(notices[0]).toContain("stays on ACP");
	expect(await soma.job()).toMatchObject({ status: { state: "done", msg: expect.any(String) }, outcome: "未知" });
	expect((await soma.turns()).slice(turns.length)).toMatchObject([{ outcome: "未知", notified: true }]);
	await soma.say("回覆 card-a RECALL");
	expect(soma.results.at(-1)).toEqual({ sent: true });

	const next = await again(soma);
	await sleep(50);
	expect(counted(await next.notices(), backOnAcp)).toBe(0);
	next.off();
});

test("a turn cut and a take that gave up: told once, then where the job ended without telling the cut again", async () => {
	const clock = fakeClock();
	const soma = await core({ clock });
	const { turns } = await busy(soma, "SPIN");
	failsWindow(soma, new RexTransportError("no response within 10000 ms"));

	await soma.say("看 card-a");

	expect(soma.results.at(-1)).toMatchObject({
		handedOver: false,
		cut: {},
		reason: expect.stringContaining("undecided"),
	});
	expect(await soma.notices()).toEqual([expect.stringContaining(cutTurn)]);
	expect((await soma.job())?.status.state).toBe("done");
	clock.advance(60_000);
	await soma.agents.list();

	await soma.until(async () => counted(await soma.notices(), backOnAcp) === 1, "the notice of the return");
	expect(counted(await soma.notices(), cutTurn)).toBe(1);
	expect((await soma.turns()).slice(turns.length)).toHaveLength(1);
	soma.off();
});

test("a turn cut and a mark that will not write: the turn is over, told once with why, and the job sits idle on ACP", async () => {
	const soma = await core();
	const { turns } = await busy(soma, "SPIN");
	const [pid] = await soma.pids();
	await mkdir(`${soma.acp.sessionsFile}.tmp`);

	await soma.say("看 card-a");

	expect(soma.results.at(-1)).toMatchObject({ handedOver: false, refusal: "cannot_resume", cut: {} });
	const notices = await soma.notices();
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain(cutTurn);
	expect(notices[0]).toContain("could not be recorded");
	expect(alive(pid as number)).toBe(true);
	expect(await soma.closed()).toBe("");
	expect((await soma.turns()).slice(turns.length)).toMatchObject([{ outcome: "未知", notified: true }]);
	await soma.until(async () => (await soma.job())?.status.state === "idle", "the idle the turn ended on");
	await sleep(50);
	expect(await soma.notices()).toEqual(notices);
	expect((await soma.turns()).slice(turns.length)).toHaveLength(1);
	await rmdir(`${soma.acp.sessionsFile}.tmp`);
	soma.off();
});

test("a plain refusal gives a done job back, told by the refusal: no restart tells it again", async () => {
	const soma = await core();
	await dispatched(soma);
	failsWindow(soma, new RexRpcError("session.new_window", "refused", "no window for you", 400));

	await soma.say("看 card-a");

	expect(soma.results.at(-1)).toMatchObject({
		handedOver: false,
		reason: expect.stringContaining("stays on ACP"),
	});
	expect(await soma.notices()).toEqual([]);
	const next = await again(soma);
	await sleep(50);
	expect(await next.notices()).toEqual([]);
	next.off();
});

test("a plain refusal whose soma dies before anything records it: the next one tells the return, once", async () => {
	const soma = await core();
	await dispatched(soma);
	failsWindow(soma, new RexRpcError("session.new_window", "refused", "no window for you", 400));
	soma.off();
	await soma.agents.handOver("card-a");

	const next = await again(soma);

	expect(await next.notices()).toEqual([expect.stringContaining(backOnAcp)]);
	const last = await again(next);
	await sleep(50);
	expect(await last.notices()).toEqual([expect.stringContaining(backOnAcp)]);
	last.off();
});

const interrupted = "被重啟打斷";

test.each([
	["working", "SPIN", "working"],
	["blocked", "ASK", "blocked"],
] as const)(
	"a job %s killed after the cancel and before the mark: dormant with a cut turn, told by the restart's notice",
	async (_name, prompt, state) => {
		const first = await core({ from: (port) => ({ ...port, release: () => new Promise(() => {}) }) });
		const { turns, before } = await busy(first, prompt, state);
		const from = first.acp.events.length;
		void first.agents.handOver("card-a");
		await first.acp.until("idle", from);
		await sleep(50);
		// What the cancelled turn emitted reached the core as nothing.
		expect((await first.job())?.status.state).toBe(state);
		expect(await first.cancelled()).not.toBe("");
		expect((await first.entry()).handingOver).toBeUndefined();

		const soma = await again(first, { from: (port) => port });

		const notices = await soma.notices();
		expect(notices).toEqual([expect.stringContaining(interrupted)]);
		expect(await soma.agents.dormant()).toEqual(["card-a"]);
		expect(await soma.agents.list()).toEqual([{ name: "card-a", sessionId: before?.sessionId }]);
		expect(await soma.pids()).toEqual([]);
		expect(await soma.job()).toMatchObject({ status: { state: "done", msg: expect.any(String) }, outcome: "未知" });
		expect((await soma.job())?.handedOver).toBeUndefined();
		expect((await soma.turns()).slice(turns.length)).toMatchObject([{ outcome: "未知", notified: true }]);
		expect(soma.windowsOpened()).toEqual([]);
		await soma.say("回覆 card-a RECALL");
		expect(soma.results.at(-1)).toEqual({ sent: true });
		soma.off();
	},
);

test("a job killed after the mark with no window, past the grace period: dormant with a cut turn, told once by the restart's notice", async () => {
	const first = await core({ to: (port) => ({ ...port, take: () => new Promise(() => {}) }) });
	const { turns } = await busy(first, "SPIN");
	void first.agents.handOver("card-a");
	await first.until(async () => (await first.entry()).handingOver === true, "the mark");

	const soma = await again(first, { to: (port) => port });

	expect(await soma.notices()).toEqual([expect.stringContaining(interrupted)]);
	expect((await soma.entry()).handingOver).toBeUndefined();
	expect((await soma.turns()).slice(turns.length)).toMatchObject([{ outcome: "未知", notified: true }]);
	const next = await again(soma);
	await sleep(50);
	expect(counted(await next.notices(), backOnAcp)).toBe(0);
	next.off();
});

test("a job killed after the mark with no window, within the grace period: undecided, then back on ACP with its cut told once", async () => {
	const clock = fakeClock();
	const first = await core({ clock, to: (port) => ({ ...port, take: () => new Promise(() => {}) }) });
	const { turns } = await busy(first, "SPIN");
	void first.agents.handOver("card-a");
	await first.until(async () => (await first.entry()).handingOver === true, "the mark");

	const soma = await again(first, { clock, to: (port) => port });

	expect(await soma.notices()).toEqual([]);
	expect((await soma.entry()).handingOver).toBe(true);
	clock.advance(60_000);
	await soma.agents.list();
	await soma.until(async () => counted(await soma.notices(), backOnAcp) === 1, "the notice of the return");
	const notices = await soma.notices();
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain(cutTurn);
	expect(await soma.job()).toMatchObject({ status: { state: "done", msg: expect.any(String) }, outcome: "未知" });
	expect((await soma.turns()).slice(turns.length)).toMatchObject([{ outcome: "未知", notified: true }]);
	soma.off();
});

test.each([
	["before the final mark", (first: Soma) => hangsAfterWindow(first)],
	["after the final mark, before the commit", (first: Soma) => first.off()],
])(
	"a job killed with its window open, %s: on rex, told once with the cut, and no turn recorded of it",
	async (_name, arrange) => {
		const first = await core();
		const { turns, before } = await busy(first, "SPIN");
		const { acpSessionId } = await first.entry();
		arrange(first);
		const moving = first.agents.handOver("card-a");
		await first.until(() => first.blocks.length === 1, "the window");
		await Promise.race([moving, sleep(50)]);
		expect((await first.job())?.status.state).toBe("working");

		const soma = await again(first);

		await toldOnRexOnce(soma, acpSessionId);
		const notices = await soma.notices();
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("Its handover was cut short and ended there");
		expect(notices[0]).toContain(cutTurn);
		await sleep(50);
		expect(await soma.turns()).toEqual(turns);
		const job = await soma.job();
		expect(job?.outcome).toBe(before?.outcome);
		expect(job?.status.state).toBe("idle");
		expect(job?.resultId).toBe((await soma.agents.readResult("card-a"))?.id);
		await soma.say("回覆 card-a go on");
		await turn(soma, "結果：完成\nKIWI");
		await soma.until(async () => (await soma.job())?.outcome === "完成", "the window's turn");
		soma.off();
	},
);

test("a blocked job killed with its window open: told once, with the cancelled prompt quoted from what it was last recorded", async () => {
	const first = await core();
	await busy(first, "ASK", "blocked");
	hangsAfterWindow(first);
	void first.agents.handOver("card-a");
	await first.until(() => first.blocks.length === 1, "the window");

	const soma = await again(first);

	await soma.until(async () => (await soma.notices()).length === 1, "the notice of the move");
	const [notice] = await soma.notices();
	expect(notice).toContain("its window is card-a");
	expect(notice).toContain(prompted);
	expect(notice).not.toContain("1. Yes");
	expect((await soma.job())?.handedOver).toBeUndefined();
	soma.off();
});

test("a job never handed over reaches rex in no way when a handover of another job cuts its turn", async () => {
	const soma = await core();
	await busy(soma, "SPIN");
	await soma.say("派 card-b");
	await soma.until(async () => (await soma.job("card-b"))?.outcome !== undefined, "the brief's turn");

	await soma.say("看 card-a");

	expect(soma.results.at(-1)).toMatchObject({ handedOver: true });
	expect(soma.windowsOpened()).toHaveLength(1);
	expect((await soma.entry("card-b")).handingOver).toBeUndefined();
	expect((await soma.entry("card-b")).handedOver).toBeUndefined();
	expect(await soma.cancelled()).toBe(`${(await soma.entry()).acpSessionId}\n`);
	await soma.say("回覆 card-b over ACP");
	expect(soma.results.at(-1)).toEqual({ sent: true });
	expect(soma.typed()).toEqual([]);
	soma.off();
});

/** Rex answers no `session.new_window` from now on, and opens its window all the same. */
function hangsAfterWindow(soma: Soma): void {
	const original = soma.hangar.client.call.bind(soma.hangar.client);
	soma.hangar.client.call = async (method, payload, schema) => {
		const reply = await original(method, payload, schema);
		if (method === "session.new_window") await new Promise(() => {});
		return reply;
	};
}

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
