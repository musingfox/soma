import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { Deferrals, deferExtension } from "../../../src/core/extensions/defer/index.ts";
import { eventBridge, JOB_DONE, reconcileDispatches } from "../../../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../../../src/core/extensions/dispatch/index.ts";
import { reclaimer } from "../../../src/core/extensions/dispatch/reclaim.ts";
import { openHarness } from "../../../src/core/harness.ts";
import { NOTICE } from "../../../src/core/notice.ts";
import { harness as acpHarness, cleanUp, sleep } from "./fake.ts";

const context = BACKGROUND_CONTEXT;
const open: Harness[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
	await cleanUp();
});

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/**
 * The real core over the ACP adapter running the fake agent, started as main.ts starts it, with the defer extension and
 * a faux model that only dispatches on 「派 <card>」: `soma defer` arrives as the socket hands it to `defer`. Given
 * `restartOf`, the cwd of another core's adapter, it is that soma restarted on the same db and sessions file.
 */
async function core(
	brief: string,
	options: { fake?: Record<string, string>; restartOf?: string | undefined; cap?: number } = {},
) {
	const acp = await acpHarness({
		fake: { FAKE_ACP_NEW_MS: "50", ...options.fake },
		cwd: options.restartOf,
		cap: options.cap ?? 4,
	});
	const faux = fauxProvider();
	faux.setResponses(
		Array.from({ length: 20 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
			const last = request.messages.at(-1);
			if (last?.role === "toolResult") return fauxAssistantMessage("好。");
			const [, card] = /派 ([a-z0-9-]+)/.exec(JSON.stringify(last?.content ?? "")) ?? [];
			if (card === undefined) return fauxAssistantMessage("好。");
			return fauxAssistantMessage([fauxToolCall("dispatch", { card, repo: acp.cwd })], { stopReason: "toolUse" });
		}),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	let reconciled: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		reconciled = resolve;
	});
	const defers = deferExtension(acp.port, {
		pollMs: 20,
		readyMs: 5_000,
		reclaim: (agent) => ready.then(() => reclaimer(root, acp.port, context)(agent)),
	});
	const harness = await openHarness(
		join(acp.cwd, "..", "soma.sqlite"),
		[dispatchExtension(acp.port, async (_repo, card) => `# ${card}\n\n${brief}`), defers.extension],
		context,
		{ models },
	);
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	await reconcileDispatches(root, acp.port, context, await acp.port.dormant());
	reconciled();
	const off = eventBridge(root, acp.port, context).listen((error) => {
		// A status still being handled as the test ends finds the db closed.
		if (open.includes(harness)) throw error;
	});
	const job = async (agent = "card-a") =>
		(await harness.snapshot(Dispatches, root.id, context))?.jobs.find((each) => each.agent === agent);
	const entries = async (kind: string) =>
		(await root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter((entry) => entry.kind === kind);
	const turns = async () => (await entries(JOB_DONE)).map((entry) => entry.data as { agent: string; outcome: string });
	const pids = async () =>
		(await readFile(join(acp.cwd, "..", `pids-${acp.instance}`), "utf8").catch(() => ""))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => Number(line.split(" ")[1]));
	return {
		acp,
		root,
		job,
		pids,
		dispatch: async (card = "card-a") => {
			const submission = await root.submit({ type: "input", content: `派 ${card}`, requestId: `t:${card}` }, context);
			expect((await submission.wait(context)).status).toBe("done");
		},
		/** Waits until the job matches `ok`. */
		until: async (ok: (found: Awaited<ReturnType<typeof job>>) => boolean, agent = "card-a") => {
			for (const deadline = Date.now() + 10_000; ; await sleep(10)) {
				const found = await job(agent);
				if (ok(found)) return found;
				if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(found)}`);
			}
		},
		defer: async (at: string, instruction: string) => {
			const reply = await defers.defer(root, { agent: "card-a", at, instruction }, context);
			if (!reply.accepted) throw new Error(reply.reason);
			return reply.id;
		},
		outcome: async (id: string) => (await harness.waitForTask(Number(id) as TaskId, context)).state.outcome,
		pending: async () => Object.keys((await harness.snapshot(Deferrals, root.id, context))?.items ?? {}),
		turns,
		/** Waits until `count` turns are recorded in all. */
		recorded: async (count: number) => {
			for (const deadline = Date.now() + 5_000; (await turns()).length < count; await sleep(10)) {
				if (Date.now() > deadline) throw new Error(`no ${count} turns: ${JSON.stringify(await turns())}`);
			}
		},
		notices: async () => (await entries(NOTICE)).map((entry) => (entry.data as { content: string }).content),
		calls: () => faux.state.callCount,
		off,
		/** soma's exit: the bridge stops, the db closes, and the agents end, recording nothing. */
		end: async () => {
			off();
			open.splice(open.indexOf(harness), 1);
			await harness.close(context);
			await acp.end();
		},
		sessions: async () =>
			JSON.parse(await readFile(acp.sessionsFile, "utf8")) as Record<
				string,
				{ acpSessionId: string; cwd: string; stopped?: true }
			>,
		/** The text of every user record of card-a's transcript: what the agent was prompted with. */
		prompted: async () => {
			const projects = join(acp.cwd, "..", "projects");
			const [directory] = (await readdir(projects)).filter((name) => name.startsWith("-"));
			const [file] = await readdir(join(projects, directory as string));
			return (await readFile(join(projects, directory as string, file as string), "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { type: string; message: { content: string } })
				.filter((record) => record.type === "user")
				.map((record) => record.message.content);
		},
		loaded: () => readFile(join(acp.cwd, "..", "projects", "loaded"), "utf8").catch(() => ""),
	};
}

type Soma = Awaited<ReturnType<typeof core>>;

/** Dispatches a brief that takes a while, and defers while its turn runs, as an agent's own `soma defer` does. */
async function deferredInItsTurn(soma: Soma, at: string, instruction: string) {
	await soma.dispatch();
	await soma.until((found) => found?.status.state === "working");
	const id = await soma.defer(at, instruction);
	// At work, so it is not stopped under its own command.
	expect((await soma.job())?.reclaim).toEqual({ phase: "due" });
	expect((await soma.acp.port.list()).map(({ name }) => name)).toEqual(["card-a"]);
	await soma.until((found) => found?.reclaim?.phase === "stopped");
	return id;
}

const BRIEF = "the word is KIWI SLOW";

test("an agent that deferred in its turn is stopped once the turn is done and recorded, holding no slot and no process", async () => {
	const soma = await core(BRIEF, { cap: 1 });
	await deferredInItsTurn(soma, "PT1M", "RECALL");

	const [pid] = await soma.pids();
	for (const deadline = Date.now() + 5_000; alive(pid as number) && Date.now() < deadline; ) await sleep(10);
	expect(alive(pid as number)).toBe(false);
	expect((await soma.sessions())["card-a"]?.stopped).toBe(true);
	expect(await soma.acp.port.list()).toEqual([]);
	// Stopped, not lost: the turn it finished is the one recorded, and no exit is taken for a failure.
	await sleep(100);
	expect(await soma.job()).toMatchObject({ status: { state: "done" }, reclaim: { phase: "stopped" } });
	expect((await soma.job())?.status.msg).toBeUndefined();
	expect(await soma.turns()).toMatchObject([{ agent: "card-a" }]);
	expect(await soma.notices()).toEqual([]);

	// The one slot of the hangar is free for another job.
	await soma.dispatch("card-b");
	await soma.until((found) => found?.status.state === "done", "card-b");
	soma.off();
});

test("an agent already idle when it defers is stopped at once, and that records no turn", async () => {
	const soma = await core("CANCEL");
	await soma.dispatch();
	await soma.until((found) => found?.status.state === "idle" && found.outcome !== undefined);
	const turns = await soma.turns();
	expect(turns).toHaveLength(1);
	await soma.defer("PT1M", "RECALL");
	expect((await soma.job())?.reclaim).toEqual({ phase: "stopped" });
	expect((await soma.sessions())["card-a"]?.stopped).toBe(true);
	expect(await soma.acp.port.list()).toEqual([]);
	await sleep(100);
	expect(await soma.job()).toMatchObject({ status: { state: "idle" } });
	expect(await soma.turns()).toEqual(turns);
	soma.off();
});

test("at fire time a reclaimed agent is resumed in its session and answers the instruction from its earlier context", async () => {
	const soma = await core(BRIEF);
	const id = await deferredInItsTurn(soma, "PT2S", "RECALL");
	const calls = soma.calls();

	expect(await soma.outcome(id)).toEqual({ status: "completed", result: "sent" });
	await soma.until((found) => found?.status.state === "done" && found.reclaim === undefined);
	await soma.recorded(2);
	expect((await soma.acp.port.readResult("card-a"))?.text).toMatch(/^recall: .*the word is KIWI SLOW$/s);
	// Loaded once, in the session the brief ran in, whose mark is gone; the agent runs again, a process of its own.
	const { acpSessionId, cwd, stopped } = (await soma.sessions())["card-a"] ?? { acpSessionId: "", cwd: "" };
	expect(stopped).toBeUndefined();
	expect(await soma.loaded()).toBe(`${acpSessionId} ${cwd}\n`);
	const [before, after, ...more] = await soma.pids();
	expect(more).toEqual([]);
	expect(alive(before as number)).toBe(false);
	expect(alive(after as number)).toBe(true);
	// The brief and the instruction, each once; the two turns they made, and nothing else told; no model woken.
	const prompted = await soma.prompted();
	expect(prompted).toEqual([expect.stringContaining(BRIEF), expect.stringContaining("RECALL")]);
	expect(prompted[1]).toMatch(new RegExp(`^\\[soma deferred instruction ${id}\\] `));
	expect(await soma.turns()).toHaveLength(2);
	expect(await soma.notices()).toEqual([]);
	expect(soma.calls()).toBe(calls);
	soma.off();
});

test("across a restart a reclaimed agent stays stopped, not gone and not dormant, and the deferral resumes it on the new soma", async () => {
	const first = await core(BRIEF);
	const id = await deferredInItsTurn(first, "PT2S", "RECALL");
	const stoppedJob = await first.job();
	await first.end();

	const second = await core(BRIEF, { restartOf: first.acp.cwd });
	expect(await second.acp.port.dormant()).toEqual([]);
	expect(await second.pending()).toEqual([id]);
	expect(await second.job()).toEqual(stoppedJob);
	expect(await second.turns()).toHaveLength(1);
	expect(await second.notices()).toEqual([]);
	expect(await second.pids()).toEqual([]);
	expect(await second.loaded()).toBe("");

	expect(await second.outcome(id)).toEqual({ status: "completed", result: "sent" });
	await second.until((found) => found?.status.state === "done" && found.reclaim === undefined);
	await second.recorded(2);
	expect((await second.acp.port.readResult("card-a"))?.text).toMatch(/^recall: .*the word is KIWI SLOW$/s);
	expect((await second.sessions())["card-a"]?.stopped).toBeUndefined();
	expect(await second.pids()).toHaveLength(1);
	expect(await second.prompted()).toHaveLength(2);
	expect(await second.turns()).toHaveLength(2);
	expect(await second.notices()).toEqual([]);
	expect(second.calls()).toBe(0);
	second.off();
});

test("an agent stopped idle is not taken for gone at the restart, and its next turn is the only one recorded", async () => {
	const first = await core("CANCEL the word is KIWI");
	await first.dispatch();
	await first.until((found) => found?.status.state === "idle" && found.outcome !== undefined);
	const id = await first.defer("PT2S", "RECALL");
	const stoppedJob = await first.job();
	expect(stoppedJob).toMatchObject({ status: { state: "idle" }, reclaim: { phase: "stopped" } });
	const turns = await first.turns();
	await first.end();

	const second = await core("CANCEL", { restartOf: first.acp.cwd });
	expect(await second.job()).toEqual(stoppedJob);
	expect(await second.turns()).toEqual(turns);
	expect(await second.notices()).toEqual([]);

	expect(await second.outcome(id)).toEqual({ status: "completed", result: "sent" });
	await second.until((found) => found?.status.state === "done" && found.reclaim === undefined);
	await second.recorded(2);
	expect((await second.acp.port.readResult("card-a"))?.text).toMatch(/^recall: .*the word is KIWI$/s);
	expect(await second.turns()).toHaveLength(turns.length + 1);
	expect(await second.notices()).toEqual([]);
	second.off();
});

test("an agent the restart caught before its stop is dormant, holds no process, and the deferral wakes it in its session", async () => {
	const first = await core("the word is KIWI HANG");
	await first.dispatch();
	await first.until((found) => found?.status.state === "working");
	while (!(await first.acp.port.readScreen("card-a")).includes("KIWI")) await sleep(10);
	const id = await first.defer("PT2S", "RECALL");
	expect((await first.job())?.reclaim).toEqual({ phase: "due" });
	await first.end();

	const second = await core("hello", { restartOf: first.acp.cwd });
	expect(await second.acp.port.dormant()).toEqual(["card-a"]);
	expect((await second.job())?.reclaim).toEqual({ phase: "due" });
	expect(await second.pids()).toEqual([]);

	expect(await second.outcome(id)).toEqual({ status: "completed", result: "sent" });
	await second.until((found) => found?.status.state === "done" && found.reclaim === undefined);
	// The turn the restart cut, recorded over by the reconcile, and the instruction's.
	await second.recorded(2);
	expect((await second.acp.port.readResult("card-a"))?.text).toMatch(/^recall: .*the word is KIWI HANG$/s);
	expect(await second.pids()).toHaveLength(1);
	second.off();
});

test("a resume sends no brief the job still holds, and the stop and the resume record no turn", async () => {
	const soma = await core("hello");
	await soma.dispatch();
	await soma.until((found) => found?.outcome !== undefined);
	const turns = await soma.turns();
	expect(turns).toHaveLength(1);
	// The crash this stands in for: the brief went, the commit that lets go of it never landed.
	await soma.root.commit(async (tx) => {
		const doc = await tx.doc(Dispatches, soma.root.id);
		doc.jobs = doc.jobs.map((job) => ({ ...job, launch: "以下是任務卡：\n\n# card-a\n\nhello" }));
	}, context);
	const id = await soma.defer("PT1S", "HANG");
	expect((await soma.job())?.reclaim).toEqual({ phase: "stopped" });
	expect(await soma.turns()).toEqual(turns);

	expect(await soma.outcome(id)).toEqual({ status: "completed", result: "sent" });
	// The instruction's turn never ends, so anything recorded since came of the stop or the resume.
	await soma.until((found) => found?.status.state === "working");
	await sleep(200);
	expect(await soma.prompted()).toEqual([expect.stringContaining("hello"), expect.stringContaining("HANG")]);
	expect(await soma.turns()).toEqual(turns);
	expect((await soma.job())?.launch).toBeUndefined();
	soma.off();
});

test("a deferral whose agent has no transcript ends gone, with the old notice, and the job stays stopped", async () => {
	const first = await core(BRIEF);
	const id = await deferredInItsTurn(first, "PT2S", "RECALL");
	const { acpSessionId, cwd } = (await first.sessions())["card-a"] ?? { acpSessionId: "", cwd: "" };
	await first.end();
	await rm(join(first.acp.cwd, "..", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${acpSessionId}.jsonl`));

	const second = await core(BRIEF, { restartOf: first.acp.cwd });
	expect(await second.outcome(id)).toEqual({ status: "completed", result: "gone" });
	expect(await second.notices()).toEqual([
		expect.stringMatching(
			new RegExp(`^Deferred instruction ${id} for agent card-a .*no longer listed when it fell due .*RECALL$`),
		),
	]);
	expect((await second.job())?.reclaim).toEqual({ phase: "stopped" });
	expect(await second.pids()).toEqual([]);
	second.off();
});

test("a deferral whose agent has no recorded entry ends gone too", async () => {
	const first = await core(BRIEF);
	const id = await deferredInItsTurn(first, "PT2S", "RECALL");
	await first.end();
	await writeFile(first.acp.sessionsFile, "{}\n");

	const second = await core(BRIEF, { restartOf: first.acp.cwd });
	expect(await second.outcome(id)).toEqual({ status: "completed", result: "gone" });
	expect((await second.notices())[0]).toMatch(/no longer listed when it fell due/);
	expect((await second.job())?.reclaim).toEqual({ phase: "stopped" });
	second.off();
});

test("a deferral whose agent's session/load fails ends unresumed, naming why, with the job stopped and no process left", async () => {
	const first = await core(BRIEF);
	const id = await deferredInItsTurn(first, "PT2S", "RECALL");
	await first.end();

	const second = await core(BRIEF, { restartOf: first.acp.cwd, fake: { FAKE_ACP_LOAD_EXIT: "card-a" } });
	expect(await second.outcome(id)).toEqual({ status: "completed", result: "unresumed" });
	expect(await second.notices()).toEqual([
		expect.stringMatching(/could not start it again: session\/load of ACP session .* failed: .*RECALL$/),
	]);
	expect((await second.job())?.reclaim).toEqual({ phase: "stopped" });
	expect(await second.acp.port.list()).toEqual([]);
	expect((await second.sessions())["card-a"]?.stopped).toBe(true);
	for (const pid of await second.pids()) expect(alive(pid)).toBe(false);
	second.off();
});
