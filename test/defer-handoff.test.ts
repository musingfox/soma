import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { repoRootOf } from "../src/adapters/repos/root.ts";
import { createRexAgentPort } from "../src/adapters/rex/agent-port.ts";
import type { Job } from "../src/core/domain/dispatch.ts";
import { type DeferOptions, Deferrals, deferExtension } from "../src/core/extensions/defer/index.ts";
import { eventBridge, reconcileDispatches } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { NOTICE } from "../src/core/notice.ts";
import {
	type AgentListing,
	type AgentPort,
	NotImplemented,
	PromptRefused,
	type ResumeRequest,
} from "../src/ports/agent.ts";
import { AT, HANGAR, type Session as RexSession, rex } from "./adapters/rex/fake.ts";

const context = BACKGROUND_CONTEXT;
const SESSION = "7e33597b-e33d-4c6d-a700-e21b2f54223e";
// Its first four hex digits are SESSION's: the two sessions' names clash.
const NEIGHBOUR = "7e33f00d-0000-4000-8000-000000000001";
const open: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** A fresh directory holding a repo `My_Repo` with a `src` under it, and a directory `loose` outside any repo. */
async function tree() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "soma-handoff-")));
	directories.push(directory);
	const repo = join(directory, "My_Repo");
	await mkdir(join(repo, ".git"), { recursive: true });
	await mkdir(join(repo, "src"));
	await mkdir(join(directory, "loose"));
	return { db: join(directory, "soma.sqlite"), repo, src: join(repo, "src"), loose: join(directory, "loose") };
}

type Agents = Pick<AgentPort, "list" | "prompt" | "resume" | "stop" | "onStatus" | "readResult">;

/**
 * One core as main.ts starts it, with the file system's repo roots, the event bridge fed every status and a faux model
 * that answers a woken turn: the dispatch list starts empty, as no job of a hand-off exists before it falls due.
 */
async function core(db: string, agents: Agents, options: DeferOptions = {}) {
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("好。")));
	const models = createModels();
	models.setProvider(faux.provider);
	const defers = deferExtension(agents, { pollMs: 10, readyMs: 2_000, repoRoot: repoRootOf, ...options });
	const harness = await openHarness(
		db,
		[dispatchExtension(agents as AgentPort, async () => ""), defers.extension],
		context,
		{ models },
	);
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const bridge = eventBridge(root, agents as AgentPort, context);
	const handled: Promise<void>[] = [];
	agents.onStatus((event) => handled.push(bridge.handle(event)));
	return {
		harness,
		root,
		dispatched: (agent: string, at: string) =>
			defers.defer(root, { agent, at, instruction: "tell me the word" }, context),
		handoff: (cwd: string, session = SESSION, at = "PT1H") =>
			defers.defer(root, { session, cwd, at, instruction: "tell me the word" }, context),
		jobs: async () => (await harness.snapshot(Dispatches, root.id, context))?.jobs ?? [],
		items: async () => (await harness.snapshot(Deferrals, root.id, context))?.items ?? {},
		notices: async () =>
			(await root.entries({ order: "ascending" }, 1000, undefined, context)).items
				.filter((entry) => entry.kind === NOTICE)
				.map((entry) => (entry.data as { content: string }).content),
		outcome: async (id: string) => (await harness.waitForTask(Number(id) as TaskId, context)).state.outcome,
		settle: async () => {
			for (let seen = -1; seen !== handled.length; ) {
				seen = handled.length;
				await Promise.all(handled);
			}
			await root.waitForIdle(context);
		},
	};
}

const id = (reply: { accepted: boolean; id?: string; reason?: string }) => {
	if (!reply.accepted || reply.id === undefined) throw new Error(reply.reason);
	return reply.id;
};

test("a hand-off is accepted into one item named for the session's repo, with no job, listing or stop", async () => {
	const { db, src, loose } = await tree();
	const agents = new FakeAgentPort();
	const list = vi.spyOn(agents, "list");
	const soma = await core(db, agents);

	const first = id(await soma.handoff(src));
	const outside = id(await soma.handoff(loose, "0123abcd-0000-4000-8000-000000000000"));

	expect(await soma.items()).toEqual({
		[first]: {
			agent: "soma-my-repo-7e33",
			card: "soma-my-repo-7e33",
			instruction: "tell me the word",
			at: expect.any(Number),
			setAt: expect.any(Number),
			session: SESSION,
			cwd: src,
		},
		[outside]: expect.objectContaining({ agent: "soma-loose-0123", session: "0123abcd-0000-4000-8000-000000000000" }),
	});
	expect(await soma.jobs()).toEqual([]);
	expect(list).not.toHaveBeenCalled();
	expect(agents.stopped).toEqual([]);
});

test("a name another session holds takes a fifth digit, and the same session handing off again gets its own name", async () => {
	const { db, repo } = await tree();
	const soma = await core(db, new FakeAgentPort());

	const first = id(await soma.handoff(repo));
	const neighbour = id(await soma.handoff(repo, NEIGHBOUR));
	const again = id(await soma.handoff(join(repo, "src")));

	const items = await soma.items();
	expect([items[first]?.agent, items[neighbour]?.agent, items[again]?.agent]).toEqual([
		"soma-my-repo-7e33",
		"soma-my-repo-7e33f",
		"soma-my-repo-7e33",
	]);
});

test("a session whose hand-off job exists gets that job's name, and a job of another session holds its own", async () => {
	const { db, repo } = await tree();
	const soma = await core(db, new FakeAgentPort());
	const taken: Job = {
		card: "soma-my-repo-7e33",
		agent: "soma-my-repo-7e33",
		sessionId: NEIGHBOUR,
		status: { state: "done" },
		decisions: [],
	};
	const own: Job = { ...taken, card: "soma-other-7e33", agent: "soma-other-7e33", sessionId: SESSION, handoff: true };
	await soma.root.commit(async (tx) => {
		(await tx.doc(Dispatches, soma.root.id)).jobs.push(taken, own);
	}, context);

	const mine = id(await soma.handoff(repo));
	const theirs = id(await soma.handoff(repo, "7e33aaaa-0000-4000-8000-000000000000"));

	const items = await soma.items();
	expect([items[mine]?.agent, items[theirs]?.agent]).toEqual(["soma-other-7e33", "soma-my-repo-7e33a"]);
});

test("a hand-off with a session that is no UUID, a relative directory, a bad time or no instruction records nothing", async () => {
	const { db, repo } = await tree();
	const soma = await core(db, new FakeAgentPort());
	const defers = [
		soma.handoff(repo, "card-a"),
		soma.handoff("My_Repo/src"),
		soma.handoff(repo, SESSION, "tomorrow"),
		soma.handoff(repo, SESSION, "2020-01-01T00:00:00Z"),
	];

	expect(await Promise.all(defers)).toEqual([
		{ accepted: false, reason: 'the session "card-a" (CLAUDE_CODE_SESSION_ID) is not a UUID' },
		{ accepted: false, reason: 'the directory "My_Repo/src" is not an absolute path' },
		{ accepted: false, reason: expect.stringMatching(/^--at must be/) },
		{ accepted: false, reason: expect.stringMatching(/past/) },
	]);
	expect(await soma.items()).toEqual({});
	expect(await soma.jobs()).toEqual([]);
});

test("at fire time the session becomes a job, is resumed in its directory, gets the rules and the instruction once, and its 完成 is told at once", async () => {
	const { db, src } = await tree();
	const agents = new FakeAgentPort();
	const soma = await core(db, agents);
	let held: Job | undefined;
	const resume = agents.resume.bind(agents);
	let before: Job[] | undefined;
	agents.resume = async (request) => {
		before = await soma.jobs();
		await resume(request);
	};
	const prompt = agents.prompt.bind(agents);
	agents.prompt = async (agent, text) => {
		held = (await soma.jobs())[0];
		await prompt(agent, text);
	};

	const deferral = id(await soma.handoff(src, SESSION, "PT1S"));

	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "sent" });
	// Recorded once the resume returned, and held `sending` by the prompt's commit.
	expect(before).toEqual([]);
	expect(held).toEqual({
		card: "soma-my-repo-7e33",
		agent: "soma-my-repo-7e33",
		sessionId: SESSION,
		repo: src,
		status: { state: "idle" },
		createdAt: expect.any(String),
		decisions: [],
		handoff: true,
		reclaim: { phase: "sending" },
	});
	expect(agents.resumed).toEqual([
		{ name: "soma-my-repo-7e33", card: "soma-my-repo-7e33", sessionId: SESSION, cwd: src },
	]);
	expect(agents.prompts).toEqual([
		{
			agent: "soma-my-repo-7e33",
			text: expect.stringMatching(
				new RegExp(
					`^你正在被無人值守地派工[^]*結果：失敗\\n\\n\\[soma deferred instruction ${deferral}\\] .*: tell me the word$`,
				),
			),
		},
	]);
	await soma.settle();
	const [job] = await soma.jobs();
	expect(job).toMatchObject({ agent: "soma-my-repo-7e33", handoff: true, status: { state: "working" } });
	expect(job?.reclaim).toBeUndefined();
	expect(await soma.items()).toEqual({});

	agents.finish("soma-my-repo-7e33", "結果：完成\nKUMQUAT");
	await soma.settle();
	expect(await soma.notices()).toEqual([
		"agent soma-my-repo-7e33（卡片 soma-my-repo-7e33）這一輪結束了：\n結果：完成\nKUMQUAT",
	]);
});

/** A hand-off of `src` fired and prompted, its job at work on the instruction with no reclaim. */
async function fired(soma: Awaited<ReturnType<typeof core>>, src: string) {
	const deferral = id(await soma.handoff(src, SESSION, "PT1S"));
	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "sent" });
	await soma.settle();
	expect((await soma.jobs())[0]).toMatchObject({ handoff: true, status: { state: "working" } });
	expect((await soma.jobs())[0]?.reclaim).toBeUndefined();
	return "soma-my-repo-7e33";
}

test("a hand-off job whose turn ends 完成 with nothing deferred is stopped once, and its 完成 is told as before", async () => {
	const { db, src } = await tree();
	const agents = new FakeAgentPort();
	const soma = await core(db, agents);
	const name = await fired(soma, src);

	agents.finish(name, "結果：完成\nKUMQUAT");
	await soma.settle();
	expect(agents.stopped).toEqual([name]);
	expect((await soma.jobs())[0]).toMatchObject({ outcome: "完成", reclaim: { phase: "stopped" } });
	expect(await soma.notices()).toEqual([`agent ${name}（卡片 ${name}）這一輪結束了：\n結果：完成\nKUMQUAT`]);

	// The closed process's last reports: no second stop.
	agents.emit(name, { state: "done" });
	agents.emit(name, { state: "idle" });
	await soma.settle();
	expect(agents.stopped).toEqual([name]);
});

test("a hand-off job ending 失敗 is stopped as well; one ending 需要你 keeps running for the reply", async () => {
	const { db, src } = await tree();
	const agents = new FakeAgentPort();
	const soma = await core(db, agents);
	const name = await fired(soma, src);

	agents.finish(name, "結果：需要你\nWhich branch?");
	await soma.settle();
	expect(agents.stopped).toEqual([]);
	expect((await soma.jobs())[0]?.reclaim).toBeUndefined();

	await agents.prompt(name, "main");
	agents.finish(name, "結果：失敗\nno such branch");
	await soma.settle();
	expect(agents.stopped).toEqual([name]);
});

test("a job soma dispatched whose turn ends 完成 with nothing deferred is not stopped", async () => {
	const { db } = await tree();
	const agents = new FakeAgentPort();
	const soma = await core(db, agents);
	const dispatched: Job = {
		card: "card-a",
		agent: "card-a",
		sessionId: SESSION,
		status: { state: "idle" },
		decisions: [],
	};
	await soma.root.commit(async (tx) => {
		(await tx.doc(Dispatches, soma.root.id)).jobs.push(dispatched);
	}, context);

	agents.emit("card-a", { state: "working" });
	agents.finish("card-a", "結果：完成");
	await soma.settle();
	expect((await soma.jobs())[0]).toMatchObject({ outcome: "完成" });
	expect((await soma.jobs())[0]?.reclaim).toBeUndefined();
	expect(agents.stopped).toEqual([]);
});

test("a hand-off job with a deferral of its agent pending is left to that deferral's reclaim, and not stopped twice", async () => {
	const { db, src } = await tree();
	const agents = new FakeAgentPort();
	const soma = await core(db, agents);
	const name = await fired(soma, src);

	// The session hands off again mid-turn, as its own skill does: nothing is armed until that falls due.
	const later = id(await soma.handoff(src, SESSION, "PT1H"));
	agents.finish(name, "結果：完成");
	await soma.settle();
	expect(agents.stopped).toEqual([]);
	expect((await soma.jobs())[0]?.reclaim).toBeUndefined();
	expect(Object.keys(await soma.items())).toEqual([later]);

	// A deferral on the dispatched path arms the reclaim, which stops it at its next rest, once.
	await agents.prompt(name, "go on");
	id(await soma.dispatched(name, "PT2H"));
	expect((await soma.jobs())[0]).toMatchObject({ reclaim: { phase: "due" } });
	agents.finish(name, "結果：完成");
	await soma.settle();
	agents.emit(name, { state: "idle" });
	await soma.settle();
	expect(agents.stopped).toEqual([name]);
	expect((await soma.jobs())[0]).toMatchObject({ reclaim: { phase: "stopped" } });
});

test("a hand-off job stopped after its 完成 takes a later hand-off of its session, resumed as after a reclaim", async () => {
	const { db, src } = await tree();
	const agents = new FakeAgentPort();
	const soma = await core(db, agents);
	const name = await fired(soma, src);
	agents.finish(name, "結果：完成");
	await soma.settle();
	expect(agents.stopped).toEqual([name]);

	const again = id(await soma.handoff(src, SESSION, "PT1S"));
	expect((await soma.items())[again]).toMatchObject({ agent: name });
	expect(await soma.outcome(again)).toEqual({ status: "completed", result: "sent" });
	await soma.settle();
	expect(agents.resumed).toEqual([
		{ name, card: name, sessionId: SESSION, cwd: src },
		{ name, card: name, sessionId: SESSION, cwd: src },
	]);
	expect(agents.prompts.map((each) => each.text)).toEqual([
		expect.stringContaining("tell me the word"),
		expect.stringContaining(`[soma deferred instruction ${again}]`),
	]);
	expect(await soma.jobs()).toHaveLength(1);
	expect((await soma.jobs())[0]).toMatchObject({ handoff: true, status: { state: "working" } });
	expect((await soma.jobs())[0]?.reclaim).toBeUndefined();

	agents.finish(name, "結果：完成");
	await soma.settle();
	expect(agents.stopped).toEqual([name, name]);
});

test("a session the agent side cannot resume ends gone with one notice naming it, no job, and a reconcile tells nothing more", async () => {
	const { db, src } = await tree();
	class NoTranscript extends FakeAgentPort {
		override async resume(request: ResumeRequest): Promise<void> {
			this.resumed.push(request);
			throw new NotImplemented(`ACP session ${request.sessionId} has no transcript, so it never ran a prompt`);
		}
	}
	const agents = new NoTranscript();
	const soma = await core(db, agents);

	const deferral = id(await soma.handoff(src, SESSION, "PT1S"));

	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "gone" });
	expect(agents.prompts).toEqual([]);
	const task = await soma.harness.getTask(Number(deferral) as TaskId, context);
	const at = new Date((task?.input as { at: number } | undefined)?.at ?? 0).toISOString();
	expect(await soma.notices()).toEqual([
		`Deferred instruction ${deferral} for agent soma-my-repo-7e33 (Claude Code session ${SESSION} in ${src}) was not sent: when it fell due at ${at}, soma could not resume the session: ACP session ${SESSION} has no transcript, so it never ran a prompt. The instruction was: tell me the word`,
	]);
	expect(await soma.jobs()).toEqual([]);

	await reconcileDispatches(soma.root, agents, context);
	expect(await soma.notices()).toHaveLength(1);
	expect(await soma.jobs()).toEqual([]);
});

test("a rerun that finds a hand-off's prompt in flight ends unsure, naming the session, and prompts nothing", {
	timeout: 20_000,
}, async () => {
	const { db, src } = await tree();
	const prompts: string[] = [];
	let listed: AgentListing[] = [];
	let sent: () => void = () => {};
	let cut: (error: Error) => void = () => {};
	const reached = new Promise<void>((resolve) => {
		sent = resolve;
	});
	// Stands in for soma dying mid-prompt: the prompt settles only as the core closes, and then fails.
	const hanging: Agents = {
		list: async () => listed,
		resume: async ({ name }) => {
			listed = [{ name, status: { state: "idle" }, seq: 1 }];
		},
		stop: async () => {},
		onStatus: () => () => {},
		readResult: async () => undefined,
		prompt: (_agent, text) => {
			prompts.push(text);
			sent();
			return new Promise((_resolve, reject) => {
				cut = reject;
			});
		},
	};
	const first = await core(db, hanging);
	const deferral = id(await first.handoff(src, SESSION, "PT1S"));
	await reached;
	const closed = first.harness.close(context);
	cut(new Error("soma went down"));
	await closed;
	open.splice(open.indexOf(first.harness), 1);

	const second = await core(db, hanging);

	expect(await second.outcome(deferral)).toEqual({ status: "completed", result: "unsure" });
	expect(prompts).toHaveLength(1);
	expect(await second.notices()).toEqual([
		expect.stringMatching(
			new RegExp(
				`^Deferred instruction ${deferral} for agent soma-my-repo-7e33 \\(Claude Code session ${SESSION} in ${src}\\) may not have reached the agent`,
			),
		),
	]);
});

test("a hand-off of a session another job of soma's holds is refused naming that job, and records nothing", async () => {
	const { db, repo } = await tree();
	const agents = new FakeAgentPort();
	const soma = await core(db, agents);
	const dispatched: Job = {
		card: "card-a",
		agent: "card-a",
		sessionId: SESSION,
		status: { state: "done" },
		decisions: [],
	};
	await soma.root.commit(async (tx) => {
		(await tx.doc(Dispatches, soma.root.id)).jobs.push(dispatched);
	}, context);

	expect(await soma.handoff(repo)).toEqual({
		accepted: false,
		reason: `session ${SESSION} is already the session of soma's job card-a, which soma resumes and prompts itself: it takes no hand-off of it, since two claudes would then write one transcript`,
	});
	expect(await soma.items()).toEqual({});
	expect(await soma.jobs()).toEqual([dispatched]);
});

test("a hand-off whose session another job came to hold before it fell due is not resumed, and one notice names both", async () => {
	const { db, repo } = await tree();
	const agents = new FakeAgentPort();
	const soma = await core(db, agents);
	const deferral = id(await soma.handoff(repo, SESSION, "PT1S"));
	const dispatched: Job = {
		card: "card-a",
		agent: "card-a",
		sessionId: SESSION,
		status: { state: "done" },
		decisions: [],
	};
	await soma.root.commit(async (tx) => {
		(await tx.doc(Dispatches, soma.root.id)).jobs.push(dispatched);
	}, context);

	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "unresumed" });
	expect([agents.resumed, agents.prompts]).toEqual([[], []]);
	expect(await soma.jobs()).toEqual([dispatched]);
	expect(await soma.notices()).toEqual([
		expect.stringMatching(
			new RegExp(
				`^Deferred instruction ${deferral} for agent soma-my-repo-7e33 \\(Claude Code session ${SESSION} in ${repo}\\) was not sent: .*already that of soma's job card-a, so soma did not resume it a second time`,
			),
		),
	]);
});

test("a hand-off whose session another job holds is not prompted where its own job is listed already", async () => {
	const { db, repo } = await tree();
	const agents = new FakeAgentPort();
	const soma = await core(db, agents);
	const deferral = id(await soma.handoff(repo, SESSION, "PT1S"));
	const own: Job = {
		card: "soma-my-repo-7e33",
		agent: "soma-my-repo-7e33",
		sessionId: SESSION,
		status: { state: "done" },
		decisions: [],
		handoff: true,
	};
	const { handoff: _own, ...rest } = own;
	const dispatched: Job = { ...rest, card: "card-a", agent: "card-a" };
	await soma.root.commit(async (tx) => {
		(await tx.doc(Dispatches, soma.root.id)).jobs.push(own, dispatched);
	}, context);
	agents.emit("soma-my-repo-7e33", { state: "done" });

	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "unresumed" });
	expect(agents.prompts).toEqual([]);
	expect(await soma.notices()).toEqual([expect.stringMatching(/already that of soma's job card-a/)]);
});

test("a second hand-off of a session whose own job is listed goes to that job's agent once", async () => {
	const { db, repo } = await tree();
	const agents = new FakeAgentPort();
	const soma = await core(db, agents);
	const own: Job = {
		card: "soma-my-repo-7e33",
		agent: "soma-my-repo-7e33",
		sessionId: SESSION,
		status: { state: "done" },
		decisions: [],
		handoff: true,
	};
	await soma.root.commit(async (tx) => {
		(await tx.doc(Dispatches, soma.root.id)).jobs.push(own);
	}, context);
	agents.emit("soma-my-repo-7e33", { state: "done" });

	const deferral = id(await soma.handoff(repo, SESSION, "PT1S"));

	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "sent" });
	expect(agents.resumed).toEqual([]);
	expect(agents.prompts).toEqual([{ agent: "soma-my-repo-7e33", text: expect.stringMatching(/tell me the word$/) }]);
});

test("a hand-off of the ACP id of a dispatched job, which accept cannot tell, is refused by the agent side and leaves no job", async () => {
	const { db, repo } = await tree();
	// On ACP a dispatched job holds soma's own session id, and claude's transcript is named after the ACP one.
	const dispatched: Job = {
		card: "card-a",
		agent: "card-a",
		sessionId: "s-card-a",
		status: { state: "done" },
		decisions: [],
	};
	class Held extends FakeAgentPort {
		override async resume(request: ResumeRequest): Promise<void> {
			this.resumed.push(request);
			throw new Error(
				`acp agent card-a already holds session ${request.sessionId}, so ${request.name} does not adopt it`,
			);
		}
	}
	const agents = new Held();
	const soma = await core(db, agents);
	await soma.root.commit(async (tx) => {
		(await tx.doc(Dispatches, soma.root.id)).jobs.push(dispatched);
	}, context);

	const deferral = id(await soma.handoff(repo, SESSION, "PT1S"));

	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "unresumed" });
	expect(agents.resumed).toHaveLength(1);
	expect(agents.prompts).toEqual([]);
	expect(await soma.jobs()).toEqual([dispatched]);
	expect(await soma.notices()).toEqual([
		expect.stringMatching(
			new RegExp(
				`^Deferred instruction ${deferral} for agent soma-my-repo-7e33 \\(Claude Code session ${SESSION} in ${repo}\\) was not sent: .*soma could not start it again: acp agent card-a already holds session ${SESSION}`,
			),
		),
	]);
	await reconcileDispatches(soma.root, agents, context);
	expect(await soma.notices()).toHaveLength(1);
});

test("a crash once the resume returned records the job at the rerun, which resumes nothing again", {
	timeout: 20_000,
}, async () => {
	const { db, src } = await tree();
	let listed: AgentListing[] = [];
	let resumes = 0;
	let resumed: () => void = () => {};
	const reached = new Promise<void>((resolve) => {
		resumed = resolve;
	});
	let hold = true;
	// The first resume returns only as the core closes, so its run cannot commit what follows: a crash just after it.
	const agents: Agents = {
		list: async () => listed,
		resume: async ({ name }) => {
			resumes++;
			// At work, so it is never prompted: only the rerun's own commit can record its job.
			listed = [{ name, status: { state: "working" }, seq: 1 }];
			resumed();
			while (hold) await new Promise((resolve) => setTimeout(resolve, 10));
		},
		stop: async () => {},
		onStatus: () => () => {},
		readResult: async () => undefined,
		prompt: async () => {},
	};
	const first = await core(db, agents);
	const deferral = id(await first.handoff(src, SESSION, "PT1S"));
	await reached;
	expect(await first.jobs()).toEqual([]);
	const closed = first.harness.close(context);
	hold = false;
	await closed;
	open.splice(open.indexOf(first.harness), 1);

	const second = await core(db, agents);

	expect(await second.outcome(deferral)).toEqual({ status: "completed", result: "failed" });
	expect(resumes).toBe(1);
	expect(await second.jobs()).toMatchObject([{ agent: "soma-my-repo-7e33", sessionId: SESSION, handoff: true }]);
});

test("two hand-offs of one session falling due together resume it once, the second waiting for the first", {
	timeout: 20_000,
}, async () => {
	const { db, src } = await tree();
	const agents = new FakeAgentPort();
	const resume = agents.resume.bind(agents);
	agents.resume = async (request) => {
		// Slow enough that both deferrals are past their listing before the first agent is listed.
		await new Promise((resolve) => setTimeout(resolve, 300));
		await resume(request);
	};
	const soma = await core(db, agents, { retryMs: 50 });

	const first = id(await soma.handoff(src, SESSION, "PT1S"));
	const second = id(await soma.handoff(src, SESSION, "PT1S"));

	expect(await soma.outcome(first)).toEqual({ status: "completed", result: "sent" });
	expect(await soma.outcome(second)).toEqual({ status: "completed", result: "sent" });
	expect(agents.resumed).toHaveLength(1);
	expect(agents.prompts.map(({ agent }) => agent)).toEqual(["soma-my-repo-7e33", "soma-my-repo-7e33"]);
	expect((await soma.jobs()).map(({ agent }) => agent)).toEqual(["soma-my-repo-7e33"]);
});

test("a hand-off whose resume threw but whose agent is listed after it becomes the job as it is prompted", async () => {
	const { db, src } = await tree();
	class Late extends FakeAgentPort {
		override async resume(request: ResumeRequest): Promise<void> {
			await super.resume(request);
			throw new Error("the answer to session/load was lost");
		}
	}
	const agents = new Late();
	const soma = await core(db, agents);

	const deferral = id(await soma.handoff(src, SESSION, "PT1S"));

	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "sent" });
	expect(agents.prompts).toHaveLength(1);
	const [job, ...more] = await soma.jobs();
	expect(more).toEqual([]);
	expect(job).toMatchObject({ agent: "soma-my-repo-7e33", sessionId: SESSION, handoff: true });
	expect(job?.reclaim).toBeUndefined();
});

/** Every notice's class and text, in order. */
const noticesOf = async (soma: Awaited<ReturnType<typeof core>>) =>
	(await soma.root.entries({ order: "ascending" }, 1000, undefined, context)).items
		.filter((entry) => entry.kind === NOTICE)
		.map((entry) => entry.data as { class: string; content: string });

test("a hand-off whose session a claude still has open is not resumed or sent, records no job, and tells the human once", async () => {
	const { db, src } = await tree();
	const agents = new FakeAgentPort();
	const asked: string[] = [];
	const soma = await core(db, agents, {
		liveSession: async (session) => {
			asked.push(session);
			return { pid: 4242, cwd: "/Users/me/elsewhere" };
		},
	});

	const deferral = id(await soma.handoff(src, SESSION, "PT1S"));

	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "open" });
	expect(asked).toEqual([SESSION]);
	expect([agents.resumed, agents.prompts]).toEqual([[], []]);
	expect(await soma.jobs()).toEqual([]);
	expect(await soma.items()).toEqual({});
	const task = await soma.harness.getTask(Number(deferral) as TaskId, context);
	const at = new Date((task?.input as { at: number } | undefined)?.at ?? 0).toISOString();
	expect(await noticesOf(soma)).toEqual([
		{
			kind: "report",
			class: "outcome",
			content: `Deferred instruction ${deferral} for agent soma-my-repo-7e33 (Claude Code session ${SESSION} in ${src}) was not sent: when it fell due at ${at}, its session ${SESSION} was still open in a claude soma did not start (pid 4242, in /Users/me/elsewhere), and soma does not write into a session another process has open. The instruction was: tell me the word`,
		},
	]);
});

test("a hand-off of an open session leaves the job an earlier resume gave it as it was", async () => {
	const { db, repo } = await tree();
	const agents = new FakeAgentPort();
	const soma = await core(db, agents, { liveSession: async () => ({ pid: 4242 }) });
	const own: Job = {
		card: "soma-my-repo-7e33",
		agent: "soma-my-repo-7e33",
		sessionId: SESSION,
		status: { state: "done" },
		decisions: [],
		handoff: true,
		reclaim: { phase: "stopped" },
	};
	await soma.root.commit(async (tx) => {
		(await tx.doc(Dispatches, soma.root.id)).jobs.push(own);
	}, context);

	const deferral = id(await soma.handoff(repo, SESSION, "PT1S"));

	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "open" });
	expect(agents.resumed).toEqual([]);
	expect(await soma.jobs()).toEqual([own]);
	expect(await soma.notices()).toEqual([
		expect.stringMatching(/was still open in a claude soma did not start \(pid 4242\), and/),
	]);
});

test("a look that keeps failing ends the hand-off failed after its tries and never resumes; one that fails once then finds none resumes", {
	timeout: 20_000,
}, async () => {
	const { db, src } = await tree();
	const failing = new FakeAgentPort();
	let looks = 0;
	const soma = await core(db, failing, {
		retryMs: 20,
		tries: 3,
		liveSession: async () => {
			looks++;
			throw new Error("EACCES: permission denied, scandir '/Users/me/.claude/sessions'");
		},
	});
	const deferral = id(await soma.handoff(src, SESSION, "PT1S"));

	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "failed" });
	expect(looks).toBe(3);
	expect([failing.resumed, failing.prompts]).toEqual([[], []]);
	expect(await soma.jobs()).toEqual([]);
	expect(await soma.notices()).toEqual([
		expect.stringMatching(/was not sent after 3 tries: EACCES: permission denied, scandir/),
	]);

	const { db: second } = await tree();
	const recovering = new FakeAgentPort();
	let failed = false;
	const again = await core(second, recovering, {
		retryMs: 20,
		liveSession: async () => {
			if (failed) return undefined;
			failed = true;
			throw new Error("EIO");
		},
	});
	const later = id(await again.handoff(src, SESSION, "PT1S"));

	expect(await again.outcome(later)).toEqual({ status: "completed", result: "sent" });
	expect(recovering.resumed).toHaveLength(1);
	expect(recovering.prompts).toHaveLength(1);
});

test("a deferral of an agent soma dispatched, or of a hand-off whose agent is listed, looks for no open session", async () => {
	const { db, repo } = await tree();
	const agents = new FakeAgentPort();
	let looks = 0;
	const soma = await core(db, agents, {
		liveSession: async () => {
			looks++;
			return { pid: 4242 };
		},
	});
	const own: Job = {
		card: "soma-my-repo-7e33",
		agent: "soma-my-repo-7e33",
		sessionId: SESSION,
		status: { state: "done" },
		decisions: [],
		handoff: true,
	};
	await soma.root.commit(async (tx) => {
		(await tx.doc(Dispatches, soma.root.id)).jobs.push(own);
	}, context);
	agents.emit("soma-my-repo-7e33", { state: "done" });

	const deferral = id(await soma.handoff(repo, SESSION, "PT1S"));
	const dispatched: Job = {
		card: "card-a",
		agent: "card-a",
		sessionId: "s-card-a",
		status: { state: "done" },
		decisions: [],
	};
	await soma.root.commit(async (tx) => {
		(await tx.doc(Dispatches, soma.root.id)).jobs.push(dispatched);
	}, context);
	// Not listed when it falls due, so it is resumed in its session as before.
	agents.emit("card-a", { state: "working" });
	const theirs = id(await soma.dispatched("card-a", "PT1S"));
	agents.close("card-a");

	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "sent" });
	expect(await soma.outcome(theirs)).toEqual({ status: "completed", result: "sent" });
	expect(agents.resumed).toEqual([{ name: "card-a", card: "card-a", sessionId: "s-card-a" }]);
	expect(looks).toBe(0);
});

test.each([{ phase: "failed", error: "rex: block.close timed out" }, { phase: "due" }, { phase: "sending" }] as const)(
	"a hand-off of an open session leaves the job an earlier resume gave it, reclaim $phase, byte for byte",
	async (reclaim) => {
		const { db, repo } = await tree();
		const agents = new FakeAgentPort();
		const soma = await core(db, agents, { liveSession: async () => ({ pid: 4242 }) });
		const own: Job = {
			card: "soma-my-repo-7e33",
			agent: "soma-my-repo-7e33",
			sessionId: SESSION,
			status: { state: "done" },
			decisions: [],
			handoff: true,
			reclaim,
		};
		await soma.root.commit(async (tx) => {
			(await tx.doc(Dispatches, soma.root.id)).jobs.push(own);
		}, context);
		const before = JSON.stringify(await soma.jobs());

		const deferral = id(await soma.handoff(repo, SESSION, "PT1S"));

		expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "open" });
		expect(JSON.stringify(await soma.jobs())).toBe(before);
		expect(agents.resumed).toEqual([]);
		expect(await soma.items()).toEqual({});
		expect(await soma.notices()).toEqual([expect.stringMatching(/was still open in a claude soma did not start/)]);
	},
);

const PANE = { id: "block:pane", session: "desk", label: "claude" };

/** A fake agent side on which SESSION is open in a foreign pane of rex, at rest. */
function openInPane() {
	const agents = new FakeAgentPort();
	agents.emitForeign(PANE, { state: "idle" }, 1);
	agents.foreignSessions.set(SESSION, PANE.id);
	return agents;
}

test("a hand-off whose session is open in a rex pane is typed into it once, with no job, resume or rules", async () => {
	const { db, src } = await tree();
	const agents = openInPane();
	// The pane's claude has a pid file too: the look for the pane comes first, so this never ends it.
	const soma = await core(db, agents, { liveSession: async () => ({ pid: 4242 }) });

	const deferral = id(await soma.handoff(src, SESSION, "PT1S"));

	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "sent" });
	expect(agents.foreignSessionLooks).toEqual([SESSION]);
	expect(agents.foreignPrompts).toEqual([
		{
			id: PANE.id,
			text: expect.stringMatching(new RegExp(`^\\[soma deferred instruction ${deferral}\\] .*: tell me the word$`)),
		},
	]);
	expect([agents.resumed, agents.prompts]).toEqual([[], []]);
	expect(await soma.jobs()).toEqual([]);
	expect(await soma.items()).toEqual({});
	expect(await soma.notices()).toEqual([]);
});

test("a pane that refuses the instruction twice and is then closed is looked for again each time, and the session resumed as today", {
	timeout: 20_000,
}, async () => {
	const { db, src } = await tree();
	const agents = openInPane();
	let refusals = 0;
	agents.promptForeign = async (paneId) => {
		refusals++;
		// Closed after the second refusal: its claude, and the session's pid file, are gone.
		if (refusals === 2) agents.foreignSessions.delete(SESSION);
		throw new PromptRefused(`rex foreign agent ${paneId} is working: a prompt goes only to idle or done`);
	};
	const soma = await core(db, agents, { retryMs: 20 });

	const deferral = id(await soma.handoff(src, SESSION, "PT1S"));

	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "sent" });
	expect(refusals).toBe(2);
	expect(agents.foreignSessionLooks).toEqual([SESSION, SESSION, SESSION]);
	expect(agents.resumed).toEqual([
		{ name: "soma-my-repo-7e33", card: "soma-my-repo-7e33", sessionId: SESSION, cwd: src },
	]);
	expect(agents.prompts).toEqual([
		{ agent: "soma-my-repo-7e33", text: expect.stringMatching(/^你正在被無人值守地派工/) },
	]);
	expect(await soma.notices()).toEqual([]);
});

test("a pane that keeps refusing ends the hand-off failed after its tries, and nothing is resumed", {
	timeout: 20_000,
}, async () => {
	const { db, src } = await tree();
	const agents = openInPane();
	agents.emitForeign(PANE, { state: "working" }, 2);
	const soma = await core(db, agents, { retryMs: 20, tries: 3 });

	const deferral = id(await soma.handoff(src, SESSION, "PT1S"));

	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "failed" });
	expect([agents.foreignPrompts, agents.resumed, agents.prompts]).toEqual([[], [], []]);
	expect(await soma.notices()).toEqual([
		expect.stringMatching(/was not sent after 3 tries: foreign agent block:pane is working/),
	]);
});

test("a look for the pane that keeps failing ends the hand-off failed after its tries and never resumes", {
	timeout: 20_000,
}, async () => {
	const { db, src } = await tree();
	const agents = new FakeAgentPort();
	agents.foreignSessionError = new Error("rex is away");
	let looks = 0;
	const soma = await core(db, agents, {
		retryMs: 20,
		tries: 3,
		liveSession: async () => {
			looks++;
			return undefined;
		},
	});

	const deferral = id(await soma.handoff(src, SESSION, "PT1S"));

	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "failed" });
	expect(agents.foreignSessionLooks).toHaveLength(3);
	expect([looks, agents.resumed, agents.prompts]).toEqual([0, [], []]);
	expect(await soma.jobs()).toEqual([]);
	expect(await soma.notices()).toEqual([expect.stringMatching(/was not sent after 3 tries: rex is away/)]);
});

test("typing that fails once it may have begun ends unsure, with one notice, and is not tried again", async () => {
	const { db, src } = await tree();
	const agents = openInPane();
	let typed = 0;
	agents.promptForeign = async () => {
		typed++;
		throw new Error("rex: connection reset");
	};
	const soma = await core(db, agents, { retryMs: 20 });

	const deferral = id(await soma.handoff(src, SESSION, "PT1S"));

	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "unsure" });
	expect(typed).toBe(1);
	expect(agents.resumed).toEqual([]);
	expect(await soma.items()).toEqual({});
	expect(await soma.notices()).toEqual([
		expect.stringMatching(
			/may not have reached the agent: sending it failed after it may have begun \(rex: connection reset\)/,
		),
	]);
});

test("a rerun that finds the typing in flight ends unsure and types nothing more", { timeout: 20_000 }, async () => {
	const { db, src } = await tree();
	const typed: string[] = [];
	let reached: () => void = () => {};
	const reaching = new Promise<void>((resolve) => {
		reached = resolve;
	});
	let cut: (error: Error) => void = () => {};
	// Stands in for soma dying mid-paste: the typing settles only as the core closes, and then fails.
	const agents: Agents & Pick<AgentPort, "findForeignSession" | "promptForeign"> = {
		list: async () => [],
		resume: async () => {},
		stop: async () => {},
		onStatus: () => () => {},
		readResult: async () => undefined,
		prompt: async () => {},
		findForeignSession: async () => PANE.id,
		promptForeign: (_pane, text) => {
			typed.push(text);
			reached();
			return new Promise((_resolve, reject) => {
				cut = reject;
			});
		},
	};
	const first = await core(db, agents);
	const deferral = id(await first.handoff(src, SESSION, "PT1S"));
	await reaching;
	const closed = first.harness.close(context);
	cut(new Error("soma went down"));
	await closed;
	open.splice(open.indexOf(first.harness), 1);

	const second = await core(db, agents);

	expect(await second.outcome(deferral)).toEqual({ status: "completed", result: "unsure" });
	expect(typed).toHaveLength(1);
	expect(await second.notices()).toEqual([
		expect.stringMatching(/may not have reached the agent: soma stopped while sending it/),
	]);
});

test("a pane whose claude's pid file is under a child that cannot be listed is not typed into: the look for a live claude ends it", async () => {
	const { db, src } = await tree();
	const sessionsDir = join(src, "..", "sessions");
	await mkdir(sessionsDir);
	// The pane's foreground claude, 601, has no pid file; the child that wrote one cannot be listed.
	const pane: RexSession = {
		id: "session:desk",
		label: "desk",
		blocks: [
			{ name: "one", block: "block:p1", argv0: "claude", pid: 601, records: [{ state: "idle", updated_at: AT }] },
		],
	};
	const fake = rex([], [pane]);
	const agents = createRexAgentPort({
		processStart: async () => undefined,
		processChildren: async () => [],
		client: fake.client,
		sessionId: HANGAR,
		sessionsDir,
	});
	const soma = await core(db, agents, { liveSession: async () => ({ pid: 602, cwd: src }) });

	const deferral = id(await soma.handoff(src, SESSION, "PT1S"));

	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "open" });
	expect(fake.methods().filter((method) => method === "block.event")).toEqual([]);
	expect(await soma.notices()).toEqual([
		expect.stringMatching(/was still open in a claude soma did not start \(pid 602/),
	]);
});
