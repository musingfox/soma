import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import type { Job } from "../../../src/core/domain/dispatch.ts";
import {
	AGENT_BLOCKED,
	eventBridge,
	JOB_DONE,
	reconcileDispatches,
} from "../../../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../../../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../../../src/core/harness.ts";
import { NOTICE } from "../../../src/core/notice.ts";
import type { AgentPort } from "../../../src/ports/agent.ts";
import { harness as acpHarness, cleanUp, sleep } from "./fake.ts";

const context = BACKGROUND_CONTEXT;
const open: Harness[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
	await cleanUp();
});

/**
 * The real core over the ACP adapter running the fake agent, with a faux model that dispatches on 「派 <card>」, sends
 * 「回覆 <card> <text>」 with reply, reads 「看 <card>」 with screen, and answers a wake that offers a fingerprint with
 * option 1. `brief` is the card the agent is given, or each card's; `results` holds every tool result the model was
 * handed. With `startLate`, the core's `start` returns that many ms after the adapter's did, so it lists the job that
 * much later. Given `restartOf`, the cwd of another core's adapter, it is that soma restarted on the same db and
 * sessions file. It starts as main.ts does: the reconcile, told which agents the adapter lists dormant, then the bridge.
 */
async function core(
	brief: string | ((card: string) => string),
	fake: Record<string, string> = {},
	startLate = 0,
	restartOf?: string,
) {
	// session/new takes a while, as claude's CLI start does, so the job is listed before its first idle.
	const acp = await acpHarness({ fake: { FAKE_ACP_NEW_MS: "200", ...fake }, cwd: restartOf });
	const port: AgentPort = {
		...acp.port,
		start: async (request) => {
			await acp.port.start(request);
			await sleep(startLate);
		},
	};
	const results: string[] = [];
	const faux = fauxProvider();
	faux.setResponses(
		Array.from({ length: 30 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
			const last = request.messages.at(-1);
			const text = JSON.stringify(last?.content ?? "");
			if (last?.role === "toolResult") {
				results.push(text);
				return fauxAssistantMessage("好。");
			}
			const fingerprint = /fingerprint=([0-9a-f]{16})/.exec(text)?.[1];
			const [, verb, card = "", rest = ""] = /(派|回覆|看) ([a-z0-9-]+) ?([^"]*)/.exec(text) ?? [];
			const call = (name: string, args: Record<string, string>) =>
				fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
			if (fingerprint !== undefined) {
				return call("respond", { card: "card-a", option: "1", fingerprint, reason: "the test approves it" });
			}
			if (verb === "派") return call("dispatch", { card, repo: acp.cwd });
			if (verb === "回覆") return call("reply", { card, text: rest, reason: "the human answered" });
			if (verb === "看") return call("screen", { card });
			return fauxAssistantMessage("好。");
		}),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await openHarness(
		join(acp.cwd, "..", "soma.sqlite"),
		[dispatchExtension(port, async (_repo, card) => `# ${card}\n\n${typeof brief === "string" ? brief : brief(card)}`)],
		context,
		{ models },
	);
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	await reconcileDispatches(root, acp.port, context, await acp.port.dormant());
	const off = eventBridge(root, acp.port, context).listen((error) => {
		throw error;
	});
	const job = async (agent = "card-a") =>
		(await harness.snapshot(Dispatches, root.id, context))?.jobs.find((each) => each.agent === agent);
	const entries = async (kind: string) =>
		(await root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter((entry) => entry.kind === kind);
	const say = async (content: string) => {
		const submission = await root.submit({ type: "input", content, requestId: `t:${content}` }, context);
		expect((await submission.wait(context)).status).toBe("done");
	};
	/** Waits until the job matches `ok`, and then until the model is idle. */
	const until = async (ok: (found: Job | undefined) => boolean | Promise<boolean>, ms = 10_000, agent = "card-a") => {
		for (const deadline = Date.now() + ms; ; await sleep(20)) {
			const found = await job(agent);
			if (await ok(found)) {
				await root.waitForIdle(context);
				return found;
			}
			if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(found)}`);
		}
	};
	const transcript = async () => {
		const projects = join(acp.cwd, "..", "projects");
		const [directory] = (await readdir(projects)).filter((name) => name.startsWith("-"));
		const [file] = await readdir(join(projects, directory as string));
		const text = await readFile(join(projects, directory as string, file as string), "utf8");
		return text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; message: { content: unknown } });
	};
	/** soma's exit: the bridge stops, the db closes, and the agents end, recording nothing. */
	const end = async () => {
		off();
		open.splice(open.indexOf(harness), 1);
		await harness.close(context);
		await acp.end();
	};
	/** The agent processes this soma's adapter ran, by the name each ran for. */
	const spawned = async () =>
		(await readFile(join(acp.cwd, "..", `pids-${acp.instance}`), "utf8").catch(() => ""))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => line.split(" ")[0]);
	return {
		acp,
		root,
		job,
		entries,
		say,
		until,
		transcript,
		results,
		calls: () => faux.state.callCount,
		off,
		end,
		spawned,
	};
}

test("dispatch starts a job over ACP, the bridge sends the brief, the model answers its permission request, and the turn is recorded", async () => {
	const soma = await core("ASK");
	await soma.say("派 card-a");
	const job = await soma.until((found) => found?.outcome !== undefined);

	const [first] = await soma.transcript();
	expect(first).toMatchObject({
		type: "user",
		message: { content: expect.stringMatching(/以下是任務卡：\n\n# card-a\n\nASK$/) },
	});
	expect(job).toMatchObject({
		status: { state: "done" },
		outcome: "完成",
		decisions: [{ kind: "permission", action: "answered", option: "1", reason: "the test approves it" }],
	});
	expect(job?.launch).toBeUndefined();
	const [wake] = await soma.entries(AGENT_BLOCKED);
	expect(wake).toBeDefined();
	expect(await soma.entries(JOB_DONE)).toMatchObject([
		{ data: { agent: "card-a", card: "card-a", state: "done", outcome: "完成" } },
	]);
	expect((await soma.acp.port.readResult("card-a"))?.text).toBe("結果：完成\npermission allow-once");
	soma.off();
});

test("a job the core lists only after the session's first idle still gets its brief", async () => {
	// start returns after initialize; the session opens 200 ms later, before the core lists the job.
	const soma = await core("hello", {}, 300);
	await soma.say("派 card-a");
	const job = await soma.until((found) => found?.outcome !== undefined);
	expect(job?.launch).toBeUndefined();
	const [first] = await soma.transcript();
	expect(first).toMatchObject({
		type: "user",
		message: { content: expect.stringMatching(/以下是任務卡：\n\n# card-a\n\nhello$/) },
	});
	// The idle resent is the observation the job took the brief at, so it records no turn.
	expect(await soma.entries(JOB_DONE)).toMatchObject([{ data: { state: "done" } }]);
	soma.off();
});

test("reply sends a done job its next prompt, and screen reads its transcript", async () => {
	const soma = await core("hello");
	await soma.say("派 card-a");
	await soma.until((found) => found?.outcome !== undefined);
	await soma.say("回覆 card-a 結果：完成 please");
	await soma.until((found) => found?.status.state === "done" && found.decisions.length === 1);
	await soma.until(async () => (await soma.entries(JOB_DONE)).length === 2);
	const [launched, replied] = await soma.entries(JOB_DONE);
	expect(launched).toMatchObject({ data: { state: "done", outcome: "未知" } });
	expect(replied).toMatchObject({ data: { state: "done", outcome: "未知" } });
	const seqOf = (entry: typeof launched) => (entry?.data as { seq?: number } | undefined)?.seq ?? 0;
	expect(seqOf(replied)).toBeGreaterThan(seqOf(launched));
	expect((await soma.acp.port.readResult("card-a"))?.text).toBe("echo: 結果：完成 please");
	expect((await soma.job())?.decisions).toMatchObject([{ action: "replied", text: "結果：完成 please" }]);

	await soma.say("看 card-a");
	expect(soma.results.at(-1)).toContain("> 結果：完成 please");
	expect(soma.results.at(-1)).toContain("● echo: 結果：完成 please");
	soma.off();
});

test("a prompt refused for want of a login reaches the human as a configuration error, not as a failed job", async () => {
	const soma = await core("AUTH", { USER: "" });
	await soma.say("派 card-a");
	const job = await soma.until((found) => found?.status.state === "blocked");
	expect(job?.status).toMatchObject({ state: "blocked", kind: "auth" });
	expect(job?.decisions).toMatchObject([{ kind: "auth", action: "escalated" }]);
	const questions = (await soma.entries(NOTICE)).filter(
		(entry) => (entry.data as { kind?: string } | undefined)?.kind === "question",
	);
	expect(questions).toHaveLength(1);
	expect(JSON.stringify(questions[0]?.data)).toMatch(/configuration error.*HOME=\/home\/someone and USER=unset/);
	expect(await soma.entries(JOB_DONE)).toEqual([]);
	// The dispatch only: the model was not woken for it.
	expect(soma.calls()).toBe(2);
	soma.off();
});

const contentOf = (entry: { data?: unknown }) => (entry.data as { content: string }).content;

/** The notices of a restart that left jobs dormant. */
const restartNotices = async (soma: Awaited<ReturnType<typeof core>>) =>
	(await soma.entries(NOTICE)).filter((entry) => contentOf(entry).startsWith("soma 重新啟動後"));

test("a job soma restarted takes no second brief, and a reply wakes it in its session, seeing what was said before", async () => {
	const first = await core("hello");
	await first.say("派 card-a");
	const sent = await first.until((found) => found?.outcome !== undefined);
	// The crash this stands in for: the brief went, the commit that lets go of it never landed.
	await first.root.commit(async (tx) => {
		const doc = await tx.doc(Dispatches, first.root.id);
		doc.jobs = doc.jobs.map((job) => ({ ...job, launch: "以下是任務卡：\n\n# card-a\n\nhello" }));
	}, context);
	await first.end();

	const second = await core("hello", {}, 0, first.acp.cwd);
	await sleep(300);
	expect(await second.spawned()).toEqual([]);
	expect(await second.job()).toMatchObject({ status: sent?.status, seq: sent?.seq, outcome: sent?.outcome });

	await second.say("回覆 card-a RECALL");
	await second.until(async () => (await second.entries(JOB_DONE)).length === 2);
	// The brief as the first soma sent it, its rules first, and only once.
	expect((await second.acp.port.readResult("card-a"))?.text).toMatch(
		/^recall: .*以下是任務卡：\n\n# card-a\n\nhello$/s,
	);
	expect((await second.transcript()).filter((record) => record.type === "user")).toHaveLength(2);
	expect((await second.job())?.launch).toBeUndefined();
	expect(await second.spawned()).toEqual(["card-a"]);
	second.off();
});

test("a job done or failed before the restart keeps its status and message, records no turn and is not told of", async () => {
	const first = await core((card) => (card === "card-b" ? "EXIT" : "hello"));
	await first.say("派 card-a");
	const done = await first.until((found) => found?.outcome !== undefined);
	await first.say("派 card-b");
	const failed = await first.until((found) => found?.status.state === "error", 10_000, "card-b");
	expect(failed?.status.msg).toMatch(/^claude-agent-acp exited with code 3/);
	const turns = (await first.entries(JOB_DONE)).length;
	const notices = (await first.entries(NOTICE)).length;
	await first.end();

	const second = await core("hello", {}, 0, first.acp.cwd);
	expect(await second.acp.port.dormant()).toEqual(["card-a", "card-b"]);
	expect(await second.job("card-a")).toEqual(done);
	expect(await second.job("card-b")).toEqual(failed);
	expect(await second.entries(JOB_DONE)).toHaveLength(turns);
	expect(await second.entries(NOTICE)).toHaveLength(notices);
	second.off();
});

test("a working job's cut turn is recorded over once, an idle one comes back too, and each restart tells the human once", async () => {
	const briefs: Record<string, string> = { "card-a": "HANG", "card-c": "hello", "card-d": "CANCEL" };
	const first = await core((card) => briefs[card] ?? "hello");
	await first.say("派 card-c");
	await first.until((found) => found?.outcome !== undefined, 10_000, "card-c");
	await first.say("派 card-d");
	await first.until((found) => found?.status.state === "idle" && found.outcome !== undefined, 10_000, "card-d");
	await first.say("派 card-a");
	await first.until((found) => found?.status.state === "working");
	while (!(await first.acp.port.readScreen("card-a")).includes("HANG")) await sleep(10);
	const done = await first.job("card-c");
	const idle = await first.job("card-d");
	expect(await first.entries(JOB_DONE)).toHaveLength(2);
	await first.end();

	const second = await core("hello", {}, 0, first.acp.cwd);
	expect(await second.job()).toMatchObject({
		status: { state: "done", msg: "the turn was cut short when soma restarted" },
		outcome: "未知",
	});
	expect(await second.job("card-c")).toEqual(done);
	expect(await second.job("card-d")).toEqual(idle);
	expect((await second.entries(JOB_DONE)).map((entry) => entry.data)).toEqual([
		expect.objectContaining({ agent: "card-c" }),
		expect.objectContaining({ agent: "card-d" }),
		{ agent: "card-a", card: "card-a", state: "done", outcome: "未知", notified: true },
	]);
	const [told, ...more] = await restartNotices(second);
	expect(more).toEqual([]);
	expect(told?.data).toMatchObject({ kind: "report", class: "action" });
	expect(contentOf(told ?? {})).toBe(
		"soma 重新啟動後，2 件工作的 agent 停著，session 都還在：agent card-d（卡片 card-d）、agent card-a（卡片 card-a）。" +
			"回覆其中一件，它就在原本的 session 裡接著做，之前的對話都還在。" +
			"其中 agent card-a（卡片 card-a）正在做的那一輪被重啟打斷了，沒有做完；要它接著做，就回覆它。",
	);
	expect(await second.spawned()).toEqual([]);
	await second.end();

	// Nothing ran since: the idle job is told of again, the cut turn is not recorded again.
	const third = await core("hello", {}, 0, first.acp.cwd);
	expect(await third.entries(JOB_DONE)).toHaveLength(3);
	const notices = await restartNotices(third);
	expect(notices).toHaveLength(2);
	expect(notices[1]?.data).toMatchObject({ kind: "report", class: "ambient" });
	expect(contentOf(notices[1] ?? {})).toBe(
		"soma 重新啟動後，1 件工作的 agent 停著，session 都還在：agent card-d（卡片 card-d）。" +
			"回覆其中一件，它就在原本的 session 裡接著做，之前的對話都還在。沒有哪一輪被重啟打斷。",
	);
	// Stopped by soma, it is not listed again, and a restart that leaves no unfinished job dormant tells nothing.
	await third.acp.port.stop("card-d");
	await third.end();
	const fourth = await core("hello", {}, 0, first.acp.cwd);
	expect(await fourth.acp.port.dormant()).toEqual(["card-c", "card-a"]);
	expect(await restartNotices(fourth)).toHaveLength(2);
	// The stop went behind the core's back, so card-d is gone; the cut turn is still recorded once.
	expect((await fourth.entries(JOB_DONE)).map((entry) => entry.data)).toEqual([
		expect.objectContaining({ agent: "card-c" }),
		expect.objectContaining({ agent: "card-d" }),
		expect.objectContaining({ agent: "card-a", outcome: "未知" }),
		expect.objectContaining({ agent: "card-d", state: "error", outcome: "失敗" }),
	]);
	fourth.off();
});

test("a job blocked on a permission request at the restart has its cut turn recorded over once, and is named cut", async () => {
	// The faux model answers the wake for card-a, which has no job, so card-b stays blocked.
	const first = await core("ASK");
	await first.say("派 card-b");
	const blocked = await first.until((found) => found?.status.state === "blocked", 10_000, "card-b");
	expect(blocked?.status).toMatchObject({ kind: "permission" });
	expect(blocked?.handedOver).toBeDefined();
	await first.end();

	const second = await core("hello", {}, 0, first.acp.cwd);
	const job = await second.job("card-b");
	expect(job).toMatchObject({ status: { state: "done" }, outcome: "未知" });
	expect(job?.handedOver).toBeUndefined();
	expect((await second.entries(JOB_DONE)).map((entry) => entry.data)).toEqual([
		{ agent: "card-b", card: "card-b", state: "done", outcome: "未知", notified: true },
	]);
	const [told, ...more] = await restartNotices(second);
	expect(more).toEqual([]);
	expect(told?.data).toMatchObject({ kind: "report", class: "action" });
	expect(contentOf(told ?? {})).toMatch(/其中 agent card-b（卡片 card-b）正在做的那一輪被重啟打斷了/);
	await second.end();

	const third = await core("hello", {}, 0, first.acp.cwd);
	expect(await third.entries(JOB_DONE)).toHaveLength(1);
	expect(await restartNotices(third)).toHaveLength(1);
	third.off();
});

test("a job blocked for want of a login at the restart keeps its block, records no turn, and is named but not cut", async () => {
	// The brief ran, so the session has a transcript; the reply is refused for the login before claude writes it.
	const first = await core("hello");
	await first.say("派 card-a");
	await first.until((found) => found?.outcome !== undefined);
	await first.say("回覆 card-a AUTH");
	const blocked = await first.until((found) => found?.status.state === "blocked");
	expect(blocked?.status).toMatchObject({ state: "blocked", kind: "auth" });
	const turns = await first.entries(JOB_DONE);
	await first.end();

	const second = await core("hello", {}, 0, first.acp.cwd);
	expect(await second.acp.port.dormant()).toEqual(["card-a"]);
	expect(await second.job()).toEqual(blocked);
	expect(await second.entries(JOB_DONE)).toEqual(turns);
	const [told, ...more] = await restartNotices(second);
	expect(more).toEqual([]);
	expect(told?.data).toMatchObject({ kind: "report", class: "ambient" });
	expect(contentOf(told ?? {})).toBe(
		"soma 重新啟動後，1 件工作的 agent 停著，session 都還在：agent card-a（卡片 card-a）。" +
			"回覆其中一件，它就在原本的 session 裡接著做，之前的對話都還在。沒有哪一輪被重啟打斷。",
	);
	second.off();
});

test("a reply to a dormant job whose session cannot be loaded ends the job error with the reason", async () => {
	const first = await core("hello");
	await first.say("派 card-a");
	await first.until((found) => found?.outcome !== undefined);
	await first.end();

	const second = await core("hello", { FAKE_ACP_LOAD_EXIT: "card-a" }, 0, first.acp.cwd);
	await second.say("回覆 card-a RECALL");
	const job = await second.until((found) => found?.status.state === "error");
	expect(job?.status.msg).toMatch(/^session\/load of ACP session .* failed: .*; the process exited with code 4$/);
	expect(second.results.at(-1)).toContain("is not woken");
	expect(second.acp.errors.map((error) => error.message)).toEqual([`agent card-a is not woken: ${job?.status.msg}`]);
	second.off();
});

test("an unfinished job whose brief never ran is reported gone, as before, and nothing tells of it coming back", async () => {
	// The prompt is refused before claude writes it, so the session has no transcript.
	const first = await core("AUTH");
	await first.say("派 card-a");
	await first.until((found) => found?.status.state === "blocked");
	await first.end();

	const second = await core("hello", {}, 0, first.acp.cwd);
	expect(await second.job()).toMatchObject({ status: { state: "error", msg: "agent is gone" } });
	expect((await second.entries(NOTICE)).map(contentOf).at(-1)).toBe(
		"agent card-a（卡片 card-a）不見了，這件工作沒有做完。",
	);
	expect(await restartNotices(second)).toEqual([]);
	expect(second.acp.errors.map((error) => error.message)).toEqual([
		expect.stringMatching(/^agent card-a is not listed after the restart: .* has no transcript/),
	]);
	second.off();
});
