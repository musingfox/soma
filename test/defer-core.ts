import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { afterEach } from "vitest";
import type { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import type { Job } from "../src/core/domain/dispatch.ts";
import { type DeferOptions, deferExtension } from "../src/core/extensions/defer/index.ts";
import { eventBridge, reconcileDispatches } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { reclaimer } from "../src/core/extensions/dispatch/reclaim.ts";
import { openHarness } from "../src/core/harness.ts";
import { NOTICE } from "../src/core/notice.ts";

// One core process as main.ts starts it, for the deferral and reclaim tests.
export const context = BACKGROUND_CONTEXT;
export const jobOf = (card: string): Job => ({
	card,
	agent: card,
	sessionId: `s-${card}`,
	status: { state: "idle" },
	decisions: [],
});
const open: (() => Promise<void>)[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const close of open.splice(0)) await close();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

export async function database() {
	const directory = await mkdtemp(join(tmpdir(), "soma-reclaim-"));
	directories.push(directory);
	return join(directory, "soma.sqlite");
}

/**
 * One core process as main.ts starts it: tasks resumed, the dispatch list (seeded with a job for each agent listed
 * that has none yet) reconciled with the agents listed, then the event bridge fed every status. A faux model answers
 * a woken block. With `resume` "late", the tasks resume only after the reconcile, as an unawaited resume may.
 */
export async function core(
	db: string,
	agents: FakeAgentPort,
	options: DeferOptions = {},
	resume: "first" | "late" = "first",
) {
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("好。")));
	const models = createModels();
	models.setProvider(faux.provider);
	let reconciled: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		reconciled = resolve;
	});
	const defers = deferExtension(agents, {
		...options,
		reclaim: (agent) => ready.then(() => reclaimer(root, agents, context)(agent)),
	});
	const harness: Harness = await openHarness(
		db,
		[dispatchExtension(agents, async () => ""), defers.extension],
		context,
		{ models },
	);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	if (resume === "first") harness.resume();
	const listed = (await agents.list()).map((each) => each.name);
	await root.commit(async (tx) => {
		const doc = await tx.doc(Dispatches, root.id);
		for (const card of listed) {
			if (!doc.jobs.some((each) => each.card === card)) doc.jobs.push(jobOf(card));
		}
	}, context);
	await reconcileDispatches(root, agents, context);
	reconciled();
	if (resume === "late") harness.resume();
	const bridge = eventBridge(root, agents, context);
	const handled: Promise<void>[] = [];
	const off = agents.onStatus((event) => handled.push(bridge.handle(event)));
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		off();
		await harness.close(context);
	};
	open.push(close);
	return {
		harness,
		root,
		faux,
		close,
		settle: async () => {
			for (let seen = -1; seen !== handled.length; ) {
				seen = handled.length;
				await Promise.all(handled);
			}
			await root.waitForIdle(context);
		},
		defer: (at: string, card = "card-a") =>
			defers.defer(root, { agent: card, at, instruction: "run the tests" }, context),
		job: async (card: string) =>
			(await harness.snapshot(Dispatches, root.id, context))?.jobs.find((each) => each.card === card),
		notices: async () =>
			(await root.entries({ order: "ascending" }, 1000, undefined, context)).items
				.filter((entry) => entry.kind === NOTICE)
				.map((entry) => (entry.data as { content: string }).content),
		noticeClasses: async () =>
			(await root.entries({ order: "ascending" }, 1000, undefined, context)).items
				.filter((entry) => entry.kind === NOTICE)
				.map((entry) => (entry.data as { class: string }).class),
		outcome: async (id: string) => (await harness.waitForTask(Number(id) as TaskId, context)).state.outcome,
	};
}

export type Core = Awaited<ReturnType<typeof core>>;

export async function accepted(reply: Awaited<ReturnType<Core["defer"]>>) {
	if (!reply.accepted) throw new Error(reply.reason);
	return reply.id;
}
