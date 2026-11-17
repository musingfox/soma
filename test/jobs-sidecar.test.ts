import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { type Job, jobsSidecar } from "../src/core/domain/dispatch.ts";
import { eventBridge } from "../src/core/extensions/dispatch/bridge.ts";
import { dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { keepJobsFile } from "../src/core/extensions/dispatch/sidecar.ts";

const context = BACKGROUND_CONTEXT;
const T1 = "2026-11-17T10:00:00.000Z";
const T2 = "2026-11-17T10:05:00.000Z";

const job = (over: Partial<Job> = {}): Job => ({
	card: "a",
	agent: "a",
	sessionId: "s1",
	status: { state: "working" },
	decisions: [],
	repo: "/r",
	createdAt: T1,
	...over,
});

test("the file lists each job with its status, outcome, repo and times, under a version", () => {
	const file = jobsSidecar([job({ outcome: "完成" })], undefined, T2);

	expect(file).toEqual({
		version: 1,
		jobs: [
			{
				card: "a",
				agent: "a",
				sessionId: "s1",
				status: "working",
				kind: null,
				outcome: "完成",
				repo: "/r",
				created: T1,
				updated: T2,
			},
		],
	});
});

test("a job first seen is updated now, though it was created earlier", () => {
	const [entry] = jobsSidecar([job()], undefined, T2).jobs;

	expect(entry).toMatchObject({ created: T1, updated: T2 });
});

test("an entry has no worktree key, whatever the job holds", () => {
	const [entry] = jobsSidecar([job()], undefined, T2).jobs;

	expect(entry).not.toHaveProperty("worktree");
	expect(Object.keys(entry ?? {}).sort()).toEqual(
		["agent", "card", "created", "kind", "outcome", "repo", "sessionId", "status", "updated"].sort(),
	);
});

test("a blocked job carries its kind, and no other state does", () => {
	const blocked = jobsSidecar([job({ status: { state: "blocked", kind: "question" } })], undefined, T2).jobs[0];
	const done = jobsSidecar([job({ status: { state: "done" } })], undefined, T2).jobs[0];

	expect(blocked).toMatchObject({ status: "blocked", kind: "question" });
	expect(done).toMatchObject({ status: "done", kind: null });
});

test("nothing that holds the card's text or the agent's words is written", () => {
	const secret = "SECRET CARD TEXT";
	const file = jobsSidecar(
		[
			job({
				launch: secret,
				ticket: secret,
				status: {
					state: "blocked",
					kind: "permission",
					msg: secret,
					fingerprint: secret,
					options: [{ id: "1", label: secret }],
				},
				decisions: [{ at: T1, kind: "permission", action: "replied", text: secret, reason: secret }],
				handedOver: { msg: secret },
			}),
		],
		undefined,
		T2,
	);

	expect(JSON.stringify(file)).not.toContain(secret);
	expect(JSON.stringify(file)).not.toContain("launch");
});

test("a job recorded before repo and times were kept shows them as null, and is updated when first seen", () => {
	const { repo: _repo, createdAt: _created, ...old } = job();

	const [entry] = jobsSidecar([old], undefined, T2).jobs;

	expect(entry).toMatchObject({ repo: null, created: null, updated: T2 });
});

test("a job unchanged since the file was last written keeps its updated time; a changed one gets now", () => {
	const before = jobsSidecar([job(), job({ card: "b", agent: "b" })], undefined, T1);
	const previous = JSON.parse(JSON.stringify(before));
	previous.jobs[0].updated = "2026-11-17T10:01:00.000Z";
	previous.jobs[1].updated = "2026-11-17T10:02:00.000Z";

	const after = jobsSidecar([job(), job({ card: "b", agent: "b", status: { state: "done" } })], previous, T2);

	expect(after.jobs.map((each) => each.updated)).toEqual(["2026-11-17T10:01:00.000Z", T2]);
});

test("a previous file that is not this shape is no previous", () => {
	for (const previous of [null, 3, "x", { jobs: 5 }, { version: 1, jobs: [null, 7, { card: 1 }] }])
		expect(jobsSidecar([job()], previous, T2).jobs[0]?.updated).toBe(T2);
});

// The wiring: a harness with the dispatch extension, the file kept from the dispatch list's watch.
const open: Harness[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
});

async function setup(storage = new MemoryStorage()) {
	const agents = new FakeAgentPort();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(dispatchExtension(agents, async (_repo, card) => `# ${card}\nTHE CARD BODY`));
	const harness = await Harness.open(storage, { models, registry }, context);
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	eventBridge(root, agents, context).listen(() => {});
	const written: unknown[] = [];
	let stored: unknown;
	const file = {
		read: () => stored,
		write: (value: unknown) => {
			stored = value;
			written.push(JSON.parse(JSON.stringify(value)));
		},
	};
	const errors: Error[] = [];
	const last = () => written.at(-1) as { jobs: { card: string; status: string; kind: string | null }[] } | undefined;
	async function dispatch(card: string, requestId: string) {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("dispatch", { card, repo: "/repo" }, { id: requestId })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok"),
		]);
		const submission = await root.submit({ type: "input", content: `派 ${card}`, requestId }, context);
		expect((await submission.wait(context)).status).toBe("done");
	}
	return { agents, harness, root, file, written, errors, last, dispatch };
}

test("startup writes the file from the stored list, even when it is empty", async () => {
	const { harness, root, file, written, errors } = await setup();

	await keepJobsFile(harness, root, file, context, { onError: (error) => errors.push(error) });

	expect(written).toEqual([{ version: 1, jobs: [] }]);
	expect(errors).toEqual([]);
});

test("a dispatched card is in the file with its repo, and the file follows the agent's status", async () => {
	const { agents, harness, root, file, last, dispatch } = await setup();
	await keepJobsFile(harness, root, file, context, { onError: () => {} });

	await dispatch("card-a", "r1");
	await vi.waitFor(() => expect(last()?.jobs).toHaveLength(1));
	expect(last()?.jobs[0]).toMatchObject({
		card: "card-a",
		status: "idle",
		kind: null,
		repo: "/repo",
		created: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
	});

	agents.emit("card-a", { state: "working" });
	await vi.waitFor(() => expect(last()?.jobs[0]?.status).toBe("working"));
	agents.emit("card-a", { state: "blocked", kind: "permission" });
	await vi.waitFor(() => expect(last()?.jobs[0]).toMatchObject({ status: "blocked", kind: "permission" }));
	agents.emit("card-a", { state: "done" });
	await vi.waitFor(() => expect(last()?.jobs[0]).toMatchObject({ status: "done", kind: null }));
});

test("a dispatched card's entry in the file has no worktree key", async () => {
	const { harness, root, file, last, dispatch } = await setup();
	await keepJobsFile(harness, root, file, context, { onError: () => {} });

	await dispatch("card-a", "r1");

	await vi.waitFor(() => expect(last()?.jobs).toHaveLength(1));
	expect(last()?.jobs[0]).not.toHaveProperty("worktree");
});

test("a restarted soma rewrites the file from the stored list, keeping the times of jobs that did not change", async () => {
	const { harness, root, file, last, dispatch } = await setup();
	const stop = await keepJobsFile(harness, root, file, context, { onError: () => {} });
	await dispatch("card-a", "r1");
	await vi.waitFor(() => expect(last()?.jobs).toHaveLength(1));
	const kept = JSON.parse(JSON.stringify(last()));
	await stop();

	// The next run finds the file as the last one left it, with the entry last changed long ago, and the list as stored.
	const stale = { version: 1, jobs: [{ ...kept.jobs[0], updated: "2026-01-01T00:00:00.000Z" }] };
	const rewritten: unknown[] = [];
	await keepJobsFile(
		harness,
		root,
		{ read: () => stale, write: (value) => rewritten.push(JSON.parse(JSON.stringify(value))) },
		context,
		{ onError: () => {} },
	);

	expect(rewritten).toEqual([{ version: 1, jobs: [{ ...kept.jobs[0], updated: "2026-01-01T00:00:00.000Z" }] }]);
});

test("a file that is missing or unreadable at startup gives every existing job the startup time as updated", async () => {
	const { harness, root, file, last, dispatch } = await setup();
	const stop = await keepJobsFile(harness, root, file, context, { onError: () => {} });
	await dispatch("card-a", "r1");
	await dispatch("card-b", "r2");
	await vi.waitFor(() => expect(last()?.jobs).toHaveLength(2));
	await stop();
	const STARTUP = "2026-11-20T09:00:00.000Z";

	for (const read of [
		() => undefined,
		() => {
			throw new Error("not JSON");
		},
	]) {
		const rewritten: { jobs: { created: string; updated: string }[] }[] = [];
		await keepJobsFile(
			harness,
			root,
			{ read, write: (value) => rewritten.push(JSON.parse(JSON.stringify(value))) },
			context,
			{ onError: () => {}, now: () => STARTUP },
		);

		expect(rewritten[0]?.jobs).toHaveLength(2);
		for (const entry of rewritten[0]?.jobs ?? []) {
			expect(entry.created).not.toBe(STARTUP);
			expect(entry.updated).toBe(STARTUP);
		}
	}
});

test("the file holds none of the card's text", async () => {
	const { harness, root, file, written, dispatch } = await setup();
	await keepJobsFile(harness, root, file, context, { onError: () => {} });

	await dispatch("card-a", "r1");
	await vi.waitFor(() => expect(written.length).toBeGreaterThan(1));

	expect(JSON.stringify(written)).not.toContain("THE CARD BODY");
});

test("a write that fails is reported and the next change is written again", async () => {
	const { harness, root, file, written, errors, dispatch } = await setup();
	let failing = true;
	const flaky = {
		read: file.read,
		write: (value: unknown) => {
			if (failing) throw new Error("disk full");
			file.write(value);
		},
	};
	await keepJobsFile(harness, root, flaky, context, { onError: (error) => errors.push(error) });
	expect(errors.map((error) => error.message)).toEqual([expect.stringContaining("disk full")]);

	failing = false;
	await dispatch("card-a", "r1");

	await vi.waitFor(() => expect(written.at(-1)).toMatchObject({ jobs: [{ card: "card-a" }] }));
});

test("a file that cannot be read at startup is reported, and written over", async () => {
	const { harness, root, file, written, errors } = await setup();
	const broken = {
		...file,
		read: () => {
			throw new Error("not JSON");
		},
	};

	await keepJobsFile(harness, root, broken, context, { onError: (error) => errors.push(error) });

	expect(errors.map((error) => error.message)).toEqual([expect.stringContaining("not JSON")]);
	expect(written).toEqual([{ version: 1, jobs: [] }]);
});
