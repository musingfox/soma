// ACP dispatch smoke, against the real claude-agent-acp and real claude on haiku:
//   1. a throwaway git repo whose committed .claude/settings.json sets permissions.defaultMode "default", so the
//      agent asks before a Bash call whatever the user's own mode is;
//   2. the real core, with a faux model standing in for soma's, dispatches a card into it over ACP: the event bridge
//      sends the brief at the first idle, the agent asks to run `touch`, the bridge wakes the model, which answers
//      option 1 with respond, and the finished turn is recorded with its outcome;
//   3. readResult and screen read the job's reply and its transcript's tail, and reply sends it a second prompt;
//   4. a second agent, started without USER, has its prompt refused with -32000, reported as blocked kind=auth
//      naming HOME and USER.
// Two prompts run on haiku; the refused one costs nothing. It stops its agents and removes its repo, what claude keeps
// for the repo and its worktrees under ~/.claude/projects and its db at the end, also on failure.
//   node smoke/acp-dispatch.ts
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAcpAgentPort } from "../src/adapters/acp/agent-port.ts";
import { projectDirNameFor } from "../src/agent-cli/transcript.ts";
import { runGit } from "../src/agent-cli/worktree.ts";
import type { Job } from "../src/core/domain/dispatch.ts";
import { AGENT_BLOCKED, eventBridge, JOB_DONE } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import type { AgentPort, AgentStatusEvent } from "../src/ports/agent.ts";
import { delay } from "./driver.ts";

const context = BACKGROUND_CONTEXT;
const tag = Date.now().toString(36);
const card = `smoke-${tag}`;
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
	for (const deadline = Date.now() + ms; ; await delay(250)) {
		const value = await probe();
		if (value !== undefined) return value;
		check(Date.now() < deadline, `timed out waiting for ${what}`);
	}
}

const directory = await realpath(await mkdtemp(join(tmpdir(), "soma-acp-smoke-")));
const repo = join(directory, "repo");
const projects = join(homedir(), ".claude", "projects");
const worktrees: string[] = [];
const ports: { port: AgentPort; names: string[] }[] = [];
const git = (...args: string[]) => runGit(repo, args);
const identity = ["-c", "user.name=soma smoke", "-c", "user.email=smoke@example.com", "-c", "commit.gpgsign=false"];

await runGit(directory, ["init", "-q", "-b", "main", repo]);
await writeFile(join(repo, "README.md"), `# acp smoke ${tag}\n`);
await mkdir(join(repo, ".claude"));
await writeFile(
	join(repo, ".claude", "settings.json"),
	`${JSON.stringify({ permissions: { defaultMode: "default" } })}\n`,
);
await git("add", "README.md", ".claude/settings.json");
await git(...identity, "commit", "-q", "--no-verify", "-m", "chore: init");
const claudeJson = join(homedir(), ".claude.json");
// Read only: whether claude wrote an entry for the throwaway repo into ~/.claude.json, for the report.
const namesRepo = async () => existsSync(claudeJson) && (await readFile(claudeJson, "utf8")).includes(directory);
log("repo", { repo, claudeJsonNamesRepo: await namesRepo() });

const brief =
	`Run exactly this one Bash command, and nothing else: touch probe-${tag}.txt\n` +
	`Then end your turn with exactly two lines: 結果：完成, then PROBE-${tag}.`;
let harness: Awaited<ReturnType<typeof openHarness>> | undefined;
try {
	// The model and the env soma defer would need, as main.ts gives them; ANTHROPIC_MODEL picks the session's model.
	const vars = { ANTHROPIC_MODEL: "haiku", SOMA_SOCKET: join(directory, "defer.sock"), SOMA_NODE: process.execPath };
	const onError = (error: Error) => console.error(`[acp] ${error.message}`);
	const agents = createAcpAgentPort({
		env: process.env,
		vars,
		sessionsFile: join(directory, "acp-sessions.json"),
		onError,
	});
	ports.push({ port: agents, names: [card] });
	const statuses: AgentStatusEvent[] = [];
	agents.onStatus((event) => {
		statuses.push(event);
		const { state } = event.status;
		log("status", { agent: event.agent, state, ...(state === "blocked" ? { kind: event.status.kind } : {}) });
	});

	// soma's model: dispatches the card, answers a wake that offers a fingerprint with option 1, and replies on ask.
	const faux = fauxProvider();
	faux.setResponses(
		Array.from({ length: 12 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
			const last = request.messages.at(-1);
			if (last?.role === "toolResult") return fauxAssistantMessage("好。");
			const text = JSON.stringify(last?.content ?? "");
			const call = (name: string, args: Record<string, string>) =>
				fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
			const fingerprint = /fingerprint=([0-9a-f]{16})/.exec(text)?.[1];
			if (fingerprint !== undefined) {
				return call("respond", { card, option: "1", fingerprint, reason: "the smoke approves its own touch" });
			}
			if (text.includes("派工")) return call("dispatch", { card, repo });
			if (text.includes("回覆")) {
				return call("reply", {
					card,
					text: `Reply with exactly two lines and use no tool: 結果：完成, then PINEAPPLE-${tag}.`,
					reason: "the smoke's second prompt",
				});
			}
			return fauxAssistantMessage("好。");
		}),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	harness = await openHarness(
		join(directory, "soma.sqlite"),
		[dispatchExtension(agents, async () => `# ${card}\n\n${brief}`)],
		context,
		{ models },
	);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const off = eventBridge(root, agents, context).listen((error) => console.error("[bridge]", error));
	const job = async () =>
		(await harness?.snapshot(Dispatches, root.id, context))?.jobs.find((each) => each.card === card) as Job | undefined;
	const entries = async (kind: string) =>
		(await root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter((entry) => entry.kind === kind);
	const say = async (content: string) => {
		const submission = await root.submit({ type: "input", content, requestId: `smoke:${content}` }, context);
		check((await submission.wait(context)).status === "done", `the turn of "${content}" did not finish`);
	};

	const started = Date.now();
	await say("派工");
	const worktree = await realpath(join(repo, ".claude", "worktrees", card));
	worktrees.push(worktree);
	log("dispatch", { worktree, ms: Date.now() - started });

	const first = await until("the first turn to be recorded", 180_000, async () => {
		const done = await entries(JOB_DONE);
		return done.length > 0 ? done : undefined;
	});
	await root.waitForIdle(context);
	const recorded = await job();
	const wakes = await entries(AGENT_BLOCKED);
	const blocked = statuses.find((event) => event.status.state === "blocked");
	log("blocked", blocked?.status);
	log("decision", recorded?.decisions);
	log(
		"done",
		first.map((entry) => entry.data),
	);
	check(blocked?.status.state === "blocked" && blocked.status.kind === "permission", "no permission request came");
	check(wakes.length === 1, `the model was woken ${wakes.length} times`);
	check(recorded?.decisions.some((each) => each.action === "answered" && each.option === "1") ?? false, "no answer");
	check(existsSync(join(worktree, `probe-${tag}.txt`)), "the agent did not touch its probe file");
	const result = await agents.readResult(card);
	log("result", result);
	check(result?.text?.includes(`PROBE-${tag}`) ?? false, "the reply does not hold the probe word");
	check(recorded?.outcome === "完成", `the outcome is ${recorded?.outcome}`);
	const screen = await agents.readScreen(card);
	log("screen", screen.split("\n").slice(-12));
	check(screen.includes(`touch probe-${tag}.txt`), "the screen does not show the Bash call");
	const sessions = JSON.parse(await readFile(join(directory, "acp-sessions.json"), "utf8"));
	log("session", sessions[card]);
	const transcript = join(projects, projectDirNameFor(worktree), `${sessions[card].acpSessionId}.jsonl`);
	check(existsSync(transcript), `no transcript at ${transcript}`);
	log("transcript", transcript);

	await say("回覆");
	const second = await until("the reply's turn to be recorded", 120_000, async () => {
		const done = await entries(JOB_DONE);
		return done.length > 1 ? done : undefined;
	});
	await root.waitForIdle(context);
	const replied = await agents.readResult(card);
	log("reply", { result: replied, done: second.at(-1)?.data });
	check(replied?.text?.includes(`PINEAPPLE-${tag}`) ?? false, "the reply's turn does not hold its word");
	off();

	// No USER: initialize and session/new go through, and only the prompt is refused.
	const { USER: _user, ...withoutUser } = process.env;
	const refused = createAcpAgentPort({ env: withoutUser, vars, onError });
	const auth = `${card}-auth`;
	ports.push({ port: refused, names: [auth] });
	const seen: AgentStatusEvent[] = [];
	refused.onStatus((event) => seen.push(event));
	await refused.start({ name: auth, card: auth, cwd: repo, sessionId: randomUUID() });
	worktrees.push(await realpath(join(repo, ".claude", "worktrees", auth)));
	await until("the auth agent's idle", 60_000, async () => seen.find((event) => event.status.state === "idle"));
	await refused.prompt(auth, "say hi");
	const failed = await until("the auth agent's refusal", 60_000, async () =>
		seen.find((event) => event.status.state === "blocked" || event.status.state === "error"),
	);
	log("auth", failed.status);
	check(failed.status.state === "blocked" && failed.status.kind === "auth", "the refusal is not blocked kind=auth");
	check(/HOME=\S+ and USER=unset/.test(failed.status.msg ?? ""), "the refusal does not name HOME and USER");

	log("trust", { claudeJsonNamesRepo: await namesRepo() });
	console.log("PASS");
} finally {
	for (const { port, names } of ports) {
		for (const name of names)
			await port.stop(name).catch((error: Error) => console.error(`stop ${name}: ${error.message}`));
	}
	await harness?.close(context);
	// claude keeps a transcript directory per worktree, and one for the repo itself, where its memory would go.
	for (const path of [...worktrees, repo]) {
		await rm(join(projects, projectDirNameFor(path)), { recursive: true, force: true });
	}
	await rm(directory, { recursive: true, force: true });
}
