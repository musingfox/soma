import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type AcpAgentPort, TURN_STOP_MS } from "../../../src/adapters/acp/agent-port.ts";
import { createHandoverAgentPort, noHandover } from "../../../src/adapters/handover/agent-port.ts";
import { seqOf } from "../../../src/adapters/rex/agent-port.ts";
import { RexRpcError } from "../../../src/adapters/rex/client.ts";
import { type AgentState, type AgentStatusEvent, PromptRefused } from "../../../src/ports/agent.ts";
import { cleanUp, SESSION } from "../acp/fake.ts";
import { AT, type Block, fixture, HANGAR } from "../rex/fake.ts";
import { AT_IDLE, alive, sides, sleep } from "./fake.ts";

afterEach(cleanUp);

type Sides = Awaited<ReturnType<typeof sides>>;

const WORKING = { state: "working", updated_at: "2026-10-27T01:02:04.000000+08:00" };

test("a handover closes the ACP session, ends its process and marks its entry, and opens one window that goes on with it", async () => {
	const both = await sides();
	await both.ran();
	const [pid] = await both.pids();
	const { acpSessionId } = await both.entry();
	const cwd = await realpath(join(both.acp.cwd, ".claude", "worktrees", "card-a"));

	expect(await both.agents.handOver("card-a")).toEqual({
		handedOver: true,
		window: "card-a",
		session: "hangar",
		sessionId: acpSessionId,
		ready: true,
	});

	expect(await both.closed()).toBe(`${acpSessionId}\n`);
	expect(alive(pid as number)).toBe(false);
	expect((await both.entry()).handedOver).toBe(true);
	expect(both.windowsOpened().map((call) => call.payload)).toEqual([
		{
			session_id: HANGAR,
			window_label: "card-a",
			focus: false,
			layout: {
				block: {
					flavor: "com.superlogical.terminal.shell",
					label: acpSessionId,
					options: {
						cwd,
						initial_input:
							`SOMA_SOCKET='/run/soma.sock' SOMA_AGENT='card-a' PATH='/opt/soma/bin':"$PATH" ` +
							`claude --resume ${acpSessionId} --model 'claude-fake-1'\n`,
					},
				},
			},
		},
	]);
});

test("a job handed over is listed from its window, under its name, and handled on rex", async () => {
	const both = await sides();
	await both.ran();
	const { acpSessionId } = await both.entry();
	await both.agents.handOver("card-a");
	const window = both.blocks[0] as Block;
	window.screen = "the pane shows this";

	const listed = await both.agents.list();
	expect(listed).toMatchObject([{ name: "card-a", sessionId: acpSessionId, status: { state: "idle" } }]);
	expect(await both.acp.port.list()).toEqual([]);

	expect(await both.agents.readScreen("card-a")).toBe("the pane shows this");
	expect((await both.agents.readResult("card-a"))?.text).toBe("echo: the word is KIWI");

	await both.agents.prompt("card-a", "say it again");
	expect(both.typed()).toEqual(["say it again"]);
	expect(await both.pids()).toHaveLength(1);

	window.records = [{ state: "blocked", kind: "permission", updated_at: AT }];
	expect(await both.agents.respond("card-a", { option: "1", fingerprint: "other" })).toEqual({
		sent: false,
		refusal: "unreadable",
	});

	await both.agents.stop("card-a");
	expect(both.hangar.methods()).toContain("block.close");
	expect(await both.agents.list()).toEqual([]);
	expect((await both.agents.handOver("card-a")).handedOver).toBe(false);
});

test("a job handed over and stopped goes on the rex way, in a new window of the same session and model", async () => {
	const both = await sides();
	await both.ran();
	const { acpSessionId } = await both.entry();
	await both.agents.handOver("card-a");
	await both.agents.stop("card-a");

	// Whatever id the job names, its own or the one it started under, it is the session the window ran.
	await both.agents.resume({ name: "card-a", card: "card-a", sessionId: SESSION });

	const [first, second, ...more] = both.windowsOpened();
	expect(more).toEqual([]);
	expect(second?.payload).toEqual(first?.payload);
	expect(await both.pids()).toHaveLength(1);
	expect(await both.agents.list()).toMatchObject([{ name: "card-a", sessionId: acpSessionId }]);
});

test("a restarted soma routes a job handed over to its window, and starts nothing for it over ACP", async () => {
	const first = await sides();
	await first.ran();
	const { acpSessionId } = await first.entry();
	await first.agents.handOver("card-a");
	await first.acp.end();

	const both = await sides({ restartOf: first.acp.cwd, blocks: first.blocks });

	expect(await both.acp.port.dormant()).toEqual([]);
	expect(await both.agents.list()).toMatchObject([
		{ name: "card-a", sessionId: acpSessionId, status: { state: "idle" } },
	]);
	await both.agents.prompt("card-a", "are you there");
	expect(both.typed()).toEqual(["are you there"]);
	expect(await both.pids()).toEqual([]);
	await expect(
		both.agents.start({ name: "card-a", card: "card-a", cwd: both.acp.cwd, sessionId: SESSION }),
	).rejects.toThrow("handed over");
	expect(await both.agents.handOver("card-a")).toEqual({
		handedOver: false,
		refusal: "not_acp",
		reason: "card-a is on rex already, in its window of the same name",
	});
});

test("a job blocked on a login, never prompted or with its window name taken is refused, with nothing done", async () => {
	const both = await sides({ blocks: [{ name: "taken", block: "block:taken" }] });
	await both.ran("login");
	const from = both.acp.events.length;
	await both.agents.prompt("login", "AUTH");
	await both.acp.until("blocked", from, "login");
	await both.acp.start("fresh");
	await both.acp.until("idle", 0, "fresh");
	await both.ran("taken");
	const running = await both.pids();

	for (const [name, refusal, reason] of [
		["login", "not_at_rest", /is blocked on a login/],
		["fresh", "cannot_resume", /never ran a prompt/],
		["taken", "cannot_resume", /already has a window named taken/],
		["nobody", "not_acp", /no agent acp holds/],
	] as const) {
		const outcome = await both.agents.handOver(name);
		expect(outcome).toMatchObject({ handedOver: false, refusal, reason: expect.stringMatching(reason) });
	}

	expect(await both.closed()).toBe("");
	expect(await both.cancelled()).toBe("");
	expect(both.windowsOpened()).toEqual([]);
	for (const pid of running) expect(alive(pid)).toBe(true);
	for (const name of ["login", "fresh", "taken"]) expect((await both.entry(name)).handedOver).toBeUndefined();
	await both.acp.port.prompt("taken", "still here");
});

async function until(ok: () => boolean) {
	for (const deadline = Date.now() + 5_000; !ok(); await sleep(5)) expect(Date.now()).toBeLessThan(deadline);
}

/** Runs one turn on card-a, then starts `prompt`, a turn that is still in `state` as this returns. */
async function inTurn(both: Sides, prompt: string, state: "working" | "blocked" = "working") {
	await both.ran();
	const from = both.acp.events.length;
	await both.agents.prompt("card-a", prompt);
	await both.acp.until(state, from);
	return from;
}

/**
 * A job at rest whose hangar rex loses at `when`: as the handover cuts its turn, after the mark, or as the take opens its
 * window. `marks` holds the hangar each mark named.
 */
async function lostMidHandover(when: "cut" | "window") {
	const marks: string[] = [];
	let lose = () => {};
	const both = await sides({
		from: (port) => ({
			...port,
			cut: async (agent) => {
				const cut = await port.cut(agent);
				if (when === "cut") lose();
				return cut;
			},
			release: async (agent, mark) => {
				marks.push(mark.hangar);
				return port.release(agent, mark);
			},
		}),
	});
	lose = () => both.hangar.lose();
	const { call } = both.hangar.client;
	both.hangar.client.call = async (method, payload, schema) => {
		if (when === "window" && method === "session.new_window") lose();
		return call(method, payload, schema);
	};
	await both.ran();
	return { both, marks };
}

test.each(["cut", "window"] as const)(
	"a hangar lost at the %s of a handover opens no window outside the hangar its mark names, and the job stays on ACP",
	async (when) => {
		const { both, marks } = await lostMidHandover(when);

		const outcome = await both.agents.handOver("card-a");

		expect(outcome).toMatchObject({ handedOver: false, refusal: "cannot_resume" });
		expect(marks).toEqual([HANGAR]);
		const opened = both.windowsOpened().map((call) => call.payload.session_id);
		expect(opened.filter((session) => session !== HANGAR)).toEqual([]);
		expect((await both.entry()).handingOver).toBeUndefined();
		expect((await both.agents.list()).map(({ name }) => name)).toEqual(["card-a"]);

		// Asked again, the mark names the hangar made in place of the lost one, where the window opens.
		await both.agents.handOver("card-a");
		expect(marks).toEqual([HANGAR, "session:made-1"]);
		expect(
			both
				.windowsOpened()
				.map((call) => call.payload.session_id)
				.slice(opened.length),
		).toEqual(["session:made-1"]);
	},
);

test("a working job has its turn cancelled, and it has stopped before the mark goes on, the session closes and a window opens", async () => {
	const seen: { idle: boolean; cancelled: string; closed: string; mark?: true }[] = [];
	const release = (port: AcpAgentPort): AcpAgentPort => ({
		...port,
		release: async (agent, mark) => {
			seen.push({
				idle: (await port.list()).some(({ status }) => status?.state === "idle"),
				cancelled: await readFile(join(both.acp.cwd, "..", "projects", "cancelled"), "utf8"),
				closed: await readFile(join(both.acp.cwd, "..", "projects", "closed"), "utf8").catch(() => ""),
				...(await both.entry().then(({ handingOver }) => (handingOver ? { mark: handingOver } : {}))),
			});
			return port.release(agent, mark);
		},
	});
	const both = await sides({ from: release });
	await inTurn(both, "SPIN");
	const [pid] = await both.pids();
	const { acpSessionId } = await both.entry();

	const outcome = await both.agents.handOver("card-a");

	expect(outcome).toEqual({
		handedOver: true,
		window: "card-a",
		session: "hangar",
		sessionId: acpSessionId,
		ready: true,
		cut: {},
	});
	expect(seen).toEqual([{ idle: true, cancelled: `${acpSessionId}\n`, closed: "" }]);
	expect(await both.closed()).toBe(`${acpSessionId}\n`);
	expect(alive(pid as number)).toBe(false);
	expect((await both.entry()).handedOver).toBe(true);
	expect(both.windowsOpened()).toHaveLength(1);
});

/** card-a has started and runs its first prompt, `prompt`, which is still in a turn as this returns. */
async function firstTurn(both: Sides, prompt: string) {
	await both.acp.start();
	await both.acp.until("idle");
	await both.agents.prompt("card-a", prompt);
	await both.acp.until("working");
	const { acpSessionId, cwd } = await both.entry();
	const transcript = join(both.acp.cwd, "..", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${acpSessionId}.jsonl`);
	while (
		!(await readFile(transcript, "utf8").catch(() => "")).includes(prompt.includes("UNWRITTEN") ? "owner" : prompt)
	) {
		await sleep(10);
	}
}

const openedWith = (both: Sides) =>
	both.windowsOpened().map((call) => JSON.stringify(call.payload).match(/claude --resume \S+ --model '([^']+)'/)?.[1]);

test("a job in its first turn, with no reply yet naming a model: cut, and it goes on in a window on the model its session reported", async () => {
	const both = await sides({ fake: { FAKE_ACP_MODEL: "fake-alias" } });
	await firstTurn(both, "QUIET");
	const { acpSessionId, model } = await both.entry();
	expect(model).toBe("fake-alias");

	expect(await both.agents.handOver("card-a")).toEqual({
		handedOver: true,
		window: "card-a",
		session: "hangar",
		sessionId: acpSessionId,
		ready: true,
		cut: {},
	});

	expect(await both.cancelled()).toBe(`${acpSessionId}\n`);
	expect(openedWith(both)).toEqual(["fake-alias"]);
});

test("a reply that names a model wins over what the session reported when it was created", async () => {
	const both = await sides({ fake: { FAKE_ACP_MODEL: "fake-alias" } });
	await both.ran();

	expect(await both.agents.handOver("card-a")).toMatchObject({ handedOver: true });

	expect((await both.entry()).model).toBe("fake-alias");
	expect(openedWith(both)).toEqual(["claude-fake-1"]);
});

test("a job handed over in its first turn and stopped goes on after a restart on the model its entry holds", async () => {
	const first = await sides({ fake: { FAKE_ACP_MODEL: "fake-alias" } });
	await firstTurn(first, "QUIET");
	await first.agents.handOver("card-a");
	await first.agents.stop("card-a");
	await first.acp.end();

	const both = await sides({ restartOf: first.acp.cwd, blocks: first.blocks });
	await both.agents.resume({ name: "card-a", card: "card-a", sessionId: SESSION });

	expect(openedWith(both)).toEqual(["fake-alias"]);
});

test.each([
	["no transcript yet", "", "never ran a prompt"],
	["a transcript holding no conversation yet", "UNWRITTEN", "no conversation yet"],
])(
	"a job whose session reported a model, with %s, is refused before anything is cancelled",
	async (_case, prompt, why) => {
		const both = await sides({ fake: { FAKE_ACP_MODEL: "fake-alias" } });
		if (prompt === "") {
			await both.acp.start();
			await both.acp.until("idle");
		} else await firstTurn(both, prompt);
		const [pid] = await both.pids();

		expect(await both.agents.handOver("card-a")).toMatchObject({
			handedOver: false,
			refusal: "cannot_resume",
			reason: expect.stringContaining(why),
		});

		expect(await both.cancelled()).toBe("");
		expect(await both.closed()).toBe("");
		expect(both.windowsOpened()).toEqual([]);
		expect(alive(pid as number)).toBe(true);
		expect((await both.entry()).handingOver).toBeUndefined();
		expect(await both.agents.list()).toMatchObject([{ status: { state: prompt === "" ? "idle" : "working" } }]);
	},
);

test("a job in its first turn whose session reported no model either is refused before anything is cancelled", async () => {
	const both = await sides();
	await firstTurn(both, "QUIET");

	expect(await both.agents.handOver("card-a")).toMatchObject({
		handedOver: false,
		refusal: "cannot_resume",
		reason: expect.stringContaining("names its model"),
	});

	expect(await both.cancelled()).toBe("");
	expect(await both.closed()).toBe("");
	expect(both.windowsOpened()).toEqual([]);
});

test("a job at rest is cancelled nothing, and says nothing was cut", async () => {
	const both = await sides();
	await both.ran();

	const outcome = await both.agents.handOver("card-a");

	expect(outcome).toMatchObject({ handedOver: true });
	expect(outcome).not.toHaveProperty("cut");
	expect(await both.cancelled()).toBe("");
});

test("a turn that does not stop within the wait: refused with the reason, nothing closed, nothing opened, and the job works on, on ACP", async () => {
	const both = await sides({ cutMs: 50 });
	await inTurn(both, "HANG");
	const [pid] = await both.pids();
	const before = both.acp.events.length;

	const outcome = await both.agents.handOver("card-a");

	expect(outcome).toEqual({
		handedOver: false,
		refusal: "not_at_rest",
		reason: expect.stringContaining("did not stop within 0.05 s"),
	});
	expect(await both.closed()).toBe("");
	expect(both.windowsOpened()).toEqual([]);
	expect(alive(pid as number)).toBe(true);
	const entry = await both.entry();
	expect(entry.handingOver).toBeUndefined();
	expect(entry.handedOver).toBeUndefined();
	expect(await both.agents.list()).toMatchObject([{ name: "card-a", status: { state: "working" } }]);
	expect(both.acp.events.slice(before)).toEqual([]);
	await expect(both.agents.prompt("card-a", "now")).rejects.toThrow(PromptRefused);
});

test("the wait for a turn to stop is a named bound, past what claude-agent-acp allows a wedged interrupt", () => {
	expect(TURN_STOP_MS).toBe(35_000);
});

test("a prompt on a job blocked is cancelled, with the quote of it, and the handover goes on as for a working job", async () => {
	const both = await sides();
	const heard: AgentStatusEvent[] = [];
	const off = both.agents.onStatus((event) => heard.push(event));
	await inTurn(both, "ASK", "blocked");
	const from = heard.length;
	const blocked = heard.at(-1)?.status as Extract<AgentState, { state: "blocked" }>;
	const { acpSessionId } = await both.entry();

	const outcome = await both.agents.handOver("card-a");

	expect(outcome).toMatchObject({ handedOver: true, cut: { prompt: blocked.msg } });
	expect(blocked.msg).toContain("approve touch probe.txt");
	expect(await both.cancelled()).toBe(`${acpSessionId}\n`);
	expect((await both.agents.list())[0]?.status?.state).toBe("idle");
	expect(heard.slice(from).filter(({ status }) => status.state === "blocked")).toEqual([]);
	expect(
		await both.agents.respond("card-a", { option: "1", fingerprint: blocked.fingerprint as string }),
	).toMatchObject({
		sent: false,
		refusal: "not_blocked",
	});
	expect(both.typed()).toEqual([]);
	off();
});

test("every prompt waiting is answered cancelled", async () => {
	const both = await sides();
	await inTurn(both, "TWICE", "blocked");

	expect(await both.agents.handOver("card-a")).toMatchObject({ handedOver: true, cut: { prompt: expect.any(String) } });
});

test("a prompt the turn asks once it has been cancelled is answered cancelled too, and blocks nothing", async () => {
	const both = await sides({ cutMs: 2_000 });
	await inTurn(both, "LATEASK");
	const before = both.acp.events.length;

	expect(await both.agents.handOver("card-a")).toMatchObject({ handedOver: true, cut: {} });

	expect(both.acp.events.slice(before).filter(({ status }) => status.state === "blocked")).toEqual([]);
});

test("blocked with a turn that will not stop once its prompt is cancelled: refused, closed nothing, and working, not blocked", async () => {
	const both = await sides({ cutMs: 50 });
	const heard: AgentStatusEvent[] = [];
	const off = both.agents.onStatus((event) => heard.push(event));
	await inTurn(both, "ASKHANG", "blocked");
	const blocked = heard.at(-1)?.status as Extract<AgentState, { state: "blocked" }>;

	const outcome = await both.agents.handOver("card-a");

	expect(outcome).toMatchObject({
		handedOver: false,
		refusal: "not_at_rest",
		reason: expect.stringContaining("approve touch probe.txt"),
	});
	expect(await both.closed()).toBe("");
	expect(both.windowsOpened()).toEqual([]);
	expect(await both.agents.list()).toMatchObject([{ status: { state: "working" } }]);
	expect(heard.at(-1)?.status.state).toBe("working");
	expect(await both.agents.respond("card-a", { option: "1", fingerprint: blocked.fingerprint as string })).toEqual({
		sent: false,
		refusal: "not_blocked",
	});
	off();
});

test("a second handover of a turn still stopping sends no second cancel, and one after it stopped goes through", async () => {
	const both = await sides({ cutMs: 40, fake: { FAKE_ACP_HELD: "stop" } });
	const from = await inTurn(both, "SPIN");
	const { acpSessionId } = await both.entry();

	expect(await both.agents.handOver("card-a")).toMatchObject({ handedOver: false, refusal: "not_at_rest" });
	expect(await both.agents.handOver("card-a")).toMatchObject({ handedOver: false, refusal: "not_at_rest" });
	// session/cancel is a notification: the refusals do not wait for the agent to have taken it.
	for (const deadline = Date.now() + 5_000; (await both.cancelled()) === ""; await sleep(5)) {
		expect(Date.now()).toBeLessThan(deadline);
	}
	expect(await both.cancelled()).toBe(`${acpSessionId}\n`);
	await both.release("stop");
	await both.acp.until("idle", from);

	const outcome = await both.agents.handOver("card-a");

	expect(outcome).toMatchObject({ handedOver: true });
	expect(outcome).not.toHaveProperty("cut");
	expect(await both.cancelled()).toBe(`${acpSessionId}\n`);
});

test("a turn that ends by itself as the cancel goes out: refused, nothing cut or closed, and its end reaches whoever listens", async () => {
	const both = await sides();
	const heard: AgentStatusEvent[] = [];
	const off = both.agents.onStatus((event) => heard.push(event));
	await inTurn(both, "FINISH");
	const [pid] = await both.pids();

	const outcome = await both.agents.handOver("card-a");

	expect(outcome).toMatchObject({
		handedOver: false,
		refusal: "not_at_rest",
		reason: expect.stringContaining("nothing was cut"),
	});
	expect(outcome).not.toHaveProperty("cut");
	expect(heard.at(-1)?.status.state).toBe("done");
	expect(alive(pid as number)).toBe(true);
	expect(both.windowsOpened()).toEqual([]);
	off();
});

test("a record that fails leaves the move's answer as it was, logged: the job is on rex, and the next soma tells it", async () => {
	const both = await sides();
	await inTurn(both, "SPIN");

	const outcome = await both.agents.handOver("card-a", () => Promise.reject(new Error("the db is away")));

	expect(outcome).toMatchObject({ handedOver: true, cut: {} });
	expect(both.said).toContain("the db is away");
	expect((await both.entry()).handedOver).toBe(true);
});

test("what the window said while its status was being read is not overtaken by the older read", async () => {
	let answer = () => {};
	const answered = new Promise<void>((resolve) => {
		answer = resolve;
	});
	let asked = false;
	const both = await sides({
		to: (port) => ({
			...port,
			list: async () => {
				const listed = await port.list();
				asked = true;
				await answered;
				return listed;
			},
		}),
	});
	const heard: AgentStatusEvent[] = [];
	const off = both.agents.onStatus((event) => heard.push(event));
	await inTurn(both, "SPIN");
	const from = heard.length;

	const moving = both.agents.handOver("card-a");
	await until(() => asked);
	const window = both.blocks[0] as Block;
	window.records = [WORKING];
	both.hangar.emit(both.hangar.status(window.block, WORKING));
	await until(() => heard.length > from);
	answer();
	await moving;

	expect(heard.slice(from)).toEqual([{ agent: "card-a", status: { state: "working" }, seq: seqOf(WORKING) }]);
	off();
});

const PROMPTED = { state: "blocked", kind: "permission", updated_at: "2026-10-27T01:02:05.000000+08:00" };

test("a prompt the window reached during the move reaches the listener once, though the first listing after fails", async () => {
	let listings = 0;
	const both = await sides({
		opened: { records: [PROMPTED] },
		relistMs: 20,
		to: (port) => ({
			...port,
			list: async () => {
				if (++listings === 1) throw new Error("rex is away");
				return port.list();
			},
		}),
	});
	const heard: AgentStatusEvent[] = [];
	const off = both.agents.onStatus((event) => heard.push(event));
	await inTurn(both, "SPIN");
	const from = heard.length;

	expect(await both.agents.handOver("card-a")).toMatchObject({ handedOver: true });
	for (const deadline = Date.now() + 2_000; heard.length === from && Date.now() < deadline; ) await sleep(5);
	await sleep(60);

	expect(heard.slice(from)).toMatchObject([{ agent: "card-a", status: { state: "blocked" }, seq: seqOf(PROMPTED) }]);
	expect(heard.slice(from)).toHaveLength(1);
	expect(listings).toBe(2);
	off();
});

test("what the window says before a listing after a failed one answers is not overtaken by that older listing", async () => {
	let answer = () => {};
	const answered = new Promise<void>((resolve) => {
		answer = resolve;
	});
	let listings = 0;
	let asked = false;
	const both = await sides({
		opened: { records: [PROMPTED] },
		relistMs: 20,
		to: (port) => ({
			...port,
			list: async () => {
				if (++listings === 1) throw new Error("rex is away");
				const listed = await port.list();
				asked = true;
				await answered;
				return listed;
			},
		}),
	});
	const heard: AgentStatusEvent[] = [];
	const off = both.agents.onStatus((event) => heard.push(event));
	await inTurn(both, "SPIN");
	const from = heard.length;

	await both.agents.handOver("card-a");
	await until(() => asked);
	const window = both.blocks[0] as Block;
	window.records = [WORKING];
	both.hangar.emit(both.hangar.status(window.block, WORKING));
	await until(() => heard.length > from);
	answer();
	await sleep(60);

	expect(heard.slice(from)).toEqual([{ agent: "card-a", status: { state: "working" }, seq: seqOf(WORKING) }]);
	off();
});

test("a status of the window that goes out before a listing after a failed one is made ends the listings", async () => {
	let listings = 0;
	const both = await sides({
		opened: { records: [PROMPTED] },
		relistMs: 200,
		to: (port) => ({
			...port,
			list: async () => {
				if (++listings === 1) throw new Error("rex is away");
				return port.list();
			},
		}),
	});
	const heard: AgentStatusEvent[] = [];
	const off = both.agents.onStatus((event) => heard.push(event));
	await inTurn(both, "SPIN");
	const from = heard.length;

	await both.agents.handOver("card-a");
	const window = both.blocks[0] as Block;
	window.records = [WORKING];
	both.hangar.emit(both.hangar.status(window.block, WORKING));
	await until(() => heard.length > from);
	await sleep(300);

	expect(heard.slice(from)).toEqual([{ agent: "card-a", status: { state: "working" }, seq: seqOf(WORKING) }]);
	expect(listings).toBe(1);
	off();
});

test("a late status of the ACP side does not end the listings for the window it was handed over to", async () => {
	let listings = 0;
	const acpListeners = new Set<(event: AgentStatusEvent) => void>();
	const both = await sides({
		opened: { records: [PROMPTED] },
		relistMs: 20,
		from: (port) => ({
			...port,
			onStatus: (listener) => {
				acpListeners.add(listener);
				const offPort = port.onStatus(listener);
				return () => {
					acpListeners.delete(listener);
					offPort();
				};
			},
		}),
		to: (port) => ({
			...port,
			list: async () => {
				if (++listings === 1) throw new Error("rex is away");
				return port.list();
			},
		}),
	});
	const heard: AgentStatusEvent[] = [];
	const off = both.agents.onStatus((event) => heard.push(event));
	await inTurn(both, "SPIN");
	const from = heard.length;

	await both.agents.handOver("card-a");
	const exited = { agent: "card-a", status: { state: "error", msg: "the ACP process exited" }, seq: 1 } as const;
	for (const listener of acpListeners) listener(exited);
	for (const deadline = Date.now() + 2_000; heard.length < from + 2 && Date.now() < deadline; ) await sleep(5);

	expect(heard.slice(from)).toMatchObject([
		exited,
		{ agent: "card-a", status: { state: "blocked" }, seq: seqOf(PROMPTED) },
	]);
	off();
});

test("each listener hears a status once, what passes after a move as well", async () => {
	const both = await sides();
	const one: AgentStatusEvent[] = [];
	const two: AgentStatusEvent[] = [];
	const offOne = both.agents.onStatus((event) => one.push(event));
	const offTwo = both.agents.onStatus((event) => two.push(event));
	await inTurn(both, "SPIN");
	const from = one.length;
	expect(two).toEqual(one);

	await both.agents.handOver("card-a");

	expect(one.slice(from)).toMatchObject([{ agent: "card-a", status: { state: "idle" } }]);
	expect(two).toEqual(one);
	expect(new Set(one.map(({ seq }) => seq)).size).toBe(one.length);
	offOne();
	offTwo();
});

test("what a cut turn wrote reads as no reply, and the next turn's as one", async () => {
	const both = await sides({ cutMs: 20, fake: { FAKE_ACP_STOP_MS: "80" } });
	await inTurn(both, "SPIN");
	await both.agents.handOver("card-a");
	const from = both.acp.events.length;
	await both.acp.until("idle", from);

	const read = await both.agents.readResult("card-a");

	expect(read?.id).toEqual(expect.any(String));
	expect(read?.text).toBeUndefined();
	const next = both.acp.events.length;
	await both.agents.prompt("card-a", "again");
	await both.acp.until("done", next);
	expect((await both.agents.readResult("card-a"))?.text).toBe("echo: again");
});

test("a job waking is still refused, with nothing cancelled", async () => {
	const first = await sides();
	await first.ran();
	await first.acp.end();
	const both = await sides({ restartOf: first.acp.cwd, blocks: first.blocks, fake: { FAKE_ACP_HELD: "load" } });
	const prompting = both.agents.prompt("card-a", "RECALL");
	await sleep(50);

	expect(await both.agents.handOver("card-a")).toMatchObject({
		handedOver: false,
		refusal: "not_at_rest",
		reason: expect.stringContaining("waking"),
	});

	expect(await both.cancelled()).toBe("");
	expect(both.windowsOpened()).toEqual([]);
	await both.release("load");
	await prompting;
});

test("a job being resumed is still refused, with nothing cancelled", async () => {
	const both = await sides({ fake: { FAKE_ACP_HELD: "load" } });
	await both.ran();
	await both.agents.stop("card-a");
	const resuming = both.agents.resume({ name: "card-a", card: "card-a", sessionId: SESSION });
	await sleep(50);

	expect(await both.agents.handOver("card-a")).toMatchObject({
		handedOver: false,
		refusal: "not_at_rest",
		reason: expect.stringContaining("started again"),
	});

	expect(await both.cancelled()).toBe("");
	await both.release("load");
	await resuming;
});

test("a session not yet open is still refused, with nothing cancelled", async () => {
	const both = await sides({ fake: { FAKE_ACP_HELD: "new" } });
	await both.acp.start();

	expect(await both.agents.handOver("card-a")).toMatchObject({
		handedOver: false,
		refusal: "not_at_rest",
		reason: expect.stringContaining("no session yet"),
	});

	expect(await both.cancelled()).toBe("");
	expect(both.windowsOpened()).toEqual([]);
});

test("while a turn is being cut it takes no prompt or answer, and is listed with no status", async () => {
	const both = await sides({ fake: { FAKE_ACP_HELD: "stop" } });
	await inTurn(both, "SPIN");

	const moving = both.agents.handOver("card-a");
	while ((await both.cancelled()) === "") await sleep(5);

	expect(await both.agents.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
	await expect(both.agents.prompt("card-a", "now")).rejects.toThrow("being handed over");
	expect(await both.agents.respond("card-a", { option: "1", fingerprint: "f" })).toEqual({
		sent: false,
		refusal: "not_blocked",
		reason: "card-a is being handed over",
	});
	await both.release("stop");
	expect(await moving).toMatchObject({ handedOver: true });
});

test("no status of a turn being cut, and none of a window until the caller has recorded the move, reaches the listener", async () => {
	const both = await sides();
	const heard: AgentStatusEvent[] = [];
	const off = both.agents.onStatus((event) => heard.push(event));
	await inTurn(both, "SPIN");
	const from = heard.length;
	let during: AgentStatusEvent[] = [];
	const window = () => both.blocks[0] as Block;

	const moved = await both.agents.handOver("card-a", async () => {
		during = heard.slice(from);
		window().records = [WORKING];
		both.hangar.emit(both.hangar.status(window().block, WORKING));
		await sleep(30);
		during = heard.slice(from);
	});

	expect(moved).toMatchObject({ handedOver: true });
	expect(during).toEqual([]);
	expect(heard.slice(from)).toEqual([{ agent: "card-a", status: { state: "working" }, seq: seqOf(WORKING) }]);
	off();
});

test("a rex that does not answer refuses the handover, with the job left running over ACP", async () => {
	const both = await sides();
	await both.ran();
	const [pid] = await both.pids();
	both.hangar.replace("session.view", () => {
		throw new Error("rex is away");
	});

	expect(await both.agents.handOver("card-a")).toEqual({
		handedOver: false,
		refusal: "cannot_resume",
		reason: "rex is away",
	});

	expect(alive(pid as number)).toBe(true);
	expect(await both.closed()).toBe("");
});

test("a window that will not open leaves the job on ACP, dormant, and its next prompt goes on in its session", async () => {
	const both = await sides();
	await both.ran();
	const original = both.hangar.client.call.bind(both.hangar.client);
	both.hangar.client.call = async (method, payload, schema) => {
		if (method === "session.new_window") throw new RexRpcError(method, "refused", "rex refused the window", 400);
		return original(method, payload, schema);
	};

	const outcome = await both.agents.handOver("card-a");

	expect(outcome).toMatchObject({ handedOver: false, refusal: "cannot_resume" });
	expect(outcome).toMatchObject({ reason: expect.stringContaining("rex refused the window") });
	expect(outcome).toMatchObject({ reason: expect.stringContaining("stays on ACP") });
	expect((await both.entry()).handedOver).toBeUndefined();
	expect(await both.agents.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
	const from = both.acp.events.length;
	await both.agents.prompt("card-a", "RECALL");
	await both.acp.until("done", from);
	expect((await both.agents.readResult("card-a"))?.text).toBe("recall: the word is KIWI");
});

test("a release that fails leaves the job on ACP, listed and taking prompts, with no window", async () => {
	const both = await sides();
	await both.ran();
	const agents = createHandoverAgentPort({
		from: { ...both.acp.port, release: () => Promise.reject(new Error("the process would not end")) },
		to: both.onRex,
	});

	const outcome = await agents.handOver("card-a");

	expect(outcome).toMatchObject({ handedOver: false, refusal: "cannot_resume" });
	expect(outcome).toMatchObject({ reason: expect.stringContaining("the process would not end") });
	expect(both.windowsOpened()).toEqual([]);
	expect((await agents.list()).map(({ name }) => name)).toEqual(["card-a"]);
	await agents.prompt("card-a", "still here");
});

test("a handover whose mark does not reach the file is refused with why: the job stays on ACP, and no window opens", async () => {
	const both = await sides();
	await both.ran();
	const [pid] = await both.pids();
	await mkdir(`${both.acp.sessionsFile}.tmp`);

	const outcome = await both.agents.handOver("card-a");

	expect(outcome).toMatchObject({ handedOver: false, refusal: "cannot_resume" });
	expect(outcome).toMatchObject({ reason: expect.stringContaining("could not be recorded") });
	expect(both.windowsOpened()).toEqual([]);
	expect((await both.entry()).handedOver).toBeUndefined();
	expect(alive(pid as number)).toBe(true);
	expect(await both.closed()).toBe("");
	expect((await both.agents.list()).map(({ name }) => name)).toEqual(["card-a"]);
	await both.agents.prompt("card-a", "still here");
});

test("a job is windowless while it runs over ACP, and neither while its turn is cut to move it nor once it is in its window", async () => {
	const both = await sides({ fake: { FAKE_ACP_HELD: "stop" } });
	await inTurn(both, "SPIN");
	expect(await both.agents.windowless?.("card-a")).toBe(true);

	const moving = both.agents.handOver("card-a");
	while ((await both.cancelled()) === "") await sleep(5);
	expect(await both.agents.windowless?.("card-a")).toBe(false);

	await both.release("stop");
	expect(await moving).toMatchObject({ handedOver: true });
	expect(await both.agents.windowless?.("card-a")).toBe(false);
});

test("while a job moves it is listed with no status and takes no prompt, and a second handover waits and is refused", async () => {
	const both = await sides();
	await both.ran();
	let open = () => {};
	const opening = new Promise<void>((resolve) => {
		open = resolve;
	});
	const original = both.hangar.client.call.bind(both.hangar.client);
	both.hangar.client.call = async (method, payload, schema) => {
		if (method === "session.new_window") await opening;
		return original(method, payload, schema);
	};

	const moving = both.agents.handOver("card-a");
	const again = both.agents.handOver("card-a");
	for (const deadline = Date.now() + 5_000; (await both.closed()) === ""; await sleep(5)) {
		expect(Date.now()).toBeLessThan(deadline);
	}
	await sleep(50);

	expect(await both.agents.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
	await expect(both.agents.prompt("card-a", "now")).rejects.toThrow(PromptRefused);
	await expect(both.agents.prompt("card-a", "now")).rejects.toThrow("being handed over");
	await expect(both.agents.readScreen("card-a")).rejects.toThrow("being handed over");
	await expect(both.agents.stop("card-a")).rejects.toThrow("being handed over");
	await expect(both.agents.resume({ name: "card-a", card: "card-a", sessionId: SESSION })).rejects.toThrow(
		"being handed over",
	);
	expect(await both.agents.respond("card-a", { option: "1", fingerprint: "f" })).toEqual({
		sent: false,
		refusal: "not_blocked",
		reason: "card-a is being handed over",
	});
	expect((await both.agents.readResult("card-a"))?.text).toBe("echo: the word is KIWI");

	open();
	expect(await moving).toMatchObject({ handedOver: true });
	expect(await again).toMatchObject({ handedOver: false, refusal: "not_acp" });
	expect(both.windowsOpened()).toHaveLength(1);
});

test("a listing under way as a move ends still names the job, which neither side's answer holds", async () => {
	const both = await sides();
	await both.ran();
	const gate = () => {
		let open = () => {};
		const opening = new Promise<void>((resolve) => {
			open = resolve;
		});
		return { open, opening };
	};
	const answering = gate();
	const windowing = gate();
	const original = both.hangar.client.call.bind(both.hangar.client);
	both.hangar.client.call = async (method, payload, schema) => {
		if (method === "session.new_window") await windowing.opening;
		return original(method, payload, schema);
	};
	const agents = createHandoverAgentPort({
		from: {
			...both.acp.port,
			list: async () => {
				const listed = await both.acp.port.list();
				await answering.opening;
				return listed;
			},
		},
		to: both.onRex,
	});
	const moving = agents.handOver("card-a");
	for (const deadline = Date.now() + 5_000; (await both.closed()) === ""; await sleep(5)) {
		expect(Date.now()).toBeLessThan(deadline);
	}
	await sleep(50);

	const listing = agents.list();
	windowing.open();
	await moving;
	answering.open();

	expect(await listing).toEqual([{ name: "card-a", sessionId: SESSION }]);
});

test("the trust dialog a handover answers never reaches the core, and what the window says afterwards does", async () => {
	const both = await sides({ opened: { records: [], screen: fixture("claude-trust-dialog-2.1.302.txt") } });
	const heard: AgentStatusEvent[] = [];
	const off = both.agents.onStatus((event) => heard.push(event));
	await both.ran();
	const pressed: string[] = [];
	both.hangar.replace("block.event", (payload) => {
		const { key, action } = (payload.event as { payload: { key: string; action: string } }).payload;
		if (action === "press") pressed.push(key);
		if (action === "press" && key === "enter") setTimeout(() => (both.blocks[0] as Block).records?.push(AT_IDLE), 30);
		return both.hangar.original("block.event")(payload);
	});

	expect(await both.agents.handOver("card-a")).toMatchObject({ handedOver: true, ready: true });
	expect(pressed).toEqual(["arrow_down", "enter"]);
	expect(heard.filter((event) => event.status.state === "blocked")).toEqual([]);

	const window = both.blocks[0] as Block;
	window.records = [WORKING];
	both.hangar.emit(both.hangar.status(window.block, WORKING));
	for (const deadline = Date.now() + 2_000; !heard.some((event) => event.seq === seqOf(WORKING)); await sleep(5)) {
		expect(Date.now()).toBeLessThan(deadline);
	}
	off();
});

test("a handover whose claude leaves its window says not ready at once, with the job handed over", async () => {
	const both = await sides({ opened: { records: [], screen: "$ claude --resume" }, takeMs: 60_000 });
	await both.ran();
	const moving = both.agents.handOver("card-a");
	for (const deadline = Date.now() + 5_000; both.blocks.length === 0; await sleep(5)) {
		expect(Date.now()).toBeLessThan(deadline);
	}
	await sleep(30);
	(both.blocks[0] as Block).argv0 = "-fish";

	expect(await moving).toMatchObject({ handedOver: true, ready: false });
	expect((await both.entry()).handedOver).toBe(true);
});

test("a job not handed over has nothing on rex: no window, no call for its listing, no status, and nothing foreign", async () => {
	const human: Block = { name: "mine", block: "block:human", argv0: "claude", cwd: "/home/me", records: [AT_IDLE] };
	const namesake: Block = { name: "card-a", block: "block:namesake", argv0: "claude", records: [AT_IDLE] };
	const both = await sides({
		blocks: [namesake],
		others: [{ id: "session:work", label: "work", blocks: [human] }],
	});
	const heard: AgentStatusEvent[] = [];
	const off = both.agents.onStatus((event) => heard.push(event));
	await both.ran();
	const before = both.hangar.calls.length;
	const views = () => both.hangar.calls.slice(before).filter((call) => call.method === "session.view");

	const listed = await both.agents.list();

	expect(listed.map(({ name }) => name)).toEqual(["card-a"]);
	expect(listed[0]?.sessionId).toBe(SESSION);
	expect(views()).toEqual([]);
	expect(both.windowsOpened()).toEqual([]);
	// A window a human named after the job is theirs: its status is not the job's, and its prompt not the job's either.
	both.hangar.emit(both.hangar.status("block:namesake", WORKING));
	await sleep(50);
	expect(heard.filter((event) => event.seq === seqOf(WORKING))).toEqual([]);
	await both.agents.prompt("card-a", "over ACP");
	expect(both.typed()).toEqual([]);
	off();

	// Only what a human opened is foreign, the namesake included, and the job's own window never is.
	const foreign = async () => (await both.agents.listForeign()).map((agent) => agent.id).sort();
	expect(await foreign()).toEqual(["block:human", "block:namesake"]);
});

test("with a job handed over, only its window is listed from the hangar, and only its statuses are passed on", async () => {
	const mine: Block = { name: "mine", block: "block:mine", argv0: "claude", records: [AT_IDLE] };
	const both = await sides({ blocks: [mine] });
	const heard: AgentStatusEvent[] = [];
	const off = both.agents.onStatus((event) => heard.push(event));
	await both.ran();
	await both.agents.handOver("card-a");

	expect((await both.agents.list()).map(({ name }) => name)).toEqual(["card-a"]);
	both.hangar.emit(both.hangar.status("block:mine", WORKING));
	await sleep(50);
	expect(heard.filter((event) => event.agent === "mine")).toEqual([]);
	off();
});

test("a window handed over is no foreign agent", async () => {
	const human: Block = { name: "mine", block: "block:human", argv0: "claude", cwd: "/home/me", records: [AT_IDLE] };
	const both = await sides({ others: [{ id: "session:work", label: "work", blocks: [human] }] });
	await both.ran();
	await both.agents.handOver("card-a");

	expect(both.blocks).toHaveLength(1);
	expect((await both.agents.listForeign()).map((agent) => agent.id)).toEqual(["block:human"]);
});

test("noHandover says why, doing nothing", async () => {
	expect(await noHandover("not_acp", "this soma runs its jobs on rex").handOver("card-a")).toEqual({
		handedOver: false,
		refusal: "not_acp",
		reason: "this soma runs its jobs on rex",
	});
});

test("a resume of a session the ACP side never started goes to the ACP side with its cwd", async () => {
	const asked: unknown[] = [];
	const both = await sides({
		from: (port) => ({
			...port,
			resume: (request) => {
				asked.push(request);
				return port.resume(request);
			},
		}),
	});
	const request = { name: "soma-repo-7e33", card: "soma-repo-7e33", sessionId: SESSION, cwd: both.acp.cwd };

	// The fake CLI left no transcript of it, so the ACP side cannot adopt it.
	await expect(both.agents.resume(request)).rejects.toThrow(/has no transcript/);

	expect(asked).toEqual([request]);
	expect(both.windowsOpened()).toEqual([]);
});

test("the session a foreign pane is in is looked for on the rex side", async () => {
	const asked: string[] = [];
	const both = await sides({
		to: (port) => ({
			...port,
			findForeignSession: async (sessionId) => {
				asked.push(sessionId);
				return "block:pane";
			},
		}),
	});

	expect(await both.agents.findForeignSession(SESSION)).toBe("block:pane");
	expect(asked).toEqual([SESSION]);
});
