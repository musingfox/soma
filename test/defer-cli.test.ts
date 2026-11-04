import { expect, test } from "vitest";
import { DeferUnreachable } from "../src/adapters/defer-socket/index.ts";
import { parseDeferArgs, runDefer } from "../src/defer-cli.ts";
import type { DeferReply, DeferRequest } from "../src/ports/defer.ts";

const AGENT_ENV = { SOMA_AGENT: "card-a", SOMA_SOCKET: "/run/soma.sock" };

async function cli(args: string[], env: Record<string, string> = AGENT_ENV, reply?: DeferReply | Error) {
	const out: string[] = [];
	const err: string[] = [];
	const sent: DeferRequest[] = [];
	const status = await runDefer(
		args,
		env,
		{ out: (line) => out.push(line), err: (line) => err.push(line) },
		async (_path, request) => {
			sent.push(request);
			if (reply instanceof Error) throw reply;
			return reply ?? { accepted: true, id: "9", at: "2026-11-04T10:02:00.000Z" };
		},
	);
	return { status, out, err, sent };
}

test("the arguments: --at in either form, and the remaining words as the instruction", () => {
	expect(parseDeferArgs(["--at", "PT2M", "run the tests"])).toEqual({ at: "PT2M", instruction: "run the tests" });
	expect(parseDeferArgs(["--at=PT2M", "run", "the", "tests"])).toEqual({ at: "PT2M", instruction: "run the tests" });
	expect(parseDeferArgs(["run", "--at", "PT2M", "--", "--verbose"])).toEqual({
		at: "PT2M",
		instruction: "run --verbose",
	});
	expect(parseDeferArgs(["run the tests"])).toEqual({ error: "--at is missing" });
	expect(parseDeferArgs(["run", "--at"])).toEqual({ error: "--at needs a value" });
	expect(parseDeferArgs(["--at", "PT2M", " "])).toEqual({ error: "the instruction is missing" });
	expect(parseDeferArgs(["--in", "PT2M", "x"])).toEqual({ error: "unknown option --in" });
});

test("an accepted defer prints its id and time on stdout and exits 0", async () => {
	const run = await cli(["--at", "PT2M", "run the tests"]);

	expect(run).toEqual({
		status: 0,
		out: [
			"soma defer: accepted as 9; soma will send this instruction to agent card-a as a new prompt at 2026-11-04T10:02:00.000Z. You can end your turn now.",
		],
		err: [],
		sent: [{ agent: "card-a", at: "PT2M", instruction: "run the tests" }],
	});
});

test("a missing or malformed --at is refused with the usage, before soma is asked", async () => {
	for (const args of [["run the tests"], ["--at", "tomorrow", "run the tests"], ["--at", "2026-11-04T10:00", "x"]]) {
		const run = await cli(args);
		expect(run.status).toBe(2);
		expect(run.err[0]).toMatch(/^soma defer: (--at is missing|--at must be an ISO 8601 date-time with an offset)/);
		expect(run.err[0]).toMatch(/\nusage: soma defer --at /);
		expect(run.sent).toEqual([]);
	}
});

test("soma's refusal is printed on stderr for the agent, with exit 1", async () => {
	const reason =
		'soma dispatched no agent for card "card-a" (SOMA_AGENT); it defers instructions only for agents it dispatched';
	const run = await cli(["--at", "PT2M", "x"], AGENT_ENV, { accepted: false, reason });

	expect([run.status, run.out, run.err]).toEqual([1, [], [`soma defer: refused: ${reason}`]]);
});

test("outside a dispatched agent's shell, or with soma down, nothing is deferred and the agent is told why", async () => {
	const bare = await cli(["--at", "PT2M", "x"], {});
	expect([bare.status, bare.err, bare.sent]).toEqual([
		1,
		["soma defer: SOMA_AGENT is not set: soma defer works only in the shell of an agent soma dispatched"],
		[],
	]);

	const down = await cli(["--at", "PT2M", "x"], AGENT_ENV, new DeferUnreachable("connect ENOENT /run/soma.sock"));
	expect([down.status, down.err]).toEqual([
		1,
		["soma defer: soma is not answering on /run/soma.sock (connect ENOENT /run/soma.sock); nothing was deferred"],
	]);
});
