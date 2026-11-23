import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { repoRootOf } from "../src/adapters/repos/root.ts";
import { Deferrals, deferExtension } from "../src/core/extensions/defer/index.ts";
import { dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import type { HandoffRequest } from "../src/ports/defer.ts";

// What the drop directory adds to a hand-off: the request file's name and its time.
const context = BACKGROUND_CONTEXT;
const SESSION = "7e33597b-e33d-4c6d-a700-e21b2f54223e";
const HOUR = 3_600_000;
const open: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function core() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "soma-drop-core-")));
	directories.push(directory);
	const agents = new FakeAgentPort();
	const defers = deferExtension(agents, { repoRoot: repoRootOf });
	const harness = await openHarness(
		join(directory, "soma.sqlite"),
		[dispatchExtension(agents, async () => ""), defers.extension],
		context,
	);
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	return {
		handoff: (fields: Partial<HandoffRequest>) =>
			defers.defer(
				root,
				{ session: SESSION, cwd: directory, at: "PT1H", instruction: "tell me the word", ...fields },
				context,
			),
		items: async () => (await harness.snapshot(Deferrals, root.id, context))?.items ?? {},
	};
}

test("the same request read twice makes one deferral, which keeps its name, and gets the same reply", async () => {
	const soma = await core();
	const setAt = Date.now() - 1_000;

	const first = await soma.handoff({ request: "req-1", setAt });
	const again = await soma.handoff({ request: "req-1", setAt });

	expect(first).toMatchObject({ accepted: true });
	expect(again).toEqual(first);
	const items = Object.values(await soma.items());
	expect(items).toHaveLength(1);
	expect(items[0]?.request).toBe("req-1");
});

test("a duration counts from the request's setAt, which is kept as the time the session asked", async () => {
	const soma = await core();
	const setAt = Date.now() - HOUR / 2;

	const reply = await soma.handoff({ request: "req-1", setAt });

	expect(reply).toEqual({ accepted: true, id: expect.any(String), at: new Date(setAt + HOUR).toISOString() });
	expect(Object.values(await soma.items())).toEqual([expect.objectContaining({ setAt, at: setAt + HOUR })]);
});

test("a request whose time had passed when soma read it is refused and records nothing", async () => {
	const soma = await core();
	const setAt = Date.now() - 2 * HOUR;

	expect(await soma.handoff({ request: "req-1", setAt })).toEqual({
		accepted: false,
		reason: `its time, ${new Date(setAt + HOUR).toISOString()}, had passed when soma read the request`,
	});
	expect(await soma.items()).toEqual({});
});
