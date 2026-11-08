import { readFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type AgentStatusEvent, NotImplemented, PromptRefused } from "../../../src/ports/agent.ts";
import { cleanUp, git, harness, SESSION, sleep } from "./fake.ts";

afterEach(cleanUp);

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
	expect(states(acp.events, from)).toEqual(["working", "done"]);
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
			/^configuration error: claude-agent-acp refused session\/new with -32000 Authentication required, so this job has no session: it takes no reply.*HOME=\/home\/someone and USER=someone\..*does not survive a restart yet\.$/,
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

test("resume is not implemented yet, and there are no foreign agents", async () => {
	const acp = await harness();
	await expect(acp.port.resume({ name: "card-a", card: "card-a", sessionId: SESSION })).rejects.toThrow(NotImplemented);
	expect(await acp.port.listForeign()).toEqual([]);
	await expect(acp.port.promptForeign("x", "hi")).rejects.toThrow(PromptRefused);
});
