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
import type { Job } from "../src/core/domain/dispatch.ts";
import { type DeferOptions, Deferrals, deferExtension } from "../src/core/extensions/defer/index.ts";
import { eventBridge, reconcileDispatches } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { NOTICE } from "../src/core/notice.ts";
import { type AgentListing, type AgentPort, NotImplemented, type ResumeRequest } from "../src/ports/agent.ts";

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
	agents.resume = async (request) => {
		held = (await soma.jobs())[0];
		await resume(request);
	};

	const deferral = id(await soma.handoff(src, SESSION, "PT1S"));

	expect(await soma.outcome(deferral)).toEqual({ status: "completed", result: "sent" });
	expect(held).toEqual({
		card: "soma-my-repo-7e33",
		agent: "soma-my-repo-7e33",
		sessionId: SESSION,
		repo: src,
		status: { state: "idle" },
		createdAt: expect.any(String),
		decisions: [],
		handoff: true,
		reclaim: { phase: "resuming" },
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

test("a session the agent side cannot resume ends gone with one notice naming it, its job stopped, and a reconcile tells nothing more", async () => {
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
	expect((await soma.jobs())[0]).toMatchObject({ agent: "soma-my-repo-7e33", reclaim: { phase: "stopped" } });

	await reconcileDispatches(soma.root, agents, context);
	expect(await soma.notices()).toHaveLength(1);
	expect((await soma.jobs())[0]).toMatchObject({ status: { state: "idle" }, reclaim: { phase: "stopped" } });
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
