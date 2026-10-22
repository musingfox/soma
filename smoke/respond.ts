// Answer-blocked smoke against a real herdr test session and a real Claude Code, with the faux model standing in
// for one that reads each wake (no API key on this machine):
//   1. a dispatched card stops at Claude Code's folder trust dialog; the model answers it with the option the
//      wake lists for "Yes, I trust this folder", and the bridge then sends the launch prompt;
//   2. the card's Bash command stops at a permission prompt. The model first answers with the trust dialog's
//      fingerprint: the screen has changed since, so nothing may be sent. Then it answers 1 with the right one,
//      and the agent runs the command and finishes;
//   3. a second claude, started with a fake ANTHROPIC_API_KEY exported in its shell, stops at the custom API
//      key dialog. The model must not be called, the HumanPort must get a question notice, and the dialog
//      must still be up afterwards.
// The repo is a throwaway one whose .claude/settings.json sets defaultMode "default", so the user's own default
// mode cannot skip the permission prompt. Repo, worktrees and agents go at the end.
//   tmux -L herdr-test new-session -d "env -u HERDR_SOCKET_PATH -u HERDR_ENV -u HERDR_SESSION -u HERDR_TAB_ID \
//     -u HERDR_WORKSPACE_ID -u HERDR_PANE_ID -u TERM_PROGRAM -u SSH_AUTH_SOCK herdr --session soma-test"
//   node smoke/respond.ts ~/.config/herdr/sessions/soma-test/herdr.sock
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHerdrAgentPort } from "../src/adapters/herdr/agent-port.ts";
import { createHerdrClient } from "../src/adapters/herdr/client.ts";
import { AgentStartedResultSchema, WorktreeOpenedResultSchema } from "../src/adapters/herdr/schema.ts";
import { AGENT_BLOCKED, eventBridge } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";
import type { SomaEvent } from "../src/ports/human.ts";
import { delay } from "./driver.ts";

const context = BACKGROUND_CONTEXT;
const [socketPath] = process.argv.slice(2);
if (socketPath === undefined) throw new Error("usage: respond.ts <herdr socket of a test session>");
const herdr = createHerdrClient({ socketPath });
const agents = createHerdrAgentPort({ client: herdr });
const stamp = Date.now().toString(36);
const card = `answer-${stamp}`;
const authCard = `auth-${stamp}`;
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

async function until<T>(what: string, ms: number, read: () => Promise<T | undefined>): Promise<T> {
	for (const deadline = Date.now() + ms; ; await delay(500)) {
		const value = await read();
		if (value !== undefined) return value;
		check(Date.now() < deadline, `timed out waiting for ${what}`);
	}
}

// The faux model. A wake lists the options and the fingerprint; the trust dialog is answered with the option
// labelled "Yes, I trust this folder", any other prompt first with the stale fingerprint, then with 1.
const fingerprints: string[] = [];
const toolResults: unknown[] = [];
const faux = fauxProvider();
faux.setResponses(
	Array.from({ length: 30 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
		const last = request.messages.at(-1);
		const said = JSON.stringify(last?.content ?? "");
		if (last?.role === "toolResult") {
			const result = JSON.parse(JSON.parse(said)[0].text);
			toolResults.push(result);
			if (result.refusal !== "stale") return fauxAssistantMessage("好。");
			const fingerprint = fingerprints.at(-1) ?? "";
			return fauxAssistantMessage(
				[fauxToolCall("respond", { card, option: "1", fingerprint, reason: "只是在 repo 裡建一個空檔" })],
				{ stopReason: "toolUse" },
			) as AssistantMessage;
		}
		const dispatch = /派 ([a-z0-9-]+) (\S+?)"/.exec(said);
		if (dispatch?.[1] !== undefined && dispatch[2] !== undefined) {
			return fauxAssistantMessage([fauxToolCall("dispatch", { card: dispatch[1], repo: dispatch[2] })], {
				stopReason: "toolUse",
			}) as AssistantMessage;
		}
		const fingerprint = /fingerprint=([0-9a-f]+)/.exec(said)?.[1];
		if (fingerprint === undefined) return fauxAssistantMessage("轉給人。");
		fingerprints.push(fingerprint);
		const trust = /\\n(\d+)\. Yes, I trust this folder/.exec(said)?.[1];
		const answer =
			trust !== undefined
				? { card, option: trust, fingerprint, reason: "soma 自己開的 fleet worktree" }
				: { card, option: "1", fingerprint: fingerprints.at(-2) ?? "", reason: "只是在 repo 裡建一個空檔" };
		return fauxAssistantMessage([fauxToolCall("respond", answer)], { stopReason: "toolUse" }) as AssistantMessage;
	}),
);
const models = createModels();
models.setProvider(faux.provider);
const cardText = async (_repo: string, name: string) =>
	`# ${name}\n\n用 Bash 工具執行這一行指令：touch canary.txt\n做完只回覆 ok。`;

const directory = await mkdtemp(join(tmpdir(), "soma-respond-"));
const harness = await openHarness(join(directory, "soma.sqlite"), [dispatchExtension(agents, cardText)], context, {
	models,
});
try {
	const repo = join(directory, "repo");
	spawnSync("git", ["init", "-q", repo]);
	await mkdir(join(repo, ".claude"));
	await writeFile(join(repo, ".claude/settings.json"), JSON.stringify({ permissions: { defaultMode: "default" } }));
	spawnSync("git", ["-C", repo, "add", "."]);
	spawnSync("git", ["-C", repo, "commit", "-q", "-m", "chore: init"]);

	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const human = await openHumanPort(harness, root, agents, context);
	const notices: SomaEvent[] = [];
	human.subscribe((event) => {
		if (event.type === "notice") notices.push(event);
	});
	const errors: unknown[] = [];
	const unlisten = eventBridge(root, agents, context).listen((error) => errors.push(error));
	const job = async (name: string) =>
		(await harness.snapshot(Dispatches, root.id, context))?.jobs.find((each) => each.card === name);
	const wakes = async () =>
		(await root.entries({}, 1000, undefined, context)).items.filter((entry) => entry.kind === AGENT_BLOCKED).length;

	await (await root.submit({ type: "input", content: `派 ${card} ${repo}`, requestId: `t:${card}` }, context)).wait(
		context,
	);
	log("card", card);

	// 1 and 2: trust dialog, then the Bash prompt, answered through the respond tool.
	const done = await until("the agent to finish", 180_000, async () => {
		check(errors.length === 0, `bridge error: ${String(errors[0])}`);
		const current = await job(card);
		return current?.status.state === "done" ? current : undefined;
	});
	const listed = spawnSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" }).stdout;
	const path = /worktree (\S+)\nHEAD \S+\nbranch refs\/heads\/fleet\/answer-/.exec(listed)?.[1];
	check(path !== undefined && existsSync(join(path, "canary.txt")), `no canary.txt in the worktree ${path}`);
	check(
		JSON.stringify(done.decisions.map((each) => [each.action, each.option])) ===
			JSON.stringify([
				["answered", "2"],
				["answered", "1"],
			]),
		`decisions ${JSON.stringify(done.decisions)}`,
	);
	check(
		toolResults.some((result) => JSON.stringify(result) === JSON.stringify({ sent: false, refusal: "stale" })),
		`no stale refusal among ${JSON.stringify(toolResults)}`,
	);
	const answers = toolResults.filter((result) => typeof result === "object" && result !== null && "sent" in result);
	log("answered", { status: done.status.state, decisions: done.decisions, answers, canary: true });

	// 3: an auth dialog never reaches the model.
	const calls = faux.state.callCount;
	const wakesBefore = await wakes();
	const opened = await herdr.call(
		"worktree.create",
		{ cwd: repo, branch: `fleet/${authCard}`, label: authCard, focus: false },
		WorktreeOpenedResultSchema,
	);
	const pane = opened.root_pane.pane_id;
	await delay(3_000);
	await herdr.paneSendText(
		pane,
		"export ANTHROPIC_API_KEY=sk-ant-api03-soma-smoke-not-a-real-key-0000000000000000000000000000000000000000AA\n",
	);
	await delay(1_000);
	await root.commit(async (tx) => {
		(await tx.doc(Dispatches, root.id)).jobs.push({
			card: authCard,
			agent: authCard,
			sessionId: randomUUID(),
			status: { state: "idle" },
			decisions: [],
		});
	}, context);
	await herdr.call(
		"agent.start",
		{ name: authCard, kind: "claude", pane_id: pane, args: ["--session-id", randomUUID()] },
		AgentStartedResultSchema,
	);
	const escalated = await until("the auth notice", 60_000, async () =>
		notices.length > 0 ? (await job(authCard))?.decisions : undefined,
	);
	await delay(5_000);
	check(faux.state.callCount === calls, `the auth block cost ${faux.state.callCount - calls} model calls`);
	check((await wakes()) === wakesBefore, "the auth block woke the model");
	check(notices.length === 1 && JSON.stringify(notices).includes("API key"), `notices ${JSON.stringify(notices)}`);
	check(escalated[0]?.action === "escalated" && escalated[0].kind === "auth", `decisions ${JSON.stringify(escalated)}`);
	const still = await herdr.agentGet(authCard);
	const screen = (await herdr.paneRead({ pane_id: still.pane_id, source: "detection" })).text;
	check(still.agent_status === "blocked" && screen.includes("Do you want to use this API key?"), "the dialog is gone");
	log("auth", { notices, decisions: escalated, modelCalls: 0, herdr: still.agent_status });

	unlisten();
	await human.close();
	console.log("PASS");
} finally {
	await harness.close(context);
	for (const agent of await herdr.agentList()) {
		if (agent.name === card || agent.name === authCard) {
			await herdr.call("worktree.remove", { workspace_id: agent.workspace_id, force: true });
		}
	}
	await rm(directory, { recursive: true, force: true });
}
