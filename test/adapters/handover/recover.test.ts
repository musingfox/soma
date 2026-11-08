import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createHandoverAgentPort } from "../../../src/adapters/handover/agent-port.ts";
import { RexRpcError, RexTransportError } from "../../../src/adapters/rex/client.ts";
import { PromptRefused } from "../../../src/ports/agent.ts";
import { cleanUp, SESSION } from "../acp/fake.ts";
import { type Block, fixture, HANGAR, type Session } from "../rex/fake.ts";
import { alive, sides, sleep } from "./fake.ts";

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
async function died(when: "before" | "after") {
	const first = await sides();
	await first.ran();
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
	});
	void dying.handOver("card-a");
	await until(() => !alive(pid as number), "the ACP process to end");
	if (when === "after") await until(() => first.blocks.length === 1, "the window to open");
	await first.acp.end();
	return first;
}

/** The soma after `first`, once its startup has looked at whatever was left in progress. */
async function restarted(first: Sides, more: { rexDown?: boolean; others?: Session[] } = {}) {
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

test.each([
	["throws", new Error("rex refused the window")],
	["has its reply lost", new RexTransportError("rex refused the window")],
])(
	"a new_window that %s with no window open: back on ACP, with today's refusal, and it goes on in its session",
	async (_name, failure) => {
		const both = await sides();
		await both.ran();
		aroundWindow(both, () => Promise.reject(failure));

		expect(await both.agents.handOver("card-a")).toEqual({
			handedOver: false,
			refusal: "cannot_resume",
			reason:
				"rex refused the window. Its ACP process has ended and the job stays on ACP: its next prompt starts it again in " +
				"its session",
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
	},
);

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
	});
	expect(await both.agents.handOver("card-a")).toMatchObject({ handedOver: false, refusal: "cannot_resume" });
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
		throw new Error("rex refused the window");
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
