import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { DeferUnreachable } from "../src/adapters/defer-socket/index.ts";
import { parseDispatchArgs, runDispatch } from "../src/dispatch-cli.ts";
import type { DispatchReply, DispatchRequest } from "../src/ports/dispatch.ts";

const dir = mkdtempSync(join(tmpdir(), "soma-dispatch-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const config = join(dir, "dev.json");
writeFileSync(config, JSON.stringify({ db: "/data/dev.sqlite", reposDir: "/Users/me/workspace" }));
const ENV = { SOMA_CONFIG: config };
const REPO = "/Users/me/workspace/soma";
const STARTED: DispatchReply = {
	dispatched: true,
	how: "started",
	card: "card-a",
	agent: "card-a",
	sessionId: "s-1",
	repo: REPO,
	state: "idle",
};

async function cli(args: string[], reply: DispatchReply | Error = STARTED, env: Record<string, string> = ENV) {
	const out: string[] = [];
	const err: string[] = [];
	const sent: { path: string; request: DispatchRequest }[] = [];
	const status = await runDispatch(
		args,
		env,
		{ out: (line) => out.push(line), err: (line) => err.push(line) },
		{
			cwd: "/Users/me/workspace/soma/src",
			home: "/Users/me",
			send: async (path, request) => {
				sent.push({ path, request });
				if (reply instanceof Error) throw reply;
				return reply;
			},
		},
	);
	return { status, out, err, sent };
}

test("the arguments: --repo in either form and one card", () => {
	expect(parseDispatchArgs(["--repo", REPO, "card-a"])).toEqual({ repo: REPO, card: "card-a" });
	expect(parseDispatchArgs(["card-a", `--repo=${REPO}`])).toEqual({ repo: REPO, card: "card-a" });
	expect(parseDispatchArgs(["card-a"])).toEqual({ error: "--repo is missing" });
	expect(parseDispatchArgs(["card-a", "--repo"])).toEqual({ error: "--repo needs a value" });
	expect(parseDispatchArgs(["--repo", REPO])).toEqual({ error: "the card is missing" });
	expect(parseDispatchArgs(["--repo", REPO, "card-a", "card-b"])).toEqual({ error: "one card at a time" });
	expect(parseDispatchArgs(["--repo", REPO, "--force", "card-a"])).toEqual({ error: "unknown option --force" });
});

test("a started job is printed on stdout with exit 0, sent to the socket soma's config names", async () => {
	const run = await cli(["--repo", REPO, "card-a"]);

	expect(run).toEqual({
		status: 0,
		out: [
			`soma dispatch: started agent card-a for card card-a in ${REPO}, session s-1; soma sends it the card's launch prompt once it is ready.`,
		],
		err: [],
		sent: [{ path: "/data/dev.sqlite.defer.sock", request: { repo: REPO, card: "card-a" } }],
	});
});

test("a relative repo is taken from the directory the command runs in", async () => {
	const run = await cli(["--repo", "..", "card-a"]);

	expect(run.sent).toEqual([{ path: "/data/dev.sqlite.defer.sock", request: { repo: REPO, card: "card-a" } }]);
});

test("SOMA_SOCKET is not consulted: soma is found by its config, as for any human caller", async () => {
	const run = await cli(["--repo", REPO, "card-a"], STARTED, { ...ENV, SOMA_SOCKET: "/run/other.sock" });

	expect(run.sent).toEqual([{ path: "/data/dev.sqlite.defer.sock", request: { repo: REPO, card: "card-a" } }]);
});

test("in the shell of an agent soma dispatched, nothing is sent and the refusal names the card", async () => {
	const run = await cli(["--repo", REPO, "card-a"], STARTED, {
		...ENV,
		SOMA_AGENT: "card-b",
		SOMA_SOCKET: "/run/s.sock",
	});

	expect(run).toEqual({
		status: 1,
		out: [],
		err: ["soma dispatch: not dispatched: an agent soma dispatched cannot start jobs (SOMA_AGENT=card-b)"],
		sent: [],
	});
});

test("an agent is refused before the arguments are read or the config is, and a blank SOMA_AGENT is no agent", async () => {
	const broken = join(dir, "broken-agent.json");
	writeFileSync(broken, "{");

	const agent = await cli(["card-a"], STARTED, { SOMA_CONFIG: broken, SOMA_AGENT: "card-b" });
	expect([agent.status, agent.err, agent.sent]).toEqual([
		1,
		["soma dispatch: not dispatched: an agent soma dispatched cannot start jobs (SOMA_AGENT=card-b)"],
		[],
	]);

	const blank = await cli(["--repo", REPO, "card-a"], STARTED, { ...ENV, SOMA_AGENT: "  " });
	expect([blank.status, blank.err]).toEqual([0, []]);
	expect(blank.sent).toEqual([{ path: "/data/dev.sqlite.defer.sock", request: { repo: REPO, card: "card-a" } }]);
});

test("a card that has a job, or whose agent was running, says so and exits 0", async () => {
	const existing = await cli(["--repo", REPO, "card-a"], { ...STARTED, how: "existing", state: "working" });
	expect([existing.status, existing.out]).toEqual([
		0,
		[
			`soma dispatch: card card-a already has a job: agent card-a, working, in ${REPO}, session s-1; nothing was started.`,
		],
	]);

	const found = await cli(["--repo", REPO, "card-a"], { ...STARTED, how: "found" });
	expect([found.status, found.out]).toEqual([
		0,
		[
			`soma dispatch: agent card-a was already running, so none was started; soma recorded it as the job of card card-a in ${REPO}, session s-1.`,
		],
	]);
});

test("soma's refusal is printed on stderr with exit 1", async () => {
	const reason = "/Users/me/elsewhere/soma is not directly under /Users/me/workspace";
	const run = await cli(["--repo", "/Users/me/elsewhere/soma", "card-a"], { dispatched: false, reason });

	expect([run.status, run.out, run.err]).toEqual([1, [], [`soma dispatch: not dispatched: ${reason}`]]);
});

test("a usage error prints the usage with exit 2 and asks soma nothing", async () => {
	const run = await cli(["card-a"]);

	expect(run.status).toBe(2);
	expect(run.err).toEqual([
		"soma dispatch: --repo is missing\nusage: soma dispatch --repo <git repo directly under reposDir> <card>",
	]);
	expect(run.sent).toEqual([]);
});

test("a config soma cannot read is refused before soma is asked", async () => {
	const broken = join(dir, "broken.json");
	writeFileSync(broken, "{");

	const run = await cli(["--repo", REPO, "card-a"], STARTED, { SOMA_CONFIG: broken });

	expect(run.status).toBe(1);
	expect(run.err).toEqual([expect.stringMatching(new RegExp(`^soma dispatch: ${broken}: not valid JSON`))]);
	expect(run.sent).toEqual([]);
});

test("with soma down nothing is dispatched; with the reply lost the outcome is unknown and a rerun is safe", async () => {
	const down = await cli(
		["--repo", REPO, "card-a"],
		new DeferUnreachable("connect ENOENT /data/dev.sqlite.defer.sock"),
	);
	expect([down.status, down.err]).toEqual([
		1,
		[
			"soma dispatch: soma is not answering on /data/dev.sqlite.defer.sock (connect ENOENT /data/dev.sqlite.defer.sock); nothing was dispatched",
		],
	]);

	const lost = await cli(["--repo", REPO, "card-a"], new Error("socket hang up"));
	expect([lost.status, lost.err]).toEqual([
		1,
		[
			"soma dispatch: the request went out to /data/dev.sqlite.defer.sock but no reply came back (socket hang up); whether the agent started is unknown. Run the same command again once soma answers: it starts no second agent, and records one that started.",
		],
	]);
});
