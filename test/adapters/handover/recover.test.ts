import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
	createHandoverAgentPort,
	HANDOVER_GRACE_MS,
	type HandoverAgentPortOptions,
} from "../../../src/adapters/handover/agent-port.ts";
import { seqOf } from "../../../src/adapters/rex/agent-port.ts";
import { RexRpcError, RexTransportError } from "../../../src/adapters/rex/client.ts";
import { type AgentStatusEvent, PromptRefused } from "../../../src/ports/agent.ts";
import type { Settled } from "../../../src/ports/handover.ts";
import { cleanUp, SESSION } from "../acp/fake.ts";
import { type Block, fixture, HANGAR } from "../rex/fake.ts";
import { AT_IDLE, alive, fakeClock, sides, sleep } from "./fake.ts";

afterEach(cleanUp);

type Sides = Awaited<ReturnType<typeof sides>>;

const never = () => new Promise<never>(() => {});

async function until(ok: () => boolean | Promise<boolean>, what: string) {
	for (const deadline = Date.now() + 5_000; !(await ok()); await sleep(5)) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
	}
}

/** Every session.new_window from now on goes through `around`, given the real one to open the window with. */
function aroundWindow(both: Sides, around: (open: () => Promise<unknown>) => Promise<unknown>) {
	const original = both.hangar.client.call.bind(both.hangar.client);
	both.hangar.client.call = (async (method: string, payload: unknown, schema: never) =>
		method === "session.new_window"
			? around(() => original(method, payload, schema))
			: original(method, payload, schema)) as typeof both.hangar.client.call;
}

/**
 * A soma that dies with a handover of card-a under way, past the mark and with its ACP process gone: `before` its window
 * opens, or `after`, before the final mark. Nothing of it runs on: its take hangs where the kill would have fallen, and
 * what the next soma finds is the sessions file, the transcripts and the hangar.
 */
async function died(
	when: "before" | "after",
	{ alongside, clock }: { alongside?: string; clock?: ReturnType<typeof fakeClock> } = {},
) {
	const first = await sides();
	await first.ran();
	if (alongside !== undefined) await first.ran(alongside);
	const [pid] = await first.pids();
	if (when === "after") {
		aroundWindow(first, async (open) => {
			await open();
			return never();
		});
	}
	const dying = createHandoverAgentPort({
		from: first.acp.port,
		to: when === "before" ? { ...first.onRex, take: never } : first.onRex,
		onError: () => {},
		...(clock === undefined ? {} : { now: clock.now }),
	});
	void dying.handOver("card-a");
	await until(() => !alive(pid as number), "the ACP process to end");
	if (when === "after") await until(() => first.blocks.length === 1, "the window to open");
	await first.acp.end();
	return first;
}

/** The soma after `first`, once its startup has looked at whatever was left in progress. */
async function restarted(first: Sides, more: Omit<Parameters<typeof sides>[0] & {}, "restartOf" | "blocks"> = {}) {
	const both = await sides({ restartOf: first.acp.cwd, blocks: first.blocks, ...more });
	await both.agents.dormant();
	return both;
}

/** card-a is dormant on ACP and its next prompt goes on in the same session, on a process of its own. */
async function goesOnOverAcp(both: Sides, first: Sides) {
	const { acpSessionId } = await first.entry();
	expect(await both.agents.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
	expect(await both.pids()).toEqual([]);
	const from = both.acp.events.length;
	await both.agents.prompt("card-a", "RECALL");
	await both.acp.until("done", from);
	expect((await both.agents.readResult("card-a"))?.text).toBe("recall: the word is KIWI");
	expect((await both.entry()).acpSessionId).toBe(acpSessionId);
	expect(await both.pids()).toHaveLength(1);
	expect(both.typed()).toEqual([]);
	expect(both.blocks).toEqual([]);
}

/** card-a is listed from its window and handled there, and nothing runs for it over ACP. */
async function goesOnInWindow(both: Sides) {
	const { acpSessionId } = await both.entry();
	expect(await both.agents.list()).toMatchObject([
		{ name: "card-a", sessionId: acpSessionId, status: { state: "idle" } },
	]);
	await both.agents.prompt("card-a", "are you there");
	expect(both.typed()).toEqual(["are you there"]);
	expect(await both.pids()).toEqual([]);
	expect(await readFile(join(both.acp.cwd, "..", "projects", "loaded"), "utf8").catch(() => "")).toBe("");
	expect(both.blocks).toHaveLength(1);
}

test("the mark of a handover in progress is on disk before the session closes, and the window opens only after", async () => {
	const both = await sides();
	await both.ran();
	const marks: { handingOver?: true; handedOver?: true; hangar?: string }[] = [];
	const closedThen: string[] = [];
	aroundWindow(both, async (open) => {
		marks.push(await both.entry());
		closedThen.push(await both.closed());
		return open();
	});

	await both.agents.handOver("card-a");

	expect(marks).toMatchObject([{ handingOver: true, hangar: HANGAR }]);
	expect(marks[0]?.handedOver).toBeUndefined();
	expect(closedThen).toEqual([expect.stringContaining((await both.entry()).acpSessionId)]);
	const final = await both.entry();
	expect(final.handedOver).toBe(true);
	expect(final.handingOver).toBeUndefined();
	expect(final.hangar).toBeUndefined();
});

test("a soma killed after the mark and before the window: the next one has the job dormant on ACP, and it goes on in its session", async () => {
	const first = await died("before");
	expect((await first.entry()).handingOver).toBe(true);
	expect(first.blocks).toEqual([]);

	const both = await restarted(first);

	expect(await both.agents.dormant()).toEqual(["card-a"]);
	const entry = await both.entry();
	expect(entry.handingOver).toBeUndefined();
	expect(entry.handedOver).toBeUndefined();
	await goesOnOverAcp(both, first);
	expect(both.windowsOpened()).toEqual([]);
	const loaded = await readFile(join(both.acp.cwd, "..", "projects", "loaded"), "utf8");
	expect(loaded).toContain(entry.acpSessionId);
});

test("a soma killed after the window opened and before the final mark: the next one routes the job to the window, with no ACP process", async () => {
	const first = await died("after");
	const left = await first.entry();
	expect(left.handingOver).toBe(true);
	expect(left.handedOver).toBeUndefined();

	const both = await restarted(first);

	expect(await both.agents.dormant()).toEqual([]);
	const entry = await both.entry();
	expect(entry.handedOver).toBe(true);
	expect(entry.handingOver).toBeUndefined();
	await goesOnInWindow(both);
	expect(both.windowsOpened()).toEqual([]);
	expect(await both.agents.handOver("card-a")).toMatchObject({ handedOver: false, refusal: "not_acp" });
	await expect(
		both.agents.start({ name: "card-a", card: "card-a", cwd: both.acp.cwd, sessionId: SESSION }),
	).rejects.toThrow("handed over");
});

test("a window whose claude has exited still counts: after a restart the job is on rex, and no ACP process starts", async () => {
	const first = await died("after");
	const window = first.blocks[0] as Block;
	window.argv0 = "-fish";
	window.records = [];

	const both = await restarted(first);

	expect((await both.entry()).handedOver).toBe(true);
	expect((await both.agents.list()).map(({ name }) => name)).toEqual(["card-a"]);
	await expect(both.agents.prompt("card-a", "are you there")).rejects.toThrow(PromptRefused);
	expect(await both.pids()).toEqual([]);
	expect(both.typed()).toEqual([]);
});

test.each([
	["placed in no window", { detached: true }],
	["in a window of another name", { name: "renamed" }],
])("a block of the job's label %s is undecided: no final mark, and no ACP process", async (_name, block) => {
	const first = await died("after");
	Object.assign(first.blocks[0] as Block, block);

	const both = await restarted(first);

	const entry = await both.entry();
	expect(entry.handedOver).toBeUndefined();
	expect(entry.handingOver).toBe(true);
	expect(await both.agents.dormant()).toEqual([]);
	await heldOff(both, []);
	expect(both.said).toEqual([expect.stringContaining("in no window a listing reads")]);
});

test("a labelled block in no window that is placed later puts the job on rex at the next look", async () => {
	const first = await died("after");
	const block = first.blocks[0] as Block;
	block.detached = true;
	const placed = await restarted(first);
	expect((await placed.entry()).handingOver).toBe(true);
	block.detached = false;

	expect(await placed.agents.list()).toMatchObject([{ name: "card-a", status: { state: "idle" } }]);

	expect((await placed.entry()).handedOver).toBe(true);
	await placed.agents.prompt("card-a", "are you there");
	expect(placed.typed()).toEqual(["are you there"]);
});

test("a labelled block in no window that closes sends the job back to ACP at the next look", async () => {
	const first = await died("after");
	(first.blocks[0] as Block).detached = true;
	const both = await restarted(first);
	expect((await both.entry()).handingOver).toBe(true);
	first.blocks.length = 0;

	expect(await both.agents.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);

	expect((await both.entry()).handingOver).toBeUndefined();
	await goesOnOverAcp(both, first);
});

test("a new_window that fails leaving a block in no window: undecided, with no adopting and no final mark", async () => {
	const both = await sides({ opened: { detached: true } });
	await both.ran();
	aroundWindow(both, async (open) => {
		await open();
		throw new RexTransportError("rex connection closed");
	});

	const outcome = await both.agents.handOver("card-a");

	expect(outcome).toMatchObject({
		handedOver: false,
		refusal: "cannot_resume",
		reason: expect.stringContaining("the job is undecided"),
	});
	expect((await both.entry()).handingOver).toBe(true);
	await expect(both.agents.prompt("card-a", "now")).rejects.toThrow(PromptRefused);
	(both.blocks[0] as Block).detached = false;
	expect(await both.agents.list()).toMatchObject([{ name: "card-a", status: { state: "idle" } }]);
	expect((await both.entry()).handedOver).toBe(true);
});

test("a new_window rex plainly refuses that leaves a block in no window: undecided, never given back, or two would write", async () => {
	const both = await sides({ opened: { detached: true } });
	await both.ran();
	const pids = await both.pids();
	aroundWindow(both, async (open) => {
		await open();
		throw new RexRpcError("session.new_window", "refused", "no window for you", 400);
	});

	const outcome = await both.agents.handOver("card-a");

	expect(outcome).toMatchObject({
		handedOver: false,
		refusal: "cannot_resume",
		reason: expect.stringContaining("in no window a listing reads"),
	});
	expect((outcome as { reason: string }).reason).not.toContain("stays on ACP");
	expect(await both.agents.dormant()).toEqual([]);
	await heldOff(both, pids);
});

test("a window of the job's name with another label is not its window: the job goes back to ACP", async () => {
	const first = await died("before");
	first.blocks.push({ name: "card-a", block: "block:namesake", label: "another", argv0: "claude", records: [] });

	const both = await restarted(first);

	expect(await both.agents.dormant()).toEqual(["card-a"]);
	expect((await both.entry()).handedOver).toBeUndefined();
});

test.each([
	["throws", new Error("session.new_window: rex refused")],
	["has its reply lost", new RexTransportError("session.new_window: no response within 10000 ms")],
])(
	"a new_window that %s with the window open: handed over, and a later prompt reaches the window, with no ACP process",
	async (_name, failure) => {
		const both = await sides();
		await both.ran();
		const [pid] = await both.pids();
		const { acpSessionId } = await both.entry();
		aroundWindow(both, async (open) => {
			await open();
			throw failure;
		});

		expect(await both.agents.handOver("card-a")).toEqual({
			handedOver: true,
			window: "card-a",
			session: "hangar",
			sessionId: acpSessionId,
			ready: true,
		});

		expect((await both.entry()).handedOver).toBe(true);
		expect(both.blocks).toHaveLength(1);
		await both.agents.prompt("card-a", "are you there");
		expect(both.typed()).toEqual(["are you there"]);
		expect(alive(pid as number)).toBe(false);
		expect(await both.pids()).toEqual([pid]);
		expect(await readFile(join(both.acp.cwd, "..", "projects", "loaded"), "utf8").catch(() => "")).toBe("");
	},
);

test("a new_window whose reply was lost still gets its trust dialog answered, with no status of it reaching the core", async () => {
	const both = await sides({ opened: { records: [], screen: fixture("claude-trust-dialog-2.1.302.txt") } });
	const heard: string[] = [];
	const off = both.agents.onStatus((event) => heard.push(event.status.state));
	await both.ran();
	aroundWindow(both, async (open) => {
		await open();
		throw new RexTransportError("rex connection closed");
	});
	const pressed: string[] = [];
	both.hangar.replace("block.event", (payload) => {
		const { key, action } = (payload.event as { payload: { key: string; action: string } }).payload;
		if (action === "press") pressed.push(key);
		if (action === "press" && key === "enter") {
			setTimeout(
				() => (both.blocks[0] as Block).records?.push({ state: "idle", updated_at: "2026-10-27T01:02:03Z" }),
				5,
			);
		}
		return both.hangar.original("block.event")(payload);
	});

	expect(await both.agents.handOver("card-a")).toMatchObject({ handedOver: true, ready: true });

	expect(pressed).toEqual(["arrow_down", "enter"]);
	expect(heard).not.toContain("blocked");
	off();
});

test("a new_window whose reply was lost, in a window whose claude has exited: the job is on rex, and says not ready", async () => {
	const both = await sides({ opened: { records: [], argv0: "-fish", screen: "$" } });
	await both.ran();
	aroundWindow(both, async (open) => {
		await open();
		throw new RexTransportError("rex connection closed");
	});

	expect(await both.agents.handOver("card-a")).toMatchObject({ handedOver: true, ready: false });

	expect((await both.entry()).handedOver).toBe(true);
	expect((await both.agents.list()).map(({ name }) => name)).toEqual(["card-a"]);
	expect(both.typed()).toEqual([]);
});

test("a release that throws past its mark gives the job back, and names the return as its entry does", async () => {
	const both = await sides({
		from: (port) => ({
			...port,
			release: async (agent, mark) => {
				await port.release(agent, mark);
				throw new Error("the close went wrong");
			},
		}),
	});
	await both.ran();

	const outcome = await both.agents.handOver("card-a");

	const { givenBack } = await both.entry();
	expect(givenBack).toEqual(expect.any(Number));
	expect(outcome).toMatchObject({ handedOver: false, refusal: "cannot_resume", back: givenBack });
});

test("a new_window rex plainly refuses, with no window open: back on ACP at once, with today's refusal, and it goes on in its session", async () => {
	const clock = fakeClock();
	const both = await sides({ clock });
	await both.ran();
	aroundWindow(both, () => Promise.reject(new RexRpcError("session.new_window", "refused", "no window for you", 400)));

	expect(await both.agents.handOver("card-a")).toEqual({
		handedOver: false,
		refusal: "cannot_resume",
		reason:
			"session.new_window: refused: no window for you. Its ACP process has ended and the job stays on ACP: its next " +
			"prompt starts it again in its session",
		back: clock.now(),
	});

	const entry = await both.entry();
	expect(entry.handingOver).toBeUndefined();
	expect(entry.handedOver).toBeUndefined();
	expect(await both.agents.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
	const from = both.acp.events.length;
	await both.agents.prompt("card-a", "RECALL");
	await both.acp.until("done", from);
	expect((await both.agents.readResult("card-a"))?.text).toBe("recall: the word is KIWI");
	expect(both.typed()).toEqual([]);
});

test.each([
	[
		"a window of its name opened since",
		(both: Sides) => {
			both.blocks.push({ name: "card-a", block: "block:namesake", label: "another" });
		},
	],
	[
		"a read that failed before any window was asked for",
		(both: Sides) => {
			const original = both.hangar.client.call.bind(both.hangar.client);
			let failed = false;
			both.hangar.client.call = (async (method: string, payload: unknown, schema: never) => {
				if (method === "session.view" && !failed) {
					failed = true;
					throw new RexTransportError("session.view: no response within 10000 ms");
				}
				return original(method, payload, schema);
			}) as typeof both.hangar.client.call;
		},
	],
])("a take that never asked for a window, for %s, gives the job back at once", async (_name, arrange) => {
	const clock = fakeClock();
	const both = await sides({ clock });
	await both.ran();
	arrange(both);
	const agents = createHandoverAgentPort({
		from: both.acp.port,
		to: { ...both.onRex, takeable: async () => undefined },
		onError: both.onError,
		now: clock.now,
	});

	expect(await agents.handOver("card-a")).toMatchObject({ reason: expect.stringContaining("stays on ACP") });

	expect((await both.entry()).handingOver).toBeUndefined();
	expect(both.windowsOpened()).toEqual([]);
});

/** A soma whose card-a take gave up on `session.new_window`, 10 s in, on `clock`, with rex maybe still at it. */
async function gaveUp(
	clock: ReturnType<typeof fakeClock>,
	failure = new RexTransportError("no response within 10000 ms"),
) {
	const both = await sides({ clock });
	await both.ran();
	aroundWindow(both, async () => {
		clock.advance(10_000);
		throw failure;
	});
	return { both, outcome: await both.agents.handOver("card-a") };
}

/** The window rex opens for card-a after all, late, as session.new_window would make it. */
const opensLate = async (both: Sides) => {
	const { acpSessionId, cwd } = await both.entry();
	both.blocks.push({
		name: "card-a",
		block: "block:late",
		label: acpSessionId,
		argv0: "claude",
		cwd,
		records: [AT_IDLE],
	});
};

test.each([
	["its reply was lost", new RexTransportError("rex connection closed")],
	["it timed out", new RexTransportError("session.new_window: no response within 10000 ms")],
	["its reply was off the schema", new Error("Invalid input")],
])(
	"a take that failed because %s stays undecided, saying so and why, and not that it stays on ACP",
	async (_name, failure) => {
		const clock = fakeClock();
		const before = clock.now();

		const { both, outcome } = await gaveUp(clock, failure);

		expect(outcome).toMatchObject({ handedOver: false, refusal: "cannot_resume" });
		const { reason } = outcome as { reason: string };
		expect(reason).toContain(failure.message);
		expect(reason).toContain("the job is undecided");
		expect(reason).toContain("grace period, 60 s from now");
		expect(reason).not.toContain("stays on ACP");
		const entry = await both.entry();
		expect(entry.handingOver).toBe(true);
		// When the take failed, not when the mark was written.
		expect(entry.handingOverAt).toBe(before + 10_000);
		await heldOff(both, await both.pids());
		expect(both.said).toEqual([expect.stringContaining("card-a is undecided: its window may still open")]);
	},
);

test("a window a later look finds says nothing until the listener has recorded the landing, then what it says now, once", async () => {
	const clock = fakeClock();
	const { both } = await gaveUp(clock);
	const heard: AgentStatusEvent[] = [];
	const off = both.agents.onStatus((event) => heard.push(event));
	const working = { state: "working", updated_at: "2026-10-27T01:02:06.000000+08:00" };
	let during: AgentStatusEvent[] | undefined;
	const offSettled = both.agents.onSettled(async (settled) => {
		if (settled.onto !== "rex") return;
		const window = both.blocks[0] as Block;
		window.records = [working];
		both.hangar.emit(both.hangar.status(window.block, working));
		await sleep(30);
		during = [...heard];
	});
	await opensLate(both);

	await both.agents.list();
	await until(() => during !== undefined && heard.length > 0, "what the window says");

	expect(during).toEqual([]);
	expect(heard).toEqual([{ agent: "card-a", status: { state: "working" }, seq: seqOf(working) }]);
	off();
	offSettled();
});

test("the grace period is 60 s", () => {
	expect(HANDOVER_GRACE_MS).toBe(60_000);
});

test("a window that opens at 59 s puts the job on rex, at the next look, with no ACP process", async () => {
	const clock = fakeClock();
	const { both } = await gaveUp(clock);
	const pids = await both.pids();

	clock.advance(30_000);
	await expect(both.agents.prompt("card-a", "at 30 s")).rejects.toThrow("grace period, 30 s from now");
	expect(await both.agents.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
	clock.advance(29_000);
	await opensLate(both);

	await both.agents.prompt("card-a", "at 59 s");

	expect(both.typed()).toEqual(["at 59 s"]);
	expect((await both.entry()).handedOver).toBe(true);
	expect((await both.entry()).handingOver).toBeUndefined();
	expect(await both.pids()).toEqual(pids);
	expect(await readFile(join(both.acp.cwd, "..", "projects", "loaded"), "utf8").catch(() => "")).toBe("");
});

test.each([
	["a listing", (both: Sides) => both.agents.list()],
	["a prompt", (both: Sides) => both.agents.prompt("card-a", "RECALL")],
])(
	"a window that never opens: the job goes back to ACP only at a look at or after the end, here %s",
	async (_name, looks) => {
		const clock = fakeClock();
		const { both } = await gaveUp(clock);

		clock.advance(59_999);
		await expect(both.agents.prompt("card-a", "too soon")).rejects.toThrow("grace period, 1 s from now");
		expect(await both.agents.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
		expect((await both.entry()).handingOver).toBe(true);
		clock.advance(1);

		await looks(both);

		const entry = await both.entry();
		expect(entry.handingOver).toBeUndefined();
		expect(entry.handedOver).toBeUndefined();
		expect(await both.agents.list()).toMatchObject([{ name: "card-a", sessionId: SESSION }]);
		expect(both.said).toContain("card-a was left mid-handover and no window of it is open: it is dormant on ACP");
	},
);

test("at the end of the grace period a look is made with no caller: no window, back on ACP", async () => {
	const clock = fakeClock();
	const both = await sides({ clock, graceMs: 40 });
	await both.ran();
	aroundWindow(both, () => Promise.reject(new RexTransportError("no response within 10000 ms")));

	await both.agents.handOver("card-a");
	expect((await both.entry()).handingOver).toBe(true);
	clock.advance(40);

	await until(async () => (await both.entry()).handingOver === undefined, "the look at the end of the grace period");
	expect((await both.entry()).handedOver).toBeUndefined();
});

test("at the end of the grace period a look is made with no caller: a window opened within it, on rex", async () => {
	const clock = fakeClock();
	const both = await sides({ clock, graceMs: 40 });
	await both.ran();
	aroundWindow(both, () => Promise.reject(new RexTransportError("no response within 10000 ms")));

	await both.agents.handOver("card-a");
	await opensLate(both);
	clock.advance(40);

	await until(async () => (await both.entry()).handedOver === true, "the look at the end of the grace period");
	expect(await both.agents.list()).toMatchObject([{ name: "card-a", status: { state: "idle" } }]);
});

test("a look that fails at the end of the grace period gives nothing back, and the next one after rex answers does", async () => {
	const clock = fakeClock();
	const { both } = await gaveUp(clock);
	clock.advance(60_000);
	both.rexDown();

	await expect(both.agents.prompt("card-a", "now")).rejects.toThrow("rex does not answer");

	expect((await both.entry()).handingOver).toBe(true);
	both.rexUp();
	await both.agents.list();
	expect((await both.entry()).handingOver).toBeUndefined();
});

/** A take whose window may have opened, after which rex stopped answering, so the job is held for rex. */
async function rexGoneAtTake(both: Sides, opens: boolean) {
	aroundWindow(both, async (open) => {
		if (opens) await open();
		both.rexDown();
		throw new RexTransportError("session.new_window: no response within 10000 ms");
	});
	expect(await both.agents.handOver("card-a")).toMatchObject({
		reason: expect.stringContaining("whether its window opened is not known"),
	});
}

/** Every Settled the port tells from now on. */
function settledOf(both: Sides) {
	const settled: Settled[] = [];
	both.agents.onSettled((each) => {
		settled.push(each);
	});
	return settled;
}

test("a job rex did not answer about at its take is looked at with no caller at the end of the grace period: on rex, told once", async () => {
	const clock = fakeClock();
	const both = await sides({ clock, graceMs: 40 });
	await both.ran();
	const settled = settledOf(both);
	await rexGoneAtTake(both, true);
	both.rexUp();
	clock.advance(40);

	await until(async () => (await both.entry()).handedOver === true, "a look with no caller");

	await until(() => settled.length > 0, "the Settled of the look");
	await sleep(100);
	expect(settled).toEqual([expect.objectContaining({ agent: "card-a", onto: "rex", window: "card-a" })]);
	expect((await both.entry()).handingOver).toBeUndefined();
	expect(both.said.filter((line) => line.includes("undecided"))).toHaveLength(1);
});

test.each([
	["after", "rex"],
	["before", "acp"],
] as const)(
	"at startup with rex down, a soma killed %s the window opened is looked at with no caller once rex is back: on %s, told once",
	async (when, onto) => {
		const clock = fakeClock();
		const first = await died(when, { clock });
		const both = await restarted(first, { clock, graceMs: 40, rexDown: true });
		const settled = settledOf(both);
		expect((await both.entry()).handingOver).toBe(true);
		both.rexUp();
		clock.advance(40);

		await until(async () => (await both.entry()).handingOver === undefined, "a look with no caller");

		await until(() => settled.length > 0, "the Settled of the look");
		await sleep(100);
		expect(settled).toEqual([expect.objectContaining({ agent: "card-a", onto })]);
		expect((await both.entry()).handedOver).toBe(onto === "rex" ? true : undefined);
		expect(both.said.filter((line) => line.includes("undecided"))).toEqual([
			expect.stringContaining("card-a is undecided: rex does not answer"),
		]);
	},
);

test("rex still not answering: the job stays undecided and is looked at again every interval, logged once, until a look settles it", async () => {
	const clock = fakeClock();
	const looks: number[] = [];
	const both = await sides({
		clock,
		graceMs: 40,
		to: (port) => ({
			...port,
			holds: (session, hangar) => {
				looks.push(Date.now());
				return port.holds(session, hangar);
			},
		}),
	});
	await both.ran();
	await rexGoneAtTake(both, true);
	clock.advance(40);

	await until(() => looks.length >= 4, "three looks with no caller");

	for (const [i, at] of looks.slice(1).entries()) expect(at - (looks[i] as number)).toBeGreaterThanOrEqual(35);
	expect((await both.entry()).handingOver).toBe(true);
	expect(both.said.filter((line) => line.includes("undecided"))).toEqual([
		expect.stringContaining("card-a is undecided: rex does not answer"),
	]);

	both.rexUp();
	await until(async () => (await both.entry()).handedOver === true, "the look once rex answers");
	const settledAt = looks.length;
	await sleep(150);
	expect(looks).toHaveLength(settledAt);
});

test("a job rex did not answer about is looked at again no sooner than the end of its grace period, however short the interval", async () => {
	const clock = fakeClock();
	const looks: number[] = [];
	const both = await sides({
		clock,
		graceMs: 300,
		relookMs: 20,
		to: (port) => ({
			...port,
			holds: (session, hangar) => {
				looks.push(Date.now());
				return port.holds(session, hangar);
			},
		}),
	});
	await both.ran();
	await rexGoneAtTake(both, true);

	await sleep(150);
	expect(looks).toHaveLength(1);
	await until(() => looks.length >= 3, "looks past the grace period");
	expect((looks[1] as number) - (looks[0] as number)).toBeGreaterThanOrEqual(250);
});

test("a restart inside the grace period waits out the rest, and one past it is resolved at once", async () => {
	const clock = fakeClock();
	const first = await died("before", { clock });
	clock.advance(59_999);

	const within = await restarted(first, { clock });

	expect(await within.agents.dormant()).toEqual([]);
	expect((await within.entry()).handingOver).toBe(true);
	await heldOff(within, []);
	await expect(within.agents.prompt("card-a", "now")).rejects.toThrow("grace period, 1 s from now");
	await within.acp.end();
	clock.advance(1);

	const past = await restarted(first, { clock });

	expect(await past.agents.dormant()).toEqual(["card-a"]);
	expect((await past.entry()).handingOver).toBeUndefined();
	await goesOnOverAcp(past, first);
});

test("a restart inside the grace period looks at the end of it, with no caller", async () => {
	const clock = fakeClock();
	const first = await died("before", { clock });

	const both = await restarted(first, { clock, graceMs: 200 });

	expect(await both.agents.dormant()).toEqual([]);
	expect((await both.entry()).handingOver).toBe(true);
	clock.advance(200);
	await until(async () => (await both.entry()).handingOver === undefined, "the look at the end of the grace period");
	expect(await both.agents.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
});

test("the grace period of a restart counts from when the take failed, not from when the mark was written", async () => {
	const clock = fakeClock();
	const { both: first } = await gaveUp(clock);
	await first.acp.end();
	clock.advance(55_000);

	const within = await restarted(first, { clock });

	expect((await within.entry()).handingOver).toBe(true);
	await expect(within.agents.prompt("card-a", "now")).rejects.toThrow("grace period, 5 s from now");
});

test("a window found at a restart inside the grace period puts the job on rex at once", async () => {
	const clock = fakeClock();
	const first = await died("after", { clock });

	const both = await restarted(first, { clock });

	expect((await both.entry()).handedOver).toBe(true);
	await goesOnInWindow(both);
});

test("a mark from before marks had a time is older than the grace period: resolved at once", async () => {
	const clock = fakeClock();
	const first = await died("before", { clock });
	const { handingOverAt: _written, ...entry } = await first.entry();
	await writeFile(first.acp.sessionsFile, `${JSON.stringify({ "card-a": entry })}\n`);

	const both = await restarted(first, { clock });

	expect(await both.agents.dormant()).toEqual(["card-a"]);
	expect((await both.entry()).handingOver).toBeUndefined();
});

test("a mark an hour ahead of the clock counts as now: the job waits out one grace period, not 3660 s", async () => {
	const clock = fakeClock();
	const first = await died("before", { clock });
	const ahead = { ...(await first.entry()), handingOverAt: clock.now() + 3_600_000 };
	await writeFile(first.acp.sessionsFile, `${JSON.stringify({ "card-a": ahead })}\n`);

	const both = await restarted(first, { clock });

	await expect(both.agents.prompt("card-a", "now")).rejects.toThrow("grace period, 60 s from now");
	clock.advance(60_000);
	expect(await both.agents.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
	expect((await both.entry()).handingOver).toBeUndefined();
});

test("a mark further ahead than a timer can count does not spin the grace timer: one look at the end of the period", async () => {
	const clock = fakeClock();
	const first = await died("before", { clock });
	const ahead = { ...(await first.entry()), handingOverAt: clock.now() + 30 * 24 * 3_600_000 };
	await writeFile(first.acp.sessionsFile, `${JSON.stringify({ "card-a": ahead })}\n`);

	const both = await restarted(first, { clock, graceMs: 200 });
	const started = Date.now();

	expect((await both.entry()).handingOver).toBe(true);
	await sleep(300);
	// One look at startup, then one per timer of the whole period, however slow the machine: a timer that overflowed fires
	// every millisecond.
	expect(looked(both).length).toBeLessThanOrEqual(2 + (Date.now() - started) / 200);
	clock.advance(200);
	await until(async () => (await both.entry()).handingOver === undefined, "the look at the end of the grace period");
});

test("a grace period that ends while its handover is being recorded does not spin the timer for another undecided job", async () => {
	const session = (name: string) => ({
		name,
		card: name,
		sessionId: `s-${name}`,
		claudeSession: `c-${name}`,
		cwd: "/w",
	});
	let looksAtB = 0;
	const given: string[] = [];
	const from = {
		released: async () => [],
		// card-b was left mid-handover long ago, and rex does not answer about it: looked at again every `relookMs`.
		handingOver: async () => [{ ...session("card-b"), hangar: HANGAR, at: 0 }],
		givenBack: async () => [],
		dormant: async () => [],
		releasable: async () => session("card-a"),
		// A turn cut, so `show_job` records how the handover ended.
		cut: async () => ({}),
		release: async () => session("card-a"),
		markedAt: async () => {},
		reinstate: async (name: string) => {
			given.push(name);
		},
		list: async () => [],
		onStatus: () => () => {},
	} as unknown as HandoverAgentPortOptions["from"];
	const to = {
		hangar: HANGAR,
		takeable: async () => undefined,
		// A take that may still open a window: card-a is undecided, its grace period of 50 ms counting.
		take: async () => {
			throw new RexTransportError("no response within 10000 ms");
		},
		holds: async ({ name }: { name: string }) => {
			if (name === "card-a") return "none";
			looksAtB++;
			throw new Error("rex is away");
		},
		list: async () => [],
		onStatus: () => () => {},
	} as unknown as HandoverAgentPortOptions["to"];
	const agents = createHandoverAgentPort({ from, to, graceMs: 50, relookMs: 60_000, onError: () => {} });
	await agents.list();
	const before = looksAtB;

	let recorded = false;
	await agents.handOver("card-a", async () => {
		await sleep(300);
		recorded = true;
	});
	expect(recorded).toBe(true);

	// card-a's grace period ended 250 ms into the record, which a look does not settle: no look is due until it commits.
	expect(looksAtB - before).toBe(0);
	await until(() => given.includes("card-a"), "card-a to be looked at once its record committed");
});

/** Everything the core could ask of an undecided card-a is held off, and nothing starts for it over ACP. */
async function heldOff(both: Sides, pids: readonly number[]) {
	expect(await both.agents.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
	await expect(both.agents.prompt("card-a", "now")).rejects.toThrow(PromptRefused);
	await expect(both.agents.readScreen("card-a")).rejects.toThrow("being handed over");
	await expect(both.agents.stop("card-a")).rejects.toThrow("being handed over");
	await expect(both.agents.resume({ name: "card-a", card: "card-a", sessionId: SESSION })).rejects.toThrow(
		"being handed over",
	);
	await expect(
		both.agents.start({ name: "card-a", card: "card-a", cwd: both.acp.cwd, sessionId: SESSION }),
	).rejects.toThrow("handed over");
	expect(await both.agents.respond("card-a", { option: "1", fingerprint: "f" })).toEqual({
		sent: false,
		refusal: "not_blocked",
		reason: expect.stringContaining("being handed over"),
	});
	expect(await both.agents.handOver("card-a")).toMatchObject({
		handedOver: false,
		refusal: "cannot_resume",
		reason: expect.stringContaining("being handed over"),
	});
	expect(await both.pids()).toEqual(pids);
	expect((await both.entry()).handingOver).toBe(true);
	expect((await both.entry()).handedOver).toBeUndefined();
}

test.each([
	["its window open", true],
	["no window", false],
])(
	"in a running soma, rex gone as it resolves, with %s: undecided, then the right side once rex answers",
	async (_name, opens) => {
		const both = await sides();
		await both.ran();
		const pids = await both.pids();
		aroundWindow(both, async (open) => {
			if (opens) await open();
			both.rexDown();
			throw new RexTransportError("rex connection closed");
		});

		const outcome = await both.agents.handOver("card-a");

		expect(outcome).toMatchObject({
			handedOver: false,
			refusal: "cannot_resume",
			reason: expect.stringContaining("whether its window opened is not known"),
		});
		await heldOff(both, pids);
		await heldOff(both, pids);

		both.rexUp();

		if (opens) {
			expect(await both.agents.list()).toMatchObject([{ name: "card-a", status: { state: "idle" } }]);
			expect((await both.entry()).handedOver).toBe(true);
			await both.agents.prompt("card-a", "are you there");
			expect(both.typed()).toEqual(["are you there"]);
			expect(await both.pids()).toEqual(pids);
		} else {
			expect(await both.agents.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
			expect((await both.entry()).handingOver).toBeUndefined();
			const from = both.acp.events.length;
			await both.agents.prompt("card-a", "RECALL");
			await both.acp.until("done", from);
			expect((await both.agents.readResult("card-a"))?.text).toBe("recall: the word is KIWI");
			expect(both.blocks).toEqual([]);
		}
	},
);

test.each([
	["after", goesOnInWindow],
	["before", null],
] as const)(
	"at startup with rex down, a soma killed %s the window opened: undecided, told once, then the right side",
	async (when, inWindow) => {
		const first = await died(when);

		const both = await restarted(first, { rexDown: true });

		expect(await both.agents.dormant()).toEqual([]);
		await heldOff(both, []);
		await heldOff(both, []);
		expect(both.said).toEqual([expect.stringContaining("card-a is undecided: rex does not answer")]);

		both.rexUp();
		await both.agents.list();

		if (inWindow !== null) await inWindow(both);
		else await goesOnOverAcp(both, first);
	},
);

test.each([
	["its window open", "after", true],
	["no window", "before", false],
] as const)(
	"rex back with %s: the very next prompt goes on the side the look finds, with no listing",
	async (_name, when, inWindow) => {
		const first = await died(when);
		const both = await restarted(first, { rexDown: true });
		await expect(both.agents.prompt("card-a", "too soon")).rejects.toThrow("rex does not answer");
		both.rexUp();
		const from = both.acp.events.length;

		await both.agents.prompt("card-a", "RECALL");

		if (inWindow) {
			expect(both.typed()).toEqual(["RECALL"]);
			expect((await both.entry()).handedOver).toBe(true);
		} else {
			await both.acp.until("done", from);
			expect((await both.agents.readResult("card-a"))?.text).toBe("recall: the word is KIWI");
			expect(both.typed()).toEqual([]);
		}
	},
);

test.each([
	["its window open", "after", true],
	["no window", "before", false],
] as const)(
	"rex back with %s: the very next answer goes to the side the look finds, with no listing",
	async (_name, when, inWindow) => {
		const first = await died(when);
		const both = await restarted(first, { rexDown: true });
		const answer = { option: "1", fingerprint: "f" };
		expect(await both.agents.respond("card-a", answer)).toEqual({
			sent: false,
			refusal: "not_blocked",
			reason: expect.stringContaining("rex does not answer"),
		});
		both.rexUp();

		expect(await both.agents.respond("card-a", answer)).toEqual({ sent: false, refusal: "not_blocked" });

		expect((await both.entry()).handingOver).toBeUndefined();
		expect(both.hangar.methods().includes("com.superlogical.terminal.program_status")).toBe(inWindow);
	},
);

test("rex back with its window open: the very next handover says it is on rex, opening nothing", async () => {
	const first = await died("after");
	const both = await restarted(first, { rexDown: true });
	expect(await both.agents.handOver("card-a")).toMatchObject({
		refusal: "cannot_resume",
		reason: expect.stringContaining("rex does not answer"),
	});
	both.rexUp();

	expect(await both.agents.handOver("card-a")).toMatchObject({ refusal: "not_acp" });

	expect(both.windowsOpened()).toEqual([]);
});

test("rex back with no window: the very next handover goes through from ACP", async () => {
	const first = await died("before");
	const both = await restarted(first, { rexDown: true });
	both.rexUp();

	expect(await both.agents.handOver("card-a")).toMatchObject({ handedOver: true });

	expect(both.windowsOpened()).toHaveLength(1);
	expect((await both.entry()).handedOver).toBe(true);
});

test("a refusal names the reason the look just found, not the one before it", async () => {
	const first = await died("after");
	const both = await restarted(first, { rexDown: true });
	await expect(both.agents.prompt("card-a", "now")).rejects.toThrow("rex does not answer");
	(first.blocks[0] as Block).detached = true;
	both.rexUp();

	const refusal = await both.agents.prompt("card-a", "now").catch((error: Error) => error);

	expect(refusal).toBeInstanceOf(PromptRefused);
	expect((refusal as Error).message).toContain("in no window");
	expect((refusal as Error).message).not.toContain("does not answer");
});

test("two prompts at once look once, and neither looks again for the other", async () => {
	const first = await died("after");
	const both = await restarted(first, { rexDown: true });
	both.rexUp();
	const looks = () => both.hangar.methods().filter((method) => method === "session.list_blocks").length;

	await Promise.allSettled([both.agents.prompt("card-a", "one"), both.agents.prompt("card-a", "two")]);

	expect(looks()).toBe(1);
});

test("a prompt to another job looks at nothing, and goes on though rex is away", async () => {
	const first = await died("before", { alongside: "card-b" });
	const both = await restarted(first, { rexDown: true });
	let asked = 0;
	both.hangar.client.attach = () => {
		asked++;
		return Promise.reject(new Error("rex is away"));
	};
	const from = both.acp.events.length;

	await both.agents.prompt("card-b", "RECALL");

	await both.acp.until("done", from, "card-b");
	expect(asked).toBe(0);
	expect((await both.entry()).handingOver).toBe(true);
});

test("a hangar rex says does not exist holds no window: the job goes back to ACP, though any other error of rex leaves it undecided", async () => {
	const first = await died("before");
	const both = await restarted(first, { rexDown: true });
	expect((await both.entry()).handingOver).toBe(true);
	both.hangar.client.attach = () =>
		Promise.reject(new RexRpcError("session.attach", "session_not_found", "session not found", 404));

	expect(await both.agents.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);

	expect((await both.entry()).handingOver).toBeUndefined();
	both.rexUp();
	await goesOnOverAcp(both, first);
});

/** card-a's mark as a soma with `hangar` configured wrote it, or as one from before marks recorded a hangar. */
async function markedIn(first: Sides, hangar?: string) {
	const { hangar: _written, ...entry } = await first.entry();
	const mark = hangar === undefined ? entry : { ...entry, hangar };
	await writeFile(first.acp.sessionsFile, `${JSON.stringify({ "card-a": mark })}\n`);
}

/** Which sessions the looks of this soma asked for their blocks. */
const looked = (both: Sides) =>
	both.hangar.calls.filter(({ method }) => method === "session.list_blocks").map(({ payload }) => payload.session_id);

test("a window in the hangar the mark records, the config naming another: undecided, naming both, until it closes", async () => {
	const first = await died("after");
	const inOld = first.blocks.splice(0);
	await markedIn(first, "session:old");

	const both = await restarted(first, { others: [{ id: "session:old", label: "old", blocks: inOld }] });

	const left = await both.entry();
	expect(left.handingOver).toBe(true);
	expect(left.handedOver).toBeUndefined();
	expect(left.hangar).toBe("session:old");
	expect(await both.agents.dormant()).toEqual([]);
	await heldOff(both, []);
	await expect(both.agents.prompt("card-a", "now")).rejects.toThrow(/session:old.*session:hangar/);
	expect(both.said).toEqual([expect.stringMatching(/card-a is undecided: .*session:old.*session:hangar/)]);
	expect(both.typed()).toEqual([]);
	expect(new Set(looked(both))).toEqual(new Set(["session:old"]));
	// Read, not joined: an attach would be made again on every later connection.
	expect(both.hangar.attached).not.toContain("session:old");
	const methods = both.hangar.methods();
	expect(methods.indexOf("session.attach_all")).toBeLessThan(methods.indexOf("session.list_blocks"));

	inOld.length = 0;
	expect(await both.agents.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
	expect((await both.entry()).handingOver).toBeUndefined();
	expect((await both.entry()).hangar).toBeUndefined();
	await goesOnOverAcp(both, first);
});

test("a labelled block in no window in the hangar the mark records: undecided, for that reason", async () => {
	const first = await died("after");
	const inOld = first.blocks.splice(0);
	(inOld[0] as Block).detached = true;
	await markedIn(first, "session:old");

	const both = await restarted(first, { others: [{ id: "session:old", label: "old", blocks: inOld }] });

	expect((await both.entry()).handingOver).toBe(true);
	expect(both.said).toEqual([expect.stringContaining("is in rex session session:old, but in no window")]);
});

test("no block in the hangar the mark records is no window, though the configured hangar holds a block of its label", async () => {
	const first = await died("after");
	await markedIn(first, "session:old");

	const both = await restarted(first, { others: [{ id: "session:old", label: "old", blocks: [] }] });

	expect(await both.agents.dormant()).toEqual(["card-a"]);
	expect((await both.entry()).handingOver).toBeUndefined();
	expect((await both.entry()).handedOver).toBeUndefined();
	expect(looked(both)).toEqual(["session:old"]);
});

test.each([
	["session_not_found", "no window: the job goes back to ACP", true],
	["conflict", "nothing either way: the job stays undecided", false],
])("rex answering %s for the hangar the mark records says %s", async (code, _name, back) => {
	const first = await died("after");
	await markedIn(first, "session:old");
	const both = await restarted(first, { rexDown: true });
	both.hangar.replace("session.list_blocks", (payload) => {
		if (payload.session_id === "session:old") throw new RexRpcError("session.list_blocks", code, "no", 404);
		return both.hangar.original("session.list_blocks")(payload);
	});
	both.rexUp();

	await both.agents.list();

	expect((await both.entry()).handingOver).toBe(back ? undefined : true);
	expect((await both.entry()).handedOver).toBeUndefined();
	expect(looked(both)).toEqual(["session:old"]);
});

test("a mark with no recorded hangar looks in the configured one", async () => {
	const first = await died("after");
	await markedIn(first);

	const both = await restarted(first);

	expect((await both.entry()).handedOver).toBe(true);
	expect(looked(both)).toEqual([HANGAR]);
});

test("two listings at once look once, so a job going back to ACP is not put back twice", async () => {
	const first = await died("before");
	const both = await restarted(first, { rexDown: true });
	await both.agents.dormant();
	both.rexUp();
	const before = both.hangar.calls.length;

	const [one, two] = await Promise.all([both.agents.list(), both.agents.list()]);

	expect(one).toEqual([{ name: "card-a", sessionId: SESSION }]);
	expect(two).toEqual(one);
	expect(both.hangar.calls.slice(before).filter(({ method }) => method === "session.list_blocks")).toHaveLength(1);
});

test("a final mark that does not reach the file: handed over all the same, the mark in progress stays, and the next soma looks", async () => {
	const both = await sides();
	await both.ran();
	aroundWindow(both, async (open) => {
		await mkdir(`${both.acp.sessionsFile}.tmp`);
		return open();
	});

	expect(await both.agents.handOver("card-a")).toMatchObject({ handedOver: true, ready: true });

	const left = await both.entry();
	expect(left.handingOver).toBe(true);
	expect(left.handedOver).toBeUndefined();
	expect(both.acp.errors.map((error) => error.message)).toEqual([expect.stringContaining("acp sessions file")]);
	await both.agents.prompt("card-a", "here");
	expect(both.typed()).toEqual(["here"]);

	await rmdir(`${both.acp.sessionsFile}.tmp`);
	await both.acp.end();
	const after = await restarted(both);

	expect((await after.entry()).handedOver).toBe(true);
	await goesOnInWindow(after);
});

test("a removal of the mark that does not reach the file: back on ACP, the mark stays, and the next soma puts it back", async () => {
	const both = await sides();
	await both.ran();
	aroundWindow(both, async () => {
		await mkdir(`${both.acp.sessionsFile}.tmp`);
		throw new RexRpcError("session.new_window", "refused", "rex refused the window", 400);
	});

	expect(await both.agents.handOver("card-a")).toMatchObject({ handedOver: false, refusal: "cannot_resume" });

	expect((await both.entry()).handingOver).toBe(true);
	expect(both.acp.errors.map((error) => error.message)).toEqual([expect.stringContaining("acp sessions file")]);
	let from = both.acp.events.length;
	await both.agents.prompt("card-a", "RECALL");
	await both.acp.until("done", from);

	await rmdir(`${both.acp.sessionsFile}.tmp`);
	await both.acp.end();
	const after = await restarted(both);

	expect(await after.agents.dormant()).toEqual(["card-a"]);
	expect((await after.entry()).handingOver).toBeUndefined();
	expect(after.blocks).toEqual([]);
	from = after.acp.events.length;
	await after.agents.prompt("card-a", "RECALL");
	await after.acp.until("done", from);
	expect(after.typed()).toEqual([]);
});

test("a window found at startup whose final mark does not reach the file is on rex here, and looked at again by the next soma", async () => {
	const first = await died("after");
	await mkdir(`${first.acp.sessionsFile}.tmp`);

	const both = await restarted(first);

	await goesOnInWindow(both);
	expect((await both.entry()).handingOver).toBe(true);
	await rmdir(`${first.acp.sessionsFile}.tmp`);

	const after = await restarted(first);
	expect((await after.entry()).handedOver).toBe(true);
	expect((await after.agents.list()).map(({ name }) => name)).toEqual(["card-a"]);
});

/** The file a soma of milestone 1 leaves for card-a: marked `handedOver`, with no in-progress mark. */
async function milestoneOne(window: boolean) {
	const first = await sides();
	await first.ran();
	const entry = await first.entry();
	await first.acp.end();
	const text = `${JSON.stringify({ "card-a": { ...entry, handedOver: true } }, null, "\t")}\n`;
	await writeFile(first.acp.sessionsFile, text);
	if (window) {
		first.blocks.push({
			name: "card-a",
			block: "block:old",
			label: entry.acpSessionId,
			argv0: "claude",
			cwd: entry.cwd,
			records: [{ state: "idle", updated_at: "2026-10-27T01:02:03Z" }],
		});
	}
	return { first, text };
}

test("a file of milestone 1 routes the job to its window as before, with no look and no change to the file", async () => {
	const { first, text } = await milestoneOne(true);

	const both = await restarted(first);

	expect(await both.agents.dormant()).toEqual([]);
	await goesOnInWindow(both);
	expect(both.hangar.methods()).not.toContain("session.list_blocks");
	expect(await readFile(both.acp.sessionsFile, "utf8")).toBe(text);
});

test("a file of milestone 1 with no window never goes back to ACP: the job is not listed, and nothing starts", async () => {
	const { first, text } = await milestoneOne(false);

	const both = await restarted(first);

	expect(await both.agents.list()).toEqual([]);
	expect(await both.agents.dormant()).toEqual([]);
	await expect(both.agents.handOver("card-a")).resolves.toMatchObject({ refusal: "not_acp" });
	expect(await both.pids()).toEqual([]);
	expect(both.hangar.methods()).not.toContain("session.list_blocks");
	expect(await readFile(both.acp.sessionsFile, "utf8")).toBe(text);
});

test("a file of milestone 1 with rex down fails the listing, as it did: doubt, never gone", async () => {
	const { first } = await milestoneOne(true);

	const both = await restarted(first, { rexDown: true });

	await expect(both.agents.list()).rejects.toThrow("rex is away");
	expect(await both.pids()).toEqual([]);
});

test("a job never handed over reaches rex in no way, at startup or after, whatever window bears its label", async () => {
	const first = await sides();
	await first.ran();
	const entry = await first.entry();
	await first.acp.end();
	first.blocks.push({ name: "card-a", block: "block:namesake", label: entry.acpSessionId, argv0: "claude" });

	const both = await restarted(first);

	expect(await both.agents.dormant()).toEqual(["card-a"]);
	expect(await both.agents.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
	const from = both.acp.events.length;
	await both.agents.prompt("card-a", "RECALL");
	await both.acp.until("done", from);
	expect(both.hangar.calls).toEqual([]);
	expect((await both.entry()).handedOver).toBeUndefined();
});

test("a job never handed over goes on over ACP at startup with rex down", async () => {
	const first = await sides();
	await first.ran();
	await first.acp.end();

	const both = await restarted(first, { rexDown: true });

	expect(await both.agents.dormant()).toEqual(["card-a"]);
	expect(both.said).toEqual([]);
	const from = both.acp.events.length;
	await both.agents.prompt("card-a", "RECALL");
	await both.acp.until("done", from);
	expect((await both.agents.readResult("card-a"))?.text).toBe("recall: the word is KIWI");
});
