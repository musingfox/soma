import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterAll, expect, test } from "vitest";
import { serveDrop } from "../src/adapters/defer-drop/index.ts";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { repoRootOf } from "../src/adapters/repos/root.ts";
import { Deferrals, deferExtension } from "../src/core/extensions/defer/index.ts";
import { dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";

// The real script, run with sh in a temporary directory: its environment is the test's alone, so no run of it ever
// reaches prod's drop directory, its default.
const SCRIPT = resolve(import.meta.dirname, "../agent-skills/soma-defer/register.sh");
const SESSION = "7e33597b-e33d-4c6d-a700-e21b2f54223e";
const root = realpathSync(mkdtempSync(join(tmpdir(), "soma-register-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const fresh = (make = true) => {
	const dir = join(root, `d${dirs++}`);
	if (make) mkdirSync(dir, { mode: 0o700 });
	return dir;
};
const work = join(root, "work");
mkdirSync(work);

type Run = { status: number | null; out: string };

/** Runs the script with `args` and `input` on its standard input; `whileRunning` sees the drop directory meanwhile. */
function run(
	env: Record<string, string>,
	args: readonly string[],
	input: string | Buffer,
	whileRunning?: () => void,
): Promise<Run> {
	return new Promise((done, fail) => {
		const child = spawn("sh", [SCRIPT, ...args], {
			cwd: work,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), ...env },
		});
		let out = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			out += chunk;
		});
		const poll = whileRunning && setInterval(whileRunning, 20);
		// A script that hangs is stopped before the test times out, rather than left running after it.
		const stop = setTimeout(() => child.kill("SIGKILL"), 4_000);
		child.once("error", fail);
		child.once("close", (status) => {
			clearInterval(poll);
			clearTimeout(stop);
			done({ status, out });
		});
		child.stdin.end(input);
	});
}

const requests = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".req"));

/** Answers the first request that appears in `dir` with `line`, as soma does: by a rename. */
const answering = (dir: string, line: string) => () => {
	const [request] = requests(dir);
	if (request === undefined) return;
	const name = request.slice(0, -".req".length);
	if (existsSync(join(dir, `${name}.reply`))) return;
	writeFileSync(join(dir, `${name}.reply.tmp`), line);
	renameSync(join(dir, `${name}.reply.tmp`), join(dir, `${name}.reply`));
	rmSync(join(dir, request));
};

test("the request holds the three headers and standard input byte for byte, with no .tmp left", async () => {
	const dir = fresh();
	const input = Buffer.from('say "it\'s $HOME" and `date`\n\n\n  tabs\tand $(pwd) é 漢字 🙂\n\\n no end', "utf8");

	const { status, out } = await run(
		{ CLAUDE_CODE_SESSION_ID: SESSION, SOMA_HANDOFF_DIR: dir, SOMA_HANDOFF_WAIT: "0" },
		["--at", "PT2M"],
		input,
	);

	expect(status).toBe(3);
	const [request, ...more] = readdirSync(dir);
	expect(more).toEqual([]);
	expect(request).toMatch(new RegExp(`^${SESSION}-\\d+-\\d+\\.req$`));
	const header = Buffer.from(`session: ${SESSION}\ncwd: ${work}\nat: PT2M\n\n`, "utf8");
	expect(readFileSync(join(dir, request ?? ""))).toEqual(Buffer.concat([header, input]));
	expect(out).toBe(
		`not confirmed: soma did not answer within 0 s. The request is kept at ${join(dir, request ?? "")}, and soma takes it when it runs, unless its time has passed by then. Do not register it again; delete that file to withdraw it.\n`,
	);
});

test("an accepted reply is printed as the accepted line, exits 0 and is removed", async () => {
	const dir = fresh();

	const { status, out } = await run(
		{ CLAUDE_CODE_SESSION_ID: SESSION, SOMA_HANDOFF_DIR: dir },
		["--at", "PT2M"],
		"reply with the word\n",
		answering(dir, "accepted 12 2026-11-23T10:02:00.000Z\n"),
	);

	expect(out).toBe(
		"accepted as 12; at 2026-11-23T10:02:00.000Z soma gives this session the instruction as a new prompt, resuming the session if it is closed. This session may be closed now.\n",
	);
	expect(status).toBe(0);
	expect(readdirSync(dir)).toEqual([]);
});

test("a refused reply is printed with its reason and exits 1", async () => {
	const dir = fresh();

	const { status, out } = await run(
		{ CLAUDE_CODE_SESSION_ID: SESSION, SOMA_HANDOFF_DIR: dir },
		["--at", "PT2M"],
		"x\n",
		answering(dir, "refused the instruction is empty\n"),
	);

	expect([status, out]).toEqual([1, "refused: the instruction is empty\n"]);
	expect(readdirSync(dir)).toEqual([]);
});

test("no reply within the wait exits 3 and leaves the request", async () => {
	const dir = fresh();
	const started = Date.now();

	const { status } = await run(
		{ CLAUDE_CODE_SESSION_ID: SESSION, SOMA_HANDOFF_DIR: dir, SOMA_HANDOFF_WAIT: "1" },
		["--at", "PT2M"],
		"x\n",
	);

	expect(status).toBe(3);
	expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
	expect(requests(dir)).toHaveLength(1);
});

test("no session id or no drop directory exits 1 and writes nothing; no --at exits 2", async () => {
	const dir = fresh();
	const missing = fresh(false);

	expect(await run({ SOMA_HANDOFF_DIR: dir }, ["--at", "PT2M"], "x\n")).toEqual({
		status: 1,
		out: "nothing was registered: CLAUDE_CODE_SESSION_ID is not set, so this is not the Bash of a Claude Code session\n",
	});
	expect(await run({ CLAUDE_CODE_SESSION_ID: SESSION, SOMA_HANDOFF_DIR: missing }, ["--at", "PT2M"], "x\n")).toEqual({
		status: 1,
		out: `nothing was registered: there is no drop directory at ${missing}, so no soma serves it\n`,
	});
	const usage = await run({ CLAUDE_CODE_SESSION_ID: SESSION, SOMA_HANDOFF_DIR: dir }, [], "x\n");
	expect(usage.status).toBe(2);
	expect(usage.out).toMatch(/^usage: sh register\.sh --at <when>/);
	for (const args of [["--at"], ["--at", "PT2M", "extra"], ["--at", "PT2M\nsession: x"]]) {
		expect((await run({ CLAUDE_CODE_SESSION_ID: SESSION, SOMA_HANDOFF_DIR: dir }, args, "x\n")).status).toBe(2);
	}
	expect(readdirSync(dir)).toEqual([]);
	expect(existsSync(missing)).toBe(false);
});

test("a request the script writes is accepted by the drop directory and soma's defer, and the script says so", async () => {
	const dir = fresh(false);
	const context = BACKGROUND_CONTEXT;
	const agents = new FakeAgentPort();
	const defers = deferExtension(agents, { repoRoot: repoRootOf });
	const harness = await openHarness(
		join(root, "soma.sqlite"),
		[dispatchExtension(agents, async () => ""), defers.extension],
		context,
	);
	const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	const server = await serveDrop({ dir, defer: (request) => defers.defer(conversation, request, context), scanMs: 50 });
	try {
		const { status, out } = await run(
			{ CLAUDE_CODE_SESSION_ID: SESSION, SOMA_HANDOFF_DIR: dir },
			["--at", "PT2M"],
			"reply with the word\n",
		);

		const items = Object.entries((await harness.snapshot(Deferrals, conversation.id, context))?.items ?? {});
		expect(items).toHaveLength(1);
		const [id, item] = items[0] ?? [];
		expect(out).toBe(
			`accepted as ${id}; at ${new Date(item?.at ?? 0).toISOString()} soma gives this session the instruction as a new prompt, resuming the session if it is closed. This session may be closed now.\n`,
		);
		expect(status).toBe(0);
		expect(item).toMatchObject({ session: SESSION, cwd: work, instruction: "reply with the word" });
		expect(item?.request).toMatch(new RegExp(`^${SESSION}-\\d+-\\d+$`));
		expect(readdirSync(dir)).toEqual([]);
	} finally {
		await server.close();
		await harness.close(context);
	}
});
