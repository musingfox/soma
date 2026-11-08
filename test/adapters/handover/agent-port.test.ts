import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createHandoverAgentPort, noHandover } from "../../../src/adapters/handover/agent-port.ts";
import { seqOf } from "../../../src/adapters/rex/agent-port.ts";
import { type AgentStatusEvent, PromptRefused } from "../../../src/ports/agent.ts";
import { cleanUp, SESSION } from "../acp/fake.ts";
import { AT, type Block, fixture, HANGAR } from "../rex/fake.ts";
import { AT_IDLE, alive, sides, sleep } from "./fake.ts";

afterEach(cleanUp);

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

test("a job working, blocked, never prompted or with its window name taken is refused, with nothing done", async () => {
	const both = await sides({ blocks: [{ name: "taken", block: "block:taken" }] });
	await both.acp.start("working");
	await both.acp.until("idle", 0, "working");
	await both.agents.prompt("working", "HANG");
	await both.acp.until("working", 0, "working");
	await both.acp.start("blocked");
	await both.acp.until("idle", 0, "blocked");
	await both.agents.prompt("blocked", "ASK");
	await both.acp.until("blocked", 0, "blocked");
	await both.acp.start("fresh");
	await both.acp.until("idle", 0, "fresh");
	await both.ran("taken");
	const running = await both.pids();

	for (const [name, refusal, reason] of [
		["working", "not_at_rest", /is working/],
		["blocked", "not_at_rest", /is blocked/],
		["fresh", "cannot_resume", /never ran a prompt/],
		["taken", "cannot_resume", /already has a window named taken/],
		["nobody", "not_acp", /no agent acp holds/],
	] as const) {
		const outcome = await both.agents.handOver(name);
		expect(outcome).toMatchObject({ handedOver: false, refusal, reason: expect.stringMatching(reason) });
	}

	expect(await both.closed()).toBe("");
	expect(both.windowsOpened()).toEqual([]);
	for (const pid of running) expect(alive(pid)).toBe(true);
	for (const name of ["working", "blocked", "fresh", "taken"])
		expect((await both.entry(name)).handedOver).toBeUndefined();
	await both.acp.port.prompt("taken", "still here");
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
		if (method === "session.new_window") throw new Error("rex refused the window");
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
