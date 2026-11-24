import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { createRexAgentPort } from "../../../src/adapters/rex/agent-port.ts";
import { readBlockedScreen } from "../../../src/agent-cli/permission/blocked-screen.ts";
import { FOREIGN_BLOCKED, ForeignPrompts, foreignBridge } from "../../../src/core/extensions/dispatch/foreign.ts";
import { dispatchExtension } from "../../../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../../../src/core/harness.ts";
import type { ForeignStatusEvent } from "../../../src/ports/agent.ts";
import { AT, AT_US, type Block, fixture, HANGAR, rex } from "./fake.ts";

const context = BACKGROUND_CONTEXT;
const open: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function until(ok: () => boolean, ms = 2_000): Promise<void> {
	for (const deadline = Date.now() + ms; !ok(); await new Promise((resolve) => setTimeout(resolve, 5))) {
		if (Date.now() > deadline) throw new Error("timed out");
	}
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const BASH = fixture("claude-bash-prompt-2.1.302.txt");
const prompt = readBlockedScreen(BASH).prompt;
// The prompt as claude has drawn only its top half: no options yet, so nothing parses.
const HALF = BASH.split("\n")
	.slice(0, Math.floor(BASH.split("\n").length / 2))
	.join("\n");
const FOREIGN_MS = 40;

/**
 * The real core's foreign bridge over the rex adapter on the in-memory rex, polling every FOREIGN_MS, with a human's
 * claude blocked at a Bash prompt in the session `work`, its screen `screen`. `events` holds what the adapter emitted.
 */
async function watching(screen: string) {
	const directory = await mkdtemp(join(tmpdir(), "soma-rex-foreign-bridge-"));
	directories.push(directory);
	const claude: Block = {
		name: "Window 1",
		block: "block:w1",
		argv0: "claude",
		records: [{ state: "blocked", kind: "permission", updated_at: AT }],
		screen,
	};
	const fake = rex([], [{ id: "session:work", label: "work", blocks: [claude] }]);
	const agents = createRexAgentPort({
		label: "soma-test",
		client: fake.client,
		sessionId: HANGAR,
		projectsDir: join(directory, "projects"),
		sessionsDir: join(directory, "sessions"),
		processStart: async () => undefined,
		redrawMs: 0,
		foreignMs: FOREIGN_MS,
	});

	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("好。")));
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await openHarness(
		join(directory, "soma.sqlite"),
		[dispatchExtension(agents, async (_repo, card) => `# ${card}`)],
		context,
		{ models },
	);
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const bridge = foreignBridge(root, agents, context);
	const events: ForeignStatusEvent[] = [];
	const handled: Promise<void>[] = [];
	const off = agents.onForeignStatus((event) => {
		events.push(event);
		handled.push(bridge.handle(event));
	});
	const settle = async () => {
		off();
		await Promise.all(handled);
		await root.waitForIdle(context);
	};
	const wakes = async () =>
		(await root.entries({}, 1000, undefined, context)).items.filter((entry) => entry.kind === FOREIGN_BLOCKED);
	const told = async () => (await harness.snapshot(ForeignPrompts, root.id, context))?.told;
	return { claude, events, settle, wakes, told, calls: () => faux.state.callCount };
}

test("a foreign prompt read half drawn is emitted again once its fingerprint is read, and wakes the model once", async () => {
	expect(prompt).toBeDefined();
	expect(readBlockedScreen(HALF).prompt).toBeUndefined();
	const { claude, events, settle, wakes, told, calls } = await watching(HALF);

	await until(() => events.length === 1);
	expect(events[0]).toMatchObject({ seq: AT_US, watched: false, agent: { id: "block:w1" } });
	expect(events[0]?.agent.status).not.toHaveProperty("fingerprint");

	// claude finishes drawing the prompt; its record, and so its seq, stays as it was.
	claude.screen = BASH;
	await until(() => events.length === 2);
	// Several polls more read the same record and the same prompt: nothing new.
	await pause(FOREIGN_MS * 6);
	await settle();

	expect(events).toHaveLength(2);
	expect(events[1]).toMatchObject({
		watched: false,
		agent: { id: "block:w1", status: { state: "blocked", fingerprint: prompt?.fingerprint } },
	});
	expect(events[1]?.seq).not.toBe(AT_US);
	const woken = await wakes();
	expect(woken).toHaveLength(1);
	expect(JSON.stringify(woken[0]?.model)).toContain(`fingerprint=${prompt?.fingerprint}`);
	expect(woken[0]?.data).toMatchObject({ id: "block:w1", seq: events[1]?.seq });
	expect(calls()).toBe(1);
	expect((await told())?.["block:w1"]).toMatchObject({ fingerprint: prompt?.fingerprint });
});

test("a foreign prompt drawn at the first poll is emitted once, with its fingerprint, under the record's seq", async () => {
	const { events, settle, wakes, calls } = await watching(BASH);

	await until(() => events.length === 1);
	await pause(FOREIGN_MS * 6);
	await settle();

	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		seq: AT_US,
		watched: false,
		agent: { id: "block:w1", status: { state: "blocked", fingerprint: prompt?.fingerprint } },
	});
	expect(await wakes()).toHaveLength(1);
	expect(calls()).toBe(1);
});
