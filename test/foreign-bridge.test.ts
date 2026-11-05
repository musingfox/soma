import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation, Harness, Tx } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { observeForeign } from "../src/core/domain/foreign.ts";
import {
	FOREIGN_BLOCKED,
	ForeignPrompts,
	foreignBridge,
	foreignRequestId,
} from "../src/core/extensions/dispatch/foreign.ts";
import { dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";
import { NOTICE } from "../src/core/notice.ts";
import type { AgentState } from "../src/ports/agent.ts";
import type { SomaEvent } from "../src/ports/human.ts";

const context = BACKGROUND_CONTEXT;
const open: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function database() {
	const directory = await mkdtemp(join(tmpdir(), "soma-foreign-"));
	directories.push(directory);
	return join(directory, "soma.sqlite");
}

/** One core process over `db`, with a faux model whose request count is the model-call count. */
async function core(db: string, agents: FakeAgentPort, failing?: { next: () => boolean }) {
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("好。")));
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await openHarness(db, [dispatchExtension(agents, async (_repo, card) => `# ${card}`)], context, {
		models,
	});
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	// A commit that appended a notice may be made to fail, as a crash between the wake and the notice would: the
	// callback ran, nothing of it is stored.
	const flaky = new Proxy(root, {
		get(target, key) {
			const value = Reflect.get(target, key, target);
			if (key !== "commit") return typeof value === "function" ? value.bind(target) : value;
			return (change: (tx: Tx) => Promise<unknown>, ctx: Context) =>
				root.commit(async (tx) => {
					let appended = false;
					const append = tx.appendEntry.bind(tx);
					tx.appendEntry = ((...args: Parameters<Tx["appendEntry"]>) => {
						appended = true;
						return append(...args);
					}) as Tx["appendEntry"];
					const result = await change(tx);
					if (appended && failing?.next()) throw new Error("the commit failed");
					return result;
				}, ctx);
		},
	});
	const bridge = foreignBridge(flaky, agents, context);
	const handled: Promise<void>[] = [];
	const unlisten = agents.onForeignStatus((event) => handled.push(bridge.handle(event).catch(() => {})));
	return {
		harness,
		root,
		bridge,
		calls: () => faux.state.callCount,
		settle: async () => {
			await Promise.all(handled);
			await root.waitForIdle(context);
		},
		stop: async () => {
			unlisten();
			await harness.close(context);
			open.splice(open.indexOf(harness), 1);
		},
		told: async () => (await harness.snapshot(ForeignPrompts, root.id, context))?.told,
	};
}

async function entriesOf(root: Conversation, kind: string) {
	return (await root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter(
		(entry) => entry.kind === kind,
	);
}

const PANE = { id: "pane-1", session: "work", label: "Window 1" };
const bash: AgentState = {
	state: "blocked",
	kind: "permission",
	msg: "approve Bash: touch probe.txt",
	fingerprint: "f00d",
	options: [
		{ id: "1", label: "Yes" },
		{ id: "2", label: "No" },
	],
};

test("a blocked foreign agent the human is away from is pushed once, with one wake that offers respond", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(await database(), agents);

	agents.emitForeign(PANE, bash, 10);
	// Seen again: the same observation, and the same prompt under a new seq.
	agents.emitForeign(PANE, bash, 10);
	agents.emitForeign(PANE, bash, 11);
	await soma.settle();

	const notices = await entriesOf(soma.root, NOTICE);
	expect(notices.map((entry) => entry.data)).toEqual([
		{
			kind: "question",
			class: "action",
			content:
				"外部 agent Window 1（session work）卡住了，kind=permission，你不在它的畫面前。\napprove Bash: touch probe.txt",
			foreign: { id: "pane-1", told: { fingerprint: "f00d", msg: "approve Bash: touch probe.txt" } },
		},
	]);
	const wakes = await entriesOf(soma.root, FOREIGN_BLOCKED);
	expect(wakes).toHaveLength(1);
	expect(JSON.stringify(wakes[0]?.model)).toContain("respond 工具代答（foreign=pane-1、fingerprint=f00d");
	expect(soma.calls()).toBe(1);
	expect(await soma.told()).toEqual({ "pane-1": { fingerprint: "f00d", msg: "approve Bash: touch probe.txt" } });
});

test("a blocked foreign agent the human is looking at pushes nothing and wakes nothing, until they look away", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(await database(), agents);

	agents.emitForeign(PANE, bash, 10, true);
	await soma.settle();
	expect(await entriesOf(soma.root, NOTICE)).toEqual([]);
	expect(soma.calls()).toBe(0);
	expect(await soma.told()).toEqual({});

	// Answered while looked at: never told.
	agents.emitForeign(PANE, { state: "working" }, 12);
	agents.emitForeign(PANE, { ...bash, fingerprint: "beef", msg: "approve Bash: rm probe.txt" }, 13, true);
	await soma.settle();
	expect(await entriesOf(soma.root, NOTICE)).toEqual([]);

	// The human looked away while the prompt waits: told now, under the observation's own seq.
	agents.emitForeign(PANE, { ...bash, fingerprint: "beef", msg: "approve Bash: rm probe.txt" }, 13, false);
	await soma.settle();
	expect(await entriesOf(soma.root, NOTICE)).toHaveLength(1);
	expect((await entriesOf(soma.root, FOREIGN_BLOCKED)).map((entry) => entry.data)).toEqual([
		{ id: "pane-1", kind: "permission", seq: 13 },
	]);
	expect(soma.calls()).toBe(1);
});

test("the same dialog is not told twice across a restart, and a new one after it is", async () => {
	const db = await database();
	const agents = new FakeAgentPort();
	const first = await core(db, agents);
	agents.emitForeign(PANE, bash, 10);
	await first.settle();
	await first.stop();

	const second = await core(db, agents);
	// The restarted watch's first look reports the same prompt, under its seq and under a later one.
	agents.emitForeign(PANE, bash, 10);
	agents.emitForeign(PANE, bash, 11);
	await second.settle();
	expect(await entriesOf(second.root, NOTICE)).toHaveLength(1);
	expect(second.calls()).toBe(0);

	// Past it, and stopped at the same prompt again: a new block, told once more.
	agents.emitForeign(PANE, { state: "working" }, 12);
	agents.emitForeign(PANE, bash, 13);
	await second.settle();
	expect(await entriesOf(second.root, NOTICE)).toHaveLength(2);
	expect(second.calls()).toBe(1);
});

test("a wake whose notice a crash cut off is submitted once, under the same requestId, and told once", async () => {
	const db = await database();
	const agents = new FakeAgentPort();
	const first = await core(db, agents);
	// The crash window: the wake was submitted, the notice and the prompt told were not committed.
	await first.root.submit(
		{ type: "input", content: "wake", whenBusy: "followUp", requestId: foreignRequestId("pane-1", 10) },
		context,
	);
	await first.settle();
	await first.stop();

	const second = await core(db, agents);
	agents.emitForeign(PANE, bash, 10);
	await second.settle();

	expect(await entriesOf(second.root, NOTICE)).toHaveLength(1);
	expect(second.calls()).toBe(0);
});

test("an auth prompt of a foreign agent is told to the human and never wakes the model", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(await database(), agents);

	agents.emitForeign(PANE, { state: "blocked", kind: "auth", msg: "login" }, 10);
	await soma.settle();

	expect((await entriesOf(soma.root, NOTICE)).map((entry) => entry.data)).toEqual([
		{
			kind: "question",
			class: "action",
			content: "外部 agent Window 1（session work）在等登入或憑證，需要你處理。\nlogin",
			foreign: { id: "pane-1", told: { msg: "login" } },
		},
	]);
	expect(await entriesOf(soma.root, FOREIGN_BLOCKED)).toEqual([]);
	expect(soma.calls()).toBe(0);
});

test("a prompt whose screen gave no fingerprint is told, with nothing for the model to answer by", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(await database(), agents);

	agents.emitForeign(PANE, { state: "blocked", kind: "question", msg: "answer: which?" }, 10);
	await soma.settle();

	expect(await entriesOf(soma.root, NOTICE)).toHaveLength(1);
	expect(soma.calls()).toBe(0);
});

test("a foreign push reaches the human side through the push rule, which picks the interface that rings", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(await database(), agents);
	const human = await openHumanPort(soma.harness, soma.root, agents, context, { defaultTarget: "chat.telegram" });
	const seen: SomaEvent[] = [];
	human.subscribe((event) => seen.push(event));

	agents.emitForeign(PANE, bash, 10);
	await soma.settle();

	await vi.waitFor(() =>
		expect(seen.filter((event) => event.type === "notice")).toEqual([
			expect.objectContaining({ kind: "question", target: "chat.telegram" }),
		]),
	);
	await human.close();
});

test("observeForeign pushes a new prompt only while unwatched, and forgets the prompt told once past it", () => {
	const told = { fingerprint: "f00d", msg: "approve Bash: touch probe.txt" };
	expect(observeForeign(undefined, bash, false)).toBe("push");
	expect(observeForeign(undefined, bash, true)).toBe("none");
	expect(observeForeign(told, bash, false)).toBe("none");
	expect(observeForeign(told, { ...bash, fingerprint: "beef" }, false)).toBe("push");
	expect(observeForeign(told, { state: "working" }, false)).toBe("forget");
	// Another prompt, looked at: the agent is past the one told, so its pending push must not outlive it.
	expect(observeForeign(told, { ...bash, fingerprint: "beef" }, true)).toBe("forget");
	expect(observeForeign(told, bash, true)).toBe("none");
	expect(observeForeign(undefined, { state: "idle" }, false)).toBe("none");
});

describe("a foreign push that escalates", () => {
	const MIN = 60_000;
	const TERMINAL = "chat.terminal";
	const TELEGRAM = "chat.telegram";

	/** The human typed at the terminal, so the notice goes there first, and a clock the test moves. */
	async function escalating() {
		const agents = new FakeAgentPort();
		const soma = await core(await database(), agents);
		let clock = 100 * MIN;
		const human = await openHumanPort(soma.harness, soma.root, agents, context, {
			defaultTarget: TELEGRAM,
			now: () => clock,
			checkMs: 10,
		});
		const seen: SomaEvent[] = [];
		human.subscribe((event) => seen.push(event));
		await human.submit({ content: "嗨", entry: { kind: TERMINAL }, requestId: "terminal:1" });
		await soma.root.waitForIdle(context);
		clock += MIN;
		const questions = () =>
			seen.flatMap((event) => (event.type === "notice" && event.kind === "question" ? [event.target] : []));
		return {
			agents,
			soma,
			human,
			questions,
			advance: (ms: number) => {
				clock += ms;
			},
			settle: () => new Promise((resolve) => setTimeout(resolve, 60)),
		};
	}

	test("one still at its prompt after 15 minutes is pushed to the default interface once", async () => {
		const { agents, soma, human, questions, advance } = await escalating();
		agents.emitForeign(PANE, bash, 10);
		await soma.settle();
		await vi.waitFor(() => expect(questions()).toEqual([TERMINAL]));

		advance(16 * MIN);
		await vi.waitFor(() => expect(questions()).toEqual([TERMINAL, TELEGRAM]));
		await human.close();
	});

	test("one answered since, at its pane or by respond, is not pushed again", async () => {
		const { agents, soma, human, questions, advance, settle } = await escalating();
		agents.emitForeign(PANE, bash, 10);
		await soma.settle();
		await vi.waitFor(() => expect(questions()).toEqual([TERMINAL]));

		agents.emitForeign(PANE, { state: "working" }, 11);
		await soma.settle();
		advance(16 * MIN);
		await settle();
		expect(questions()).toEqual([TERMINAL]);
		await human.close();
	});

	test("one now at another prompt, looked at, is not pushed for the old one", async () => {
		const { agents, soma, human, questions, advance, settle } = await escalating();
		agents.emitForeign(PANE, bash, 10);
		await soma.settle();
		await vi.waitFor(() => expect(questions()).toEqual([TERMINAL]));

		agents.emitForeign(PANE, { ...bash, fingerprint: "beef", msg: "approve Bash: rm probe.txt" }, 11, true);
		await soma.settle();
		advance(16 * MIN);
		await settle();
		expect(questions()).toEqual([TERMINAL]);
		await human.close();
	});
});

test("a push whose commit failed leaves neither wake nor notice nor prompt told, so the model is never told of it", async () => {
	const agents = new FakeAgentPort();
	const soma = await core(await database(), agents, { next: () => true });

	agents.emitForeign(PANE, bash, 10);
	await soma.settle();

	expect(await entriesOf(soma.root, FOREIGN_BLOCKED)).toEqual([]);
	expect(await entriesOf(soma.root, NOTICE)).toEqual([]);
	expect(soma.calls()).toBe(0);
	expect((await soma.told()) ?? {}).toEqual({});
});

test("a push that failed is retried, and then told once: one notice, one wake", async () => {
	const agents = new FakeAgentPort();
	let failures = 1;
	const soma = await core(await database(), agents, { next: () => failures-- > 0 });

	agents.emitForeign(PANE, bash, 10);
	await soma.settle();
	expect(await entriesOf(soma.root, NOTICE)).toEqual([]);

	expect(await soma.bridge.retry()).toEqual([]);
	await soma.settle();
	expect(await entriesOf(soma.root, NOTICE)).toHaveLength(1);
	expect(await entriesOf(soma.root, FOREIGN_BLOCKED)).toHaveLength(1);
	expect(soma.calls()).toBe(1);

	// Nothing is left to retry, and the dialog is not told again.
	expect(await soma.bridge.retry()).toEqual([]);
	await soma.settle();
	expect(await entriesOf(soma.root, NOTICE)).toHaveLength(1);
	expect(soma.calls()).toBe(1);
});

test("a failed push is dropped, not retried, once the agent reports again or is no longer listed", async () => {
	const agents = new FakeAgentPort();
	let failing = true;
	const soma = await core(await database(), agents, { next: () => failing });

	agents.emitForeign(PANE, bash, 10);
	await soma.settle();
	// It moved on, and the report of that replaced the failed one.
	agents.emitForeign(PANE, { state: "working" }, 11);
	await soma.settle();
	failing = false;
	expect(await soma.bridge.retry()).toEqual([]);
	await soma.settle();
	expect(await entriesOf(soma.root, NOTICE)).toEqual([]);

	// Closed while blocked, before the retry.
	failing = true;
	agents.emitForeign(PANE, bash, 12);
	await soma.settle();
	agents.foreign.length = 0;
	failing = false;
	expect(await soma.bridge.retry()).toEqual([]);
	await soma.settle();
	expect(await entriesOf(soma.root, NOTICE)).toEqual([]);
	expect(soma.calls()).toBe(0);
});

test("listen retries a failed push by itself on its interval", async () => {
	const agents = new FakeAgentPort();
	// core() listens too, so the one report is handled twice, and both fail.
	let failures = 2;
	const errors: unknown[] = [];
	const soma = await core(await database(), agents, { next: () => failures-- > 0 });
	const unlisten = soma.bridge.listen((error) => errors.push(error), 20);

	agents.emitForeign(PANE, bash, 10);
	await vi.waitFor(async () => expect(await entriesOf(soma.root, NOTICE)).toHaveLength(1));
	unlisten();
	await soma.settle();

	expect(errors).toHaveLength(1);
	expect(await entriesOf(soma.root, FOREIGN_BLOCKED)).toHaveLength(1);
	expect(soma.calls()).toBe(1);
});
