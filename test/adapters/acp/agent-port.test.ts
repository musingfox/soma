import { readFileSync } from "node:fs";
import { mkdir, readFile, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type AgentStatusEvent, NotImplemented, PromptRefused } from "../../../src/ports/agent.ts";
import { cleanUp, git, harness, SESSION, sleep } from "./fake.ts";

afterEach(cleanUp);

const MARK = { hangar: "session:hangar", at: 1_000 };

const states = (events: AgentStatusEvent[], from = 0) => events.slice(from).map((event) => event.status.state);

test("start runs the agent as soma's child in the card's worktree, with SOMA_AGENT set, and reports idle once its session is open", async () => {
	const acp = await harness();
	await acp.start();
	const idle = await acp.until("idle");
	expect(idle.status).toEqual({ state: "idle" });
	expect(await acp.port.list()).toEqual([
		{ name: "card-a", sessionId: SESSION, status: { state: "idle" }, seq: idle.seq },
	]);

	const from = acp.events.length;
	await acp.port.prompt("card-a", "ENV");
	await acp.until("done", from);
	const worktree = await realpath(join(acp.cwd, ".claude", "worktrees", "card-a"));
	expect((await acp.port.readResult("card-a"))?.text).toBe(
		`SOMA_AGENT=card-a ppid=${process.pid} cwd=${worktree} session=${worktree}`,
	);
	expect(await git(worktree, ["branch", "--show-current"])).toBe("fleet/card-a\n");
});

test("the session id and cwd a later session/load needs are recorded under the agent's name", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	const recorded = JSON.parse(await readFile(acp.sessionsFile, "utf8"));
	expect(recorded).toEqual({
		"card-a": {
			card: "card-a",
			sessionId: SESSION,
			acpSessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			cwd: await realpath(join(acp.cwd, ".claude", "worktrees", "card-a")),
		},
	});
	expect(recorded["card-a"].acpSessionId).not.toBe(SESSION);
});

test("the session is recorded before its idle is reported", async () => {
	const acp = await harness();
	const seen: unknown[] = [];
	acp.port.onStatus((event) => {
		if (event.status.state !== "idle" || seen.length > 0) return;
		try {
			seen.push(JSON.parse(readFileSync(acp.sessionsFile, "utf8")));
		} catch (error) {
			seen.push(error);
		}
	});
	await acp.start();
	await acp.until("idle");
	expect(seen).toEqual([{ "card-a": expect.objectContaining({ card: "card-a", sessionId: SESSION }) }]);
});

test("the first idle is resent under its seq until the agent reports anything else", async () => {
	const acp = await harness();
	await acp.start();
	const idle = await acp.until("idle");
	await sleep(200);
	const resent = acp.events.slice(acp.events.indexOf(idle));
	expect(resent.length).toBeGreaterThan(2);
	expect(resent).toEqual(resent.map(() => idle));
	const from = acp.events.length;
	await acp.port.prompt("card-a", "hello");
	await acp.until("done", from);
	await sleep(200);
	// A resend may land while the prompt reads the transcript, before it reports working; none comes after.
	const turn = states(acp.events, from);
	expect(turn.slice(turn.indexOf("working"))).toEqual(["working", "done"]);
});

test("a prompt turns the agent working and its end done, under seqs that only go up", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	const from = acp.events.length;
	await acp.port.prompt("card-a", "hello");
	expect(acp.events.at(-1)?.status).toEqual({ state: "working" });
	await acp.until("done", from);
	expect(states(acp.events, from)).toEqual(["working", "done"]);
	// The first idle may have been resent under its own seq before the prompt; every new observation has a new one.
	const seqs = acp.events.map((event) => event.seq);
	expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
	const turn = acp.events.slice(from - 1).map((event) => event.seq);
	expect(new Set(turn).size).toBe(turn.length);
	expect(await acp.port.readResult("card-a")).toEqual({ id: expect.any(String), text: "echo: hello" });
});

test("a turn cancelled ends idle, and one cut short ends done with its stop reason", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	let from = acp.events.length;
	await acp.port.prompt("card-a", "CANCEL");
	expect((await acp.until("idle", from)).status).toEqual({ state: "idle" });
	from = acp.events.length;
	await acp.port.prompt("card-a", "LONG");
	expect((await acp.until("done", from)).status).toEqual({ state: "done", msg: "the turn stopped: max_tokens" });
});

test("a permission request blocks the agent with its options, and respond answers it by option number", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	const from = acp.events.length;
	await acp.port.prompt("card-a", "ASK");
	const blocked = await acp.until("blocked", from);
	expect(blocked.status).toEqual({
		state: "blocked",
		kind: "permission",
		msg: "approve touch probe.txt\nCreate probe.txt\n1. Yes\n2. Yes, and don't ask again for touch\n3. No",
		fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
		options: [
			{ id: "1", label: "Yes" },
			{ id: "2", label: "Yes, and don't ask again for touch" },
			{ id: "3", label: "No" },
		],
	});
	const fingerprint = blocked.status.state === "blocked" ? (blocked.status.fingerprint ?? "") : "";

	expect(await acp.port.respond("card-a", { option: "1", fingerprint: "0000000000000000" })).toEqual({
		sent: false,
		refusal: "stale",
	});
	expect(await acp.port.respond("card-a", { option: "4", fingerprint })).toEqual({
		sent: false,
		refusal: "unknown_option",
	});
	const answered = acp.events.length;
	expect(await acp.port.respond("card-a", { option: "1", fingerprint })).toEqual({ sent: true });
	await acp.until("done", answered);
	expect(states(acp.events, answered)).toEqual(["working", "done"]);
	expect((await acp.port.readResult("card-a"))?.text).toBe("結果：完成\npermission allow-once");
	expect(await acp.port.respond("card-a", { option: "1", fingerprint })).toEqual({
		sent: false,
		refusal: "not_blocked",
	});
});

test("the same request asked again gets a fingerprint of its own", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	const fingerprints: string[] = [];
	for (const option of ["3", "2"]) {
		const from = acp.events.length;
		await acp.port.prompt("card-a", "ASK");
		const blocked = await acp.until("blocked", from);
		const fingerprint = blocked.status.state === "blocked" ? (blocked.status.fingerprint ?? "") : "";
		fingerprints.push(fingerprint);
		expect(await acp.port.respond("card-a", { option, fingerprint })).toEqual({ sent: true });
		await acp.until("done", from);
	}
	expect(fingerprints[0]).not.toBe(fingerprints[1]);
	expect((await acp.port.readResult("card-a"))?.text).toBe("結果：完成\npermission allow-with-updates");
});

const fingerprintOf = (event: AgentStatusEvent) =>
	event.status.state === "blocked" ? (event.status.fingerprint ?? "") : "";

test("a request made while another waits queues behind it, under a fingerprint of its own", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	const from = acp.events.length;
	await acp.port.prompt("card-a", "TWICE");
	const first = await acp.until("blocked", from);
	expect(first.status).toMatchObject({ msg: "approve touch one.txt\n1. Yes\n2. No" });
	await sleep(150);
	// The second request waits behind the first: nothing is reported, and the screen shows the first.
	expect(acp.events.slice(acp.events.indexOf(first) + 1)).toEqual([]);
	expect(await acp.port.readScreen("card-a")).toMatch(/approve touch one\.txt/);

	const answered = acp.events.length;
	expect(await acp.port.respond("card-a", { option: "1", fingerprint: fingerprintOf(first) })).toEqual({ sent: true });
	const second = await acp.until("blocked", answered);
	expect(second.status).toMatchObject({ msg: "approve touch two.txt\n1. Yes\n2. No" });
	// The same tool call id and options, asked again: the request's ordinal tells the two apart.
	expect(fingerprintOf(second)).not.toBe(fingerprintOf(first));
	expect(await acp.port.respond("card-a", { option: "2", fingerprint: fingerprintOf(first) })).toEqual({
		sent: false,
		refusal: "stale",
	});
	expect(await acp.port.respond("card-a", { option: "2", fingerprint: fingerprintOf(second) })).toEqual({
		sent: true,
	});
	await acp.until("done", answered);
	expect(states(acp.events, from)).toEqual(["working", "blocked", "blocked", "working", "done"]);
	expect((await acp.port.readResult("card-a"))?.text).toBe("permission allow-once reject");
});

test("a request the agent withdraws is dropped, and the turn goes on working", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	const from = acp.events.length;
	await acp.port.prompt("card-a", "WITHDRAW");
	const blocked = await acp.until("blocked", from);
	await acp.until("working", acp.events.indexOf(blocked) + 1, "card-a", 1_000);
	expect(await acp.port.respond("card-a", { option: "1", fingerprint: fingerprintOf(blocked) })).toEqual({
		sent: false,
		refusal: "not_blocked",
	});
	expect(await acp.port.readScreen("card-a")).not.toMatch(/approve/);
	await acp.until("done", from);
	expect(states(acp.events, from)).toEqual(["working", "blocked", "working", "done"]);
	expect((await acp.port.readResult("card-a"))?.text).toBe("withdrawn");
});

test("a request still open when its turn ends leaves nothing to answer, and the next turn's request is shown", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	let from = acp.events.length;
	await acp.port.prompt("card-a", "ABANDON");
	const blocked = await acp.until("blocked", from);
	await acp.until("done", from);
	expect(await acp.port.respond("card-a", { option: "1", fingerprint: fingerprintOf(blocked) })).toEqual({
		sent: false,
		refusal: "not_blocked",
	});
	expect(await acp.port.readScreen("card-a")).not.toMatch(/approve/);

	from = acp.events.length;
	await acp.port.prompt("card-a", "ASK");
	const next = await acp.until("blocked", from, "card-a", 1_000);
	expect(next.status).toMatchObject({ msg: expect.stringMatching(/^approve touch probe\.txt\nCreate probe\.txt\n/) });
	expect(await acp.port.respond("card-a", { option: "1", fingerprint: fingerprintOf(next) })).toEqual({ sent: true });
	await acp.until("done", from);
});

test("a prompt goes only to an agent between turns, and a reply to a done one starts its next turn", async () => {
	const acp = await harness({ fake: { FAKE_ACP_NEW_MS: "300" } });
	await acp.start();
	await expect(acp.port.prompt("card-a", "too early")).rejects.toThrow(PromptRefused);
	await acp.until("idle");
	let from = acp.events.length;
	await acp.port.prompt("card-a", "ASK");
	const blocked = await acp.until("blocked", from);
	await expect(acp.port.prompt("card-a", "1")).rejects.toThrow(/is blocked: a prompt goes only between turns/);
	await expect(acp.port.prompt("card-b", "hi")).rejects.toThrow(PromptRefused);
	const fingerprint = blocked.status.state === "blocked" ? (blocked.status.fingerprint ?? "") : "";
	await acp.port.respond("card-a", { option: "1", fingerprint });
	await acp.until("done", from);

	from = acp.events.length;
	await acp.port.prompt("card-a", "the human's answer");
	await acp.until("done", from);
	expect((await acp.port.readResult("card-a"))?.text).toBe("echo: the human's answer");
});

test("readResult waits for a reply written after the turn's end", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	await acp.port.prompt("card-a", "first");
	await acp.until("done");
	const from = acp.events.length;
	await acp.port.prompt("card-a", "LATE");
	await acp.until("done", from);
	expect((await acp.port.readResult("card-a"))?.text).toBe("late reply");
});

test("a turn that ends without a reply is read at replyMs as it ends, and its end is reported again", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	const from = acp.events.length;
	await acp.port.prompt("card-a", "CANCEL");
	const idle = await acp.until("idle", from);
	const result = await acp.port.readResult("card-a");
	expect(result).toEqual({ id: expect.any(String) });
	const again = await acp.until("idle", acp.events.indexOf(idle) + 1);
	expect(again.seq).toBeGreaterThan(idle.seq);
	// The re-report is no turn's end: it is read at once.
	const before = Date.now();
	expect(await acp.port.readResult("card-a")).toEqual(result);
	expect(Date.now() - before).toBeLessThan(300);
});

test("screen draws the tail of the agent's transcript, with the request it waits on", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	expect(await acp.port.readScreen("card-a")).toBe("");
	await acp.port.prompt("card-a", "hello");
	await acp.until("done");
	const from = acp.events.length;
	await acp.port.prompt("card-a", "ASK");
	const blocked = await acp.until("blocked", from);
	expect(await acp.port.readScreen("card-a")).toBe(
		[
			"> hello",
			"",
			"● echo: hello",
			"",
			"> ASK",
			"",
			"● Bash(touch probe.txt)",
			"",
			"● approve touch probe.txt",
			"  Create probe.txt",
			"  1. Yes",
			"  2. Yes, and don't ask again for touch",
			"  3. No",
		].join("\n"),
	);
	const fingerprint = blocked.status.state === "blocked" ? (blocked.status.fingerprint ?? "") : "";
	await acp.port.respond("card-a", { option: "1", fingerprint });
	await acp.until("done", from);
	expect((await acp.port.readScreen("card-a")).split("\n").slice(-5)).toEqual([
		"● Bash(touch probe.txt)",
		"  ⎿  chosen allow-once",
		"",
		"● 結果：完成",
		"  permission allow-once",
	]);
	await expect(acp.port.readScreen("card-b")).rejects.toThrow("acp has no agent named card-b");
});

test("screen reads back past claude's records that are no part of the conversation", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	await acp.port.prompt("card-a", "first");
	await acp.until("done");
	const from = acp.events.length;
	await acp.port.prompt("card-a", "BULKY");
	await acp.until("done", from);
	expect(await acp.port.readScreen("card-a")).toBe(
		["> first", "", "● echo: first", "", "> BULKY", "", "● bulky reply"].join("\n"),
	);
});

test("Authentication required on a prompt is a configuration error naming HOME and USER, not a failure of the job", async () => {
	const acp = await harness({ fake: { USER: "" } });
	await acp.start();
	await acp.until("idle");
	const from = acp.events.length;
	await acp.port.prompt("card-a", "AUTH");
	const blocked = await acp.until("blocked", from);
	expect(blocked.status).toEqual({
		state: "blocked",
		kind: "auth",
		msg: expect.stringMatching(
			/^configuration error: claude-agent-acp refused the prompt with -32000 Authentication required\..*HOME=\/home\/someone and USER=unset\..*log it in, then reply to the job/,
		),
	});
	expect(states(acp.events, from)).toEqual(["working", "blocked"]);
	expect(acp.errors.map((error) => error.message)).toEqual([
		expect.stringMatching(/^agent card-a: configuration error/),
	]);
	expect(await acp.port.respond("card-a", { option: "1", fingerprint: "x" })).toEqual({ sent: false, refusal: "auth" });
	// No turn runs, so once the login is fixed a reply goes.
	const replied = acp.events.length;
	await acp.port.prompt("card-a", "again");
	await acp.until("done", replied);
});

test("Authentication required on session/new leaves a job with no session, which says it takes no reply", async () => {
	const acp = await harness({ fake: { FAKE_ACP_NEW_AUTH: "1" } });
	await acp.start();
	const blocked = await acp.until("blocked");
	expect(blocked.status).toEqual({
		state: "blocked",
		kind: "auth",
		msg: expect.stringMatching(
			/^configuration error: claude-agent-acp refused session\/new with -32000 Authentication required, so this job has no session: it takes no reply.*HOME=\/home\/someone and USER=someone\..*no session to load again, so after the restart it is reported gone\.$/,
		),
	});
	expect(blocked.status.state === "blocked" && blocked.status.msg).not.toMatch(/reply to the job/);
	await expect(acp.port.prompt("card-a", "again")).rejects.toThrow(/has no session yet/);
});

test("an agent whose process exits reports error with how it exited", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	await acp.port.prompt("card-a", "EXIT");
	expect((await acp.until("error")).status).toEqual({ state: "error", msg: "claude-agent-acp exited with code 3" });
	await expect(acp.port.prompt("card-a", "hi")).rejects.toThrow(/has exited/);
	expect(await acp.port.respond("card-a", { option: "1", fingerprint: "x" })).toEqual({
		sent: false,
		refusal: "not_blocked",
	});
});

test("stop closes the session and ends the process, reports nothing, and the result is still read", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	await acp.port.prompt("card-a", "hello");
	await acp.until("done");
	const from = acp.events.length;
	await acp.port.stop("card-a");
	await sleep(200);
	expect(acp.events.slice(from)).toEqual([]);
	expect(await acp.port.list()).toEqual([]);
	expect((await acp.port.readResult("card-a"))?.text).toBe("echo: hello");
	await expect(acp.port.stop("card-a")).rejects.toThrow("acp has no agent named card-a");
	const { acpSessionId } = JSON.parse(await readFile(acp.sessionsFile, "utf8"))["card-a"];
	expect(await readFile(join(acp.cwd, "..", "projects", "closed"), "utf8")).toBe(`${acpSessionId}\n`);
	// The name is free again.
	await acp.start();
	await acp.until("idle", from);
});

test("start refuses a name already running and a full hangar, and gives up on an agent that never initializes", async () => {
	const acp = await harness({ cap: 1 });
	await acp.start();
	await expect(acp.start()).rejects.toThrow("acp already runs an agent named card-a");
	await expect(acp.start("card-b")).rejects.toThrow("hangar is full: 1 of 1 agents running");

	const mute = await harness({ args: ["-e", "setInterval(() => {}, 1000)"], startMs: 200 });
	await expect(mute.start()).rejects.toThrow(/^the ACP agent for card-a did not initialize/);
	expect(await mute.port.list()).toEqual([]);
});

test("there are no foreign agents", async () => {
	const acp = await harness();
	expect(await acp.port.listForeign()).toEqual([]);
	await expect(acp.port.promptForeign("x", "hi")).rejects.toThrow(PromptRefused);
});

/** The ACP session each agent ran, as the sessions file records it. */
const recorded = async (acp: { sessionsFile: string }) =>
	JSON.parse(await readFile(acp.sessionsFile, "utf8")) as Record<
		string,
		{ acpSessionId: string; cwd: string; stopped?: true }
	>;

/** Every agent process the port ran, by the name it ran for; none when it ran none. */
const spawned = async (acp: { cwd: string; instance: number }) =>
	(await readFile(join(acp.cwd, "..", `pids-${acp.instance}`), "utf8").catch(() => ""))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split(" ") as [string, string]);

const alive = (pid: string) => {
	try {
		process.kill(Number(pid), 0);
		return true;
	} catch {
		return false;
	}
};

/** A soma that ran a prompt in each named agent, then ended with them. */
async function ranThenEnded(names: readonly string[], options: Parameters<typeof harness>[0] = {}) {
	const first = await harness({ cap: 8, ...options });
	for (const name of names) {
		await first.start(name);
		await first.until("idle", 0, name);
		const from = first.events.length;
		await first.port.prompt(name, `hello ${name}`);
		await first.until("done", from, name);
	}
	return first;
}

test("after a restart, each agent soma did not stop and that ran a prompt is listed dormant, with no process and no status", async () => {
	const first = await ranThenEnded(["card-a", "card-b"]);
	// card-c never runs a prompt, so it has no transcript to load.
	await first.start("card-c");
	await first.until("idle", 0, "card-c");
	await first.port.stop("card-b");
	await first.end();

	const second = await harness({ cwd: first.cwd });
	expect(await second.port.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
	expect(await second.port.dormant()).toEqual(["card-a"]);
	expect(await spawned(second)).toEqual([]);
	const sessions = await recorded(first);
	expect(sessions["card-b"]?.stopped).toBe(true);
	expect(sessions["card-a"]).not.toHaveProperty("stopped");
	expect(second.errors.map((error) => error.message)).toEqual([
		`agent card-c is not listed after the restart: ACP session ${sessions["card-c"]?.acpSessionId} in ` +
			`${sessions["card-c"]?.cwd} has no transcript, so it never ran a prompt`,
	]);
	await expect(second.port.prompt("card-c", "hi")).rejects.toThrow(PromptRefused);
	// Waiting changes nothing: no process is started behind the listing.
	await sleep(300);
	expect(await spawned(second)).toEqual([]);
});

test("a dormant agent counts against the hangar cap only once it has a process", async () => {
	const first = await ranThenEnded(["card-a"], { cap: 1 });
	await first.end();

	const second = await harness({ cwd: first.cwd, cap: 1 });
	await second.start("card-b");
	await second.until("idle", 0, "card-b");
	const refused = second.port.prompt("card-a", "RECALL");
	await expect(refused).rejects.toThrow(PromptRefused);
	await expect(refused).rejects.toThrow("acp agent card-a is dormant: hangar is full: 1 of 1 agents running");
	expect((await spawned(second)).map(([name]) => name)).toEqual(["card-b"]);
	// Refused by the cap, it is still dormant, and woken once there is room.
	await second.port.stop("card-b");
	const from = second.events.length;
	await second.port.prompt("card-a", "RECALL");
	await second.until("done", from);
	await expect(second.start("card-c")).rejects.toThrow("hangar is full: 1 of 1 agents running");
});

test("the first prompt to a dormant agent starts it with session/load of its recorded session and cwd, and it answers from its earlier context", async () => {
	const first = await harness();
	await first.start();
	await first.until("idle");
	await first.port.prompt("card-a", "the word is KIWI");
	await first.until("done");
	await first.end();
	const loaded = join(first.cwd, "..", "projects", "loaded");

	const second = await harness({ cwd: first.cwd });
	await second.port.list();
	await expect(readFile(loaded, "utf8")).rejects.toThrow(/ENOENT/);
	const from = second.events.length;
	// Both wait for the same wake; whichever goes second finds the turn under way.
	const both = await Promise.allSettled([
		second.port.prompt("card-a", "RECALL"),
		second.port.prompt("card-a", "RECALL again"),
	]);
	expect(both.map((each) => each.status).sort()).toEqual(["fulfilled", "rejected"]);
	expect(both.find((each) => each.status === "rejected")).toMatchObject({ reason: expect.any(PromptRefused) });
	await second.until("done", from);
	expect((await second.port.readResult("card-a"))?.text).toBe("recall: the word is KIWI");
	const { acpSessionId, cwd } = (await recorded(first))["card-a"] ?? { acpSessionId: "", cwd: "" };
	expect(await readFile(loaded, "utf8")).toBe(`${acpSessionId} ${cwd}\n`);
	expect((await spawned(second)).map(([name]) => name)).toEqual(["card-a"]);
	expect((await second.port.list()).map(({ name, status }) => ({ name, status }))).toEqual([
		{ name: "card-a", status: { state: "done" } },
	]);
	// A process of the second port's own, still soma's child.
	const next = second.events.length;
	await second.port.prompt("card-a", "ENV");
	await second.until("done", next);
	expect((await second.port.readResult("card-a"))?.text).toBe(
		`SOMA_AGENT=card-a ppid=${process.pid} cwd=${cwd} session=${cwd}`,
	);
});

test("an agent whose turn the restart cut short is dormant like any other, and a prompt goes on in its session", async () => {
	const first = await harness();
	await first.start();
	await first.until("idle");
	await first.port.prompt("card-a", "HANG");
	// Working is reported as the prompt goes; the turn is under way once claude wrote it.
	while (!(await first.port.readScreen("card-a")).includes("> HANG")) await sleep(10);
	await first.end();

	const second = await harness({ cwd: first.cwd });
	expect(await second.port.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
	const from = second.events.length;
	await second.port.prompt("card-a", "RECALL");
	await second.until("done", from);
	expect((await second.port.readResult("card-a"))?.text).toBe("recall: HANG");
});

test("a dormant agent whose session cannot be loaded refuses the prompt with the reason, reports it as an error and logs it", async () => {
	const first = await ranThenEnded(["card-a", "card-b", "card-c"]);
	await first.end();
	const sessions = await recorded(first);
	await rm(sessions["card-c"]?.cwd ?? "", { recursive: true, force: true });

	const second = await harness({
		cwd: first.cwd,
		fake: { FAKE_ACP_LOAD_AUTH: "card-a", FAKE_ACP_LOAD_EXIT: "card-b" },
	});
	const load = (name: string) =>
		`session/load of ACP session ${sessions[name]?.acpSessionId} in ${sessions[name]?.cwd} failed: `;
	const why = {
		"card-a": new RegExp(`^${literal(load("card-a"))}-32000 Authentication required$`),
		"card-b": new RegExp(`^${literal(load("card-b"))}.*; the process exited with code 4$`),
		"card-c": new RegExp(`^its worktree ${literal(sessions["card-c"]?.cwd ?? "")} is gone$`),
	};
	for (const [name, reason] of Object.entries(why)) {
		const refused = await second.port.prompt(name, "hi").then(
			() => undefined,
			(error: Error) => error,
		);
		expect(refused).toBeInstanceOf(PromptRefused);
		expect(refused?.message.replace(`acp agent ${name} is not woken: `, "")).toMatch(reason);
		const error = await second.until("error", 0, name);
		expect(error.status.msg).toMatch(reason);
		expect(second.errors.map((each) => each.message).filter((each) => each.startsWith(`agent ${name} `))).toEqual([
			`agent ${name} is not woken: ${error.status.msg}`,
		]);
	}
	// Each stays listed, with its error, and none of the processes started for them is left.
	expect((await second.port.list()).map(({ name, status }) => [name, status?.state])).toEqual([
		["card-a", "error"],
		["card-b", "error"],
		["card-c", "error"],
	]);
	expect((await spawned(second)).map(([name]) => name).sort()).toEqual(["card-a", "card-b"]);
	await sleep(200);
	expect((await spawned(second)).filter(([, pid]) => alive(pid))).toEqual([]);
});

test("readResult, readScreen and stop of a dormant agent read its transcript and record the stop without a process", async () => {
	const first = await ranThenEnded(["card-a"]);
	await first.end();

	const second = await harness({ cwd: first.cwd });
	expect((await second.port.readResult("card-a"))?.text).toBe("echo: hello card-a");
	expect(await second.port.readScreen("card-a")).toContain("> hello card-a");
	expect(await second.port.respond("card-a", { option: "1", fingerprint: "x" })).toEqual({
		sent: false,
		refusal: "not_blocked",
	});
	await second.port.stop("card-a");
	expect(await second.port.list()).toEqual([]);
	expect((await recorded(first))["card-a"]?.stopped).toBe(true);
	// Read off the session it ran, as a stopped agent's is.
	expect((await second.port.readResult("card-a"))?.text).toBe("echo: hello card-a");
	expect(await spawned(second)).toEqual([]);
	await second.end();

	const third = await harness({ cwd: first.cwd });
	expect(await third.port.list()).toEqual([]);
});

test("a stop and a first prompt to a dormant agent in the same tick leave no process: the prompt is refused, the stop holds", async () => {
	const first = await ranThenEnded(["card-a"]);
	await first.end();

	const second = await harness({ cwd: first.cwd });
	const from = second.events.length;
	const stopped = second.port.stop("card-a");
	// Caught at once: the prompt is refused before the stop has recorded.
	const prompted = second.port.prompt("card-a", "RECALL").then(
		() => undefined,
		(error: Error) => error,
	);
	await stopped;
	const refused = await prompted;
	expect(refused).toBeInstanceOf(PromptRefused);
	expect(refused?.message).toBe("acp agent card-a was stopped as it woke");
	expect((await recorded(first))["card-a"]?.stopped).toBe(true);
	expect(await second.port.list()).toEqual([]);
	expect(second.events.slice(from)).toEqual([]);
	// The stop landed before the wake spawned anything.
	expect(await spawned(second)).toEqual([]);
});

test("start refuses the name of a dormant agent, whose session goes on with a reply", async () => {
	const first = await ranThenEnded(["card-a"]);
	await first.end();
	const second = await harness({ cwd: first.cwd });
	await expect(second.start("card-a")).rejects.toThrow("acp holds a dormant agent named card-a");
	expect(await spawned(second)).toEqual([]);
});

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const request = (name = "card-a", sessionId = SESSION) => ({ name, card: name, sessionId });

/** A soma that ran a prompt planting KIWI in card-a and stopped it, as a reclaim does. */
async function ranThenStopped(options: Parameters<typeof harness>[0] = {}) {
	const acp = await harness(options);
	await acp.start();
	await acp.until("idle");
	const from = acp.events.length;
	await acp.port.prompt("card-a", "the word is KIWI");
	await acp.until("done", from);
	await acp.port.stop("card-a");
	return acp;
}

test("resume starts a stopped agent in its recorded session, clears its mark, and lists it idle, reporting nothing", async () => {
	const acp = await ranThenStopped();
	const { acpSessionId, cwd, stopped } = (await recorded(acp))["card-a"] ?? { acpSessionId: "", cwd: "" };
	expect(stopped).toBe(true);
	const [[, first] = ["", ""]] = await spawned(acp);
	while (alive(first)) await sleep(10);
	expect(await acp.port.list()).toEqual([]);

	const from = acp.events.length;
	await acp.port.resume(request());
	expect(await readFile(join(acp.cwd, "..", "projects", "loaded"), "utf8")).toBe(`${acpSessionId} ${cwd}\n`);
	expect((await recorded(acp))["card-a"]).toEqual({ card: "card-a", sessionId: SESSION, acpSessionId, cwd });
	expect(await acp.port.list()).toEqual([
		{ name: "card-a", sessionId: SESSION, status: { state: "idle" }, seq: expect.any(Number) },
	]);
	await sleep(150);
	expect(acp.events.slice(from)).toEqual([]);

	await acp.port.prompt("card-a", "RECALL");
	await acp.until("done", from);
	expect((await acp.port.readResult("card-a"))?.text).toBe("recall: the word is KIWI");
	expect((await spawned(acp)).map(([name]) => name)).toEqual(["card-a", "card-a"]);

	// Stopped again, it is marked again, and goes on from there again.
	await acp.port.stop("card-a");
	expect((await recorded(acp))["card-a"]?.stopped).toBe(true);
	const next = acp.events.length;
	await acp.port.resume(request());
	await acp.port.prompt("card-a", "RECALL");
	await acp.until("done", next);
	expect((await acp.port.readResult("card-a"))?.text).toBe("recall: the word is KIWI | RECALL");
});

test("across a restart a stopped agent is not dormant, runs nothing, reads its result, and resumes in its session", async () => {
	const first = await ranThenStopped();
	await first.end();

	const second = await harness({ cwd: first.cwd });
	expect(await second.port.dormant()).toEqual([]);
	expect(await second.port.list()).toEqual([]);
	expect(await spawned(second)).toEqual([]);
	expect(await second.port.readResult("card-a")).toEqual({ id: expect.any(String), text: "echo: the word is KIWI" });
	await expect(second.port.prompt("card-a", "hi")).rejects.toThrow(PromptRefused);

	await second.port.resume(request());
	expect((await second.port.list()).map(({ name, status }) => ({ name, status }))).toEqual([
		{ name: "card-a", status: { state: "idle" } },
	]);
	const from = second.events.length;
	await second.port.prompt("card-a", "RECALL");
	await second.until("done", from);
	expect((await second.port.readResult("card-a"))?.text).toBe("recall: the word is KIWI");
	expect((await recorded(second))["card-a"]?.stopped).toBeUndefined();
	await second.end();

	// Its mark gone, the next soma takes it for any agent it did not stop.
	const third = await harness({ cwd: first.cwd });
	expect(await third.port.dormant()).toEqual(["card-a"]);
});

test("resume is not held to the hangar cap, and the agent it starts counts against it", async () => {
	const acp = await ranThenStopped({ cap: 1 });
	// While it is being started it holds the slot already.
	const [, late] = await Promise.allSettled([acp.port.resume(request()), acp.start("card-b")]);
	expect(late).toMatchObject({ reason: { message: "hangar is full: 1 of 1 agents running" } });
	await acp.port.stop("card-a");

	await acp.start("card-b");
	await acp.until("idle", 0, "card-b");
	await expect(acp.start("card-c")).rejects.toThrow("hangar is full: 1 of 1 agents running");
	await acp.port.resume(request());
	await expect(acp.start("card-c")).rejects.toThrow("hangar is full: 2 of 1 agents running");
	expect((await acp.port.list()).map(({ name }) => name).sort()).toEqual(["card-a", "card-b"]);
});

test("resume refuses a name already listed, running, dormant or being resumed, and start one being resumed", async () => {
	const running = await harness();
	await running.start();
	await running.until("idle");
	await expect(running.port.resume(request())).rejects.toThrow("acp already lists an agent named card-a");
	expect(await spawned(running)).toHaveLength(1);

	const first = await ranThenEnded(["card-a"]);
	await first.end();
	const second = await harness({ cwd: first.cwd });
	await expect(second.port.resume(request())).rejects.toThrow("acp already lists an agent named card-a");
	expect(await spawned(second)).toEqual([]);

	const stopped = await ranThenStopped();
	const [one, two, three] = await Promise.allSettled([
		stopped.port.resume(request()),
		stopped.port.resume(request()),
		stopped.start(),
	]);
	expect(one.status).toBe("fulfilled");
	expect(two).toMatchObject({ reason: { message: "acp already lists an agent named card-a" } });
	expect(three).toMatchObject({ reason: { message: "acp is starting an agent named card-a again" } });
	expect((await spawned(stopped)).map(([name]) => name)).toEqual(["card-a", "card-a"]);
});

test("resume throws NotImplemented, having done nothing, for an agent with no recorded session or no transcript", async () => {
	const acp = await ranThenStopped();
	const before = await readFile(acp.sessionsFile, "utf8");
	const count = (await spawned(acp)).length;
	await expect(acp.port.resume(request("card-z"))).rejects.toThrow(NotImplemented);
	await expect(acp.port.resume(request("card-a", "another-session"))).rejects.toThrow(NotImplemented);
	const { acpSessionId, cwd } = (await recorded(acp))["card-a"] ?? { acpSessionId: "", cwd: "" };
	const projects = join(acp.cwd, "..", "projects");
	await rm(join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${acpSessionId}.jsonl`));
	await expect(acp.port.resume(request())).rejects.toThrow(NotImplemented);
	expect(await spawned(acp)).toHaveLength(count);
	expect(await readFile(acp.sessionsFile, "utf8")).toBe(before);
	expect(await acp.port.list()).toEqual([]);
});

test("a session/load that fails makes resume throw why, with no NotImplemented, and leaves the agent stopped with no process", async () => {
	const refusals: Record<string, string>[] = [{ FAKE_ACP_LOAD_AUTH: "card-a" }, { FAKE_ACP_LOAD_EXIT: "card-a" }];
	for (const fake of refusals) {
		const acp = await ranThenStopped({ fake });
		const before = await readFile(acp.sessionsFile, "utf8");
		const from = acp.events.length;
		const failure = await acp.port.resume(request()).catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(NotImplemented);
		expect((failure as Error).message).toMatch(/^session\/load of ACP session .* failed: /);
		expect(await acp.port.list()).toEqual([]);
		expect(await readFile(acp.sessionsFile, "utf8")).toBe(before);
		expect(acp.events.slice(from)).toEqual([]);
		const pids = await spawned(acp);
		expect(pids).toHaveLength(2);
		for (const [, pid] of pids) while (alive(pid)) await sleep(10);
		// The name is free: a resume that failed holds nothing.
		await expect(acp.port.resume(request())).rejects.toThrow(/^session\/load of ACP session/);
	}
});

test("resume of an agent whose worktree is gone throws that, with no process started", async () => {
	const acp = await ranThenStopped();
	const { cwd } = (await recorded(acp))["card-a"] ?? { cwd: "" };
	await rm(cwd, { recursive: true, force: true });
	const failure = await acp.port.resume(request()).catch((error: Error) => error);
	expect(failure).not.toBeInstanceOf(NotImplemented);
	expect((failure as Error).message).toBe(`the worktree ${cwd} of agent card-a is gone`);
	expect(await spawned(acp)).toHaveLength(1);
	expect((await recorded(acp))["card-a"]?.stopped).toBe(true);
});

test("release closes the session, returns once the process is gone, and marks the handover in progress, keeping what the other side needs", async () => {
	const acp = await harness();
	await acp.start();
	const from = acp.events.length;
	await acp.until("idle");
	await acp.port.prompt("card-a", "hello");
	await acp.until("done", from);
	const { [acp.instance]: _none, ...sessions } = JSON.parse(await readFile(acp.sessionsFile, "utf8"));
	const { acpSessionId, cwd } = sessions["card-a"];
	const [pid] = (await readFile(join(acp.cwd, "..", `pids-${acp.instance}`), "utf8")).trim().split("\n");

	const held = { name: "card-a", card: "card-a", sessionId: SESSION, claudeSession: acpSessionId, cwd };
	expect(await acp.port.releasable("card-a")).toEqual(held);
	expect(await acp.port.release("card-a", MARK)).toEqual(held);

	expect(() => process.kill(Number(pid?.split(" ")[1]), 0)).toThrow();
	expect(await readFile(join(acp.cwd, "..", "projects", "closed"), "utf8")).toBe(`${acpSessionId}\n`);
	expect(JSON.parse(await readFile(acp.sessionsFile, "utf8"))["card-a"]).toEqual({
		card: "card-a",
		sessionId: SESSION,
		acpSessionId,
		cwd,
		handingOver: true,
		hangar: MARK.hangar,
		handingOverAt: MARK.at,
	});
	expect(await acp.port.handingOver()).toEqual([{ ...held, ...MARK }]);
	expect(await acp.port.released()).toEqual([]);
	// Its exit is no failure anyone is told of.
	await sleep(50);
	expect(acp.events.filter((event) => event.status.state === "error")).toEqual([]);
});

test("the ACP side never lists, wakes, resumes or starts again an agent it released, this soma or the next", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	const from = acp.events.length;
	await acp.port.prompt("card-a", "hello");
	await acp.until("done", from);
	const held = await acp.port.release("card-a", MARK);

	const after = await harness({ cwd: acp.cwd });
	for (const port of [acp.port, after.port]) {
		expect(await port.list()).toEqual([]);
		await expect(port.prompt("card-a", "RECALL")).rejects.toThrow(PromptRefused);
		await expect(port.resume({ name: "card-a", card: "card-a", sessionId: SESSION })).rejects.toThrow(NotImplemented);
		await expect(port.start({ name: "card-a", card: "card-a", cwd: acp.cwd, sessionId: SESSION })).rejects.toThrow(
			"handed over",
		);
		expect(await port.releasable("card-a")).toMatchObject({ refusal: "not_acp" });
	}
	expect(await after.port.dormant()).toEqual([]);
	expect(await after.port.handingOver()).toEqual([{ ...(held as object), ...MARK }]);
	expect(after.errors).toEqual([]);
	expect(await readFile(join(acp.cwd, "..", `pids-${after.instance}`), "utf8").catch(() => "")).toBe("");
});

test("release gives up a dormant agent with no process, and refuses, with nothing done, what is not at rest or not its own", async () => {
	const first = await harness();
	await first.start();
	await first.until("idle");
	let from = first.events.length;
	await first.port.prompt("card-a", "hello");
	await first.until("done", from);
	await first.end();

	const acp = await harness({ cwd: first.cwd });
	expect(await acp.port.dormant()).toEqual(["card-a"]);
	expect(await acp.port.release("card-a", MARK)).toMatchObject({ name: "card-a" });
	expect(await acp.port.list()).toEqual([]);
	expect(await readFile(join(acp.cwd, "..", `pids-${acp.instance}`), "utf8").catch(() => "")).toBe("");

	expect(await acp.port.release("nobody", MARK)).toMatchObject({ refusal: "not_acp" });

	await acp.start("card-b");
	await acp.until("idle", 0, "card-b");
	from = acp.events.length;
	await acp.port.prompt("card-b", "ASK");
	await acp.until("blocked", from, "card-b");
	expect(await acp.port.releasable("card-b")).toMatchObject({ name: "card-b" });
	expect(await acp.port.release("card-b", MARK)).toMatchObject({ refusal: "not_at_rest", reason: /is blocked/ });
	expect((await acp.port.list()).map(({ name }) => name)).toEqual(["card-b"]);

	await acp.start("card-c");
	await acp.until("idle", 0, "card-c");
	from = acp.events.length;
	await acp.port.prompt("card-c", "HANG");
	await acp.until("working", from, "card-c");
	expect(await acp.port.release("card-c", MARK)).toMatchObject({ refusal: "not_at_rest", reason: /is working/ });

	await acp.start("card-d");
	await acp.until("idle", 0, "card-d");
	await acp.port.stop("card-d");
	expect(await acp.port.releasable("card-d")).toMatchObject({ refusal: "not_at_rest", reason: /is not running/ });

	expect(JSON.parse(await readFile(acp.sessionsFile, "utf8"))["card-b"].handedOver).toBeUndefined();
});

test("an agent whose session is not open yet is not released, though a start before it left an entry", async () => {
	const acp = await harness({ fake: { FAKE_ACP_NEW_MS: "200" } });
	await acp.start();
	expect(await acp.port.releasable("card-a")).toMatchObject({ refusal: "not_at_rest", reason: /no session yet/ });
	await acp.until("idle");
	await acp.port.stop("card-a");

	const from = acp.events.length;
	await acp.start();
	expect(await acp.port.releasable("card-a")).toMatchObject({ refusal: "not_at_rest", reason: /no session yet/ });
	await acp.until("idle", from);
});

test("a prompt under way as the agent is released opens no turn on the session being closed", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	const from = acp.events.length;
	await acp.port.prompt("card-a", "first");
	await acp.until("done", from);

	const prompted = acp.port.prompt("card-a", "second");
	const released = acp.port.release("card-a", MARK);

	await expect(prompted).rejects.toThrow(PromptRefused);
	await released;
	expect(await acp.port.readResult("card-a")).toMatchObject({ text: "echo: first" });
});

test("a mark that does not reach the file refuses the release: the agent stays, its process running, and its entry unmarked", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	let from = acp.events.length;
	await acp.port.prompt("card-a", "the word is KIWI");
	await acp.until("done", from);
	const [pid] = (await readFile(join(acp.cwd, "..", `pids-${acp.instance}`), "utf8")).trim().split("\n");
	// A directory where the write puts its temp file, which fails whoever the tests run as.
	await mkdir(`${acp.sessionsFile}.tmp`);

	expect(await acp.port.release("card-a", MARK)).toEqual({
		refusal: "cannot_resume",
		reason: expect.stringMatching(/^card-a stays on ACP: .*could not be recorded in .*acp-sessions\.json: /),
	});

	expect(() => process.kill(Number(pid?.split(" ")[1]), 0)).not.toThrow();
	expect(await readFile(join(acp.cwd, "..", "projects", "closed"), "utf8").catch(() => "")).toBe("");
	expect(JSON.parse(await readFile(acp.sessionsFile, "utf8"))["card-a"].handedOver).toBeUndefined();
	expect(await acp.port.released()).toEqual([]);
	expect((await acp.port.list()).map(({ name }) => name)).toEqual(["card-a"]);
	from = acp.events.length;
	await acp.port.prompt("card-a", "RECALL");
	await acp.until("done", from);
	expect((await acp.port.readResult("card-a"))?.text).toBe("recall: the word is KIWI");

	// Once the file takes writes again, the same agent goes.
	await rmdir(`${acp.sessionsFile}.tmp`);
	expect(await acp.port.release("card-a", MARK)).toMatchObject({ name: "card-a" });
	expect(JSON.parse(await readFile(acp.sessionsFile, "utf8"))["card-a"].handingOver).toBe(true);
});

test("a mark that does not reach the file leaves a dormant agent dormant, and its next prompt wakes it", async () => {
	const first = await harness();
	await first.start();
	await first.until("idle");
	await first.port.prompt("card-a", "the word is KIWI");
	await first.until("done");
	await first.end();
	const acp = await harness({ cwd: first.cwd });
	expect(await acp.port.dormant()).toEqual(["card-a"]);
	await mkdir(`${acp.sessionsFile}.tmp`);

	expect(await acp.port.release("card-a", MARK)).toMatchObject({ refusal: "cannot_resume" });

	expect(await acp.port.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
	expect(await acp.port.released()).toEqual([]);
	const from = acp.events.length;
	await acp.port.prompt("card-a", "RECALL");
	await acp.until("done", from);
	expect((await acp.port.readResult("card-a"))?.text).toBe("recall: the word is KIWI");
	await rmdir(`${acp.sessionsFile}.tmp`);
});

test("any other write of the sessions file that fails is logged, and the agent goes on", async () => {
	const acp = await harness();
	await mkdir(`${acp.sessionsFile}.tmp`);
	await acp.start();
	await acp.until("idle");

	expect(acp.errors.map((error) => error.message)).toEqual([expect.stringContaining("acp sessions file")]);
	const from = acp.events.length;
	await acp.port.prompt("card-a", "hello");
	await acp.until("done", from);
	await rmdir(`${acp.sessionsFile}.tmp`);
});

test("a process that lives through the end of its session and SIGTERM is killed before release returns", async () => {
	const acp = await harness({ fake: { FAKE_ACP_IGNORE_TERM: "1" }, closeMs: 100 });
	await acp.start();
	await acp.until("idle");
	const from = acp.events.length;
	await acp.port.prompt("card-a", "hello");
	await acp.until("done", from);
	const line = (await readFile(join(acp.cwd, "..", `pids-${acp.instance}`), "utf8")).trim();
	const pid = Number(line.split(" ")[1]);
	const living = () => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};

	try {
		expect(await acp.port.release("card-a", MARK)).toMatchObject({ name: "card-a" });
		expect(living()).toBe(false);
	} finally {
		if (living()) process.kill(pid, "SIGKILL");
	}
});

test("a dormant agent waking for a prompt is not released, and the prompt goes on over ACP", async () => {
	const first = await harness();
	await first.start();
	await first.until("idle");
	await first.port.prompt("card-a", "the word is KIWI");
	await first.until("done");
	await first.end();
	const acp = await harness({ cwd: first.cwd, fake: { FAKE_ACP_LOAD_MS: "300" } });
	await acp.port.dormant();

	const prompting = acp.port.prompt("card-a", "RECALL");
	await sleep(50);

	const refusal = { refusal: "not_at_rest", reason: "card-a is waking for a prompt" };
	expect(await acp.port.releasable("card-a")).toEqual(refusal);
	expect(await acp.port.release("card-a", MARK)).toEqual(refusal);
	expect(await acp.port.released()).toEqual([]);

	await prompting;
	await acp.until("done");
	expect((await acp.port.readResult("card-a"))?.text).toBe("recall: the word is KIWI");
	expect(JSON.parse(await readFile(acp.sessionsFile, "utf8"))["card-a"].handedOver).toBeUndefined();
});

test("reinstate takes a released agent back: dormant, its mark off, and the next prompt goes on in its session", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	let from = acp.events.length;
	await acp.port.prompt("card-a", "the word is KIWI");
	await acp.until("done", from);
	await acp.port.release("card-a", MARK);

	await acp.port.reinstate("card-a");

	expect(await acp.port.released()).toEqual([]);
	expect(await acp.port.handingOver()).toEqual([]);
	const entry = JSON.parse(await readFile(acp.sessionsFile, "utf8"))["card-a"];
	expect(entry.handedOver).toBeUndefined();
	expect(entry.handingOver).toBeUndefined();
	expect(await acp.port.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
	from = acp.events.length;
	await acp.port.prompt("card-a", "RECALL");
	await acp.until("done", from);
	expect((await acp.port.readResult("card-a"))?.text).toBe("recall: the word is KIWI");
});

test("confirm makes a handover in progress final, here and for the next soma, and reinstate cannot undo it", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	const from = acp.events.length;
	await acp.port.prompt("card-a", "the word is KIWI");
	await acp.until("done", from);
	const held = await acp.port.release("card-a", MARK);

	await acp.port.confirm("card-a");

	const entry = JSON.parse(await readFile(acp.sessionsFile, "utf8"))["card-a"];
	expect(entry.handedOver).toBe(true);
	expect(entry.handingOver).toBeUndefined();
	expect(await acp.port.released()).toEqual([held]);
	expect(await acp.port.handingOver()).toEqual([]);

	await acp.port.reinstate("card-a");
	expect(await acp.port.released()).toEqual([held]);
	expect(await acp.port.list()).toEqual([]);

	const after = await harness({ cwd: acp.cwd });
	expect(await after.port.released()).toEqual([held]);
	expect(await after.port.handingOver()).toEqual([]);
	expect(await after.port.dormant()).toEqual([]);
});

test("the mark's hangar and time come off with the mark, whichever way it ends, and a mark from before them records neither", async () => {
	const acp = await harness();
	await acp.start();
	const from = acp.events.length;
	await acp.until("idle");
	await acp.port.prompt("card-a", "the word is KIWI");
	await acp.until("done", from);
	const entry = async () => JSON.parse(await readFile(acp.sessionsFile, "utf8"))["card-a"];
	await acp.port.release("card-a", MARK);
	const marked = await entry();
	expect(marked).toMatchObject({ hangar: MARK.hangar, handingOverAt: MARK.at });

	await acp.port.markedAt("card-a", 2_000);
	expect((await entry()).handingOverAt).toBe(2_000);
	expect(await acp.port.handingOver()).toMatchObject([{ at: 2_000 }]);

	await acp.port.reinstate("card-a");
	expect((await entry()).hangar).toBeUndefined();
	expect((await entry()).handingOverAt).toBeUndefined();
	await acp.port.markedAt("card-a", 3_000);
	expect((await entry()).handingOverAt).toBeUndefined();

	const { hangar: _hangar, handingOverAt: _at, ...old } = marked;
	await writeFile(acp.sessionsFile, `${JSON.stringify({ "card-a": old })}\n`);
	const after = await harness({ cwd: acp.cwd });
	const [left] = await after.port.handingOver();
	expect(left).not.toHaveProperty("hangar");
	expect(left).not.toHaveProperty("at");
});

test("confirm of an agent with no handover in progress does nothing", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	const from = acp.events.length;
	await acp.port.prompt("card-a", "the word is KIWI");
	await acp.until("done", from);

	await acp.port.confirm("card-a");
	await acp.port.confirm("nobody");

	expect(await acp.port.released()).toEqual([]);
	expect(JSON.parse(await readFile(acp.sessionsFile, "utf8"))["card-a"].handedOver).toBeUndefined();
	expect((await acp.port.list()).map(({ name }) => name)).toEqual(["card-a"]);
});

test("a write of the final mark or of its removal that fails is logged, and leaves the handover in progress on disk", async () => {
	const acp = await harness();
	await acp.start();
	await acp.until("idle");
	const from = acp.events.length;
	await acp.port.prompt("card-a", "the word is KIWI");
	await acp.until("done", from);
	const entry = async () => JSON.parse(await readFile(acp.sessionsFile, "utf8"))["card-a"];

	const held = await acp.port.release("card-a", MARK);
	await mkdir(`${acp.sessionsFile}.tmp`);
	await acp.port.confirm("card-a");
	expect(acp.errors.at(-1)?.message).toContain("acp sessions file");
	expect(await entry()).toMatchObject({ handingOver: true });
	expect((await entry()).handedOver).toBeUndefined();
	expect(await acp.port.released()).toEqual([held]);

	const restarted = await harness({ cwd: acp.cwd });
	expect(await restarted.port.handingOver()).toEqual([{ ...(held as object), ...MARK }]);
	await rmdir(`${acp.sessionsFile}.tmp`);
	await restarted.port.handingOver();
	await mkdir(`${acp.sessionsFile}.tmp`);
	await restarted.port.reinstate("card-a");
	expect(restarted.errors.at(-1)?.message).toContain("acp sessions file");
	expect(await entry()).toMatchObject({ handingOver: true });
	expect(await restarted.port.list()).toEqual([{ name: "card-a", sessionId: SESSION }]);
	await rmdir(`${acp.sessionsFile}.tmp`);
});
