// Reflection smoke test on the real obsidian CLI and the real herdr fleet session: one recorded signal, a reflection
// tick, and a scripted model that opens a code-change card and dispatches it. Checks that the card is in the vault, the
// agent is in the fleet and the human got the notices; then stops the agent and deletes the card, worktree and branch.
// The agent never gets its first prompt: that is the event bridge's job, and no bridge runs here.
//   node smoke/reflection-card.ts <repo>
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { createHerdrAgentPort } from "../src/adapters/herdr/agent-port.ts";
import { createHerdrClient } from "../src/adapters/herdr/client.ts";
import { createCard, readCard } from "../src/adapters/obsidian/card.ts";
import { SIGNAL } from "../src/core/domain/signal.ts";
import { dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { memory, recordFact } from "../src/core/extensions/memory/index.ts";
import { reflection } from "../src/core/extensions/reflection/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";

const sh = promisify(execFile);
const context = BACKGROUND_CONTEXT;
const repo = process.argv[2];
if (repo === undefined) throw new Error("usage: reflection-card.ts <repo>");
const socketPath = process.env.SOMA_HERDR_SOCKET ?? join(homedir(), ".config/herdr/sessions/fleet/herdr.sock");
const card = `reflection-smoke-${Date.now().toString(36)}`;
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

const faux = fauxProvider();
faux.setResponses(
	Array.from({ length: 10 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
		const last = JSON.stringify(request.messages.findLast((message) => message.role !== "system")?.content ?? "");
		if (last.includes("已開卡"))
			return fauxAssistantMessage([fauxToolCall("dispatch", { card, repo })], { stopReason: "toolUse" });
		if (last.includes("sessionId"))
			return fauxAssistantMessage(`觀察：card-x 失敗。\n證據 id：entry:1\n改動：開了 ${card} 並派進 fleet。`);
		const open = fauxToolCall("open_card", {
			card,
			title: "反省冒煙測試卡（測完即刪）",
			body: "這是 soma 反省的冒煙測試。不要改任何檔案，只回覆一行「結果：完成」。",
			evidence: ["entry:1"],
		});
		return fauxAssistantMessage([open], { stopReason: "toolUse" });
	}),
);
const models = createModels();
models.setProvider(faux.provider);
const agents = createHerdrAgentPort({ client: createHerdrClient({ socketPath }) });
const reflections = reflection({ repo, createCard, readCard });
const directory = await mkdtemp(join(tmpdir(), "soma-reflection-card-"));
const harness: Harness = await openHarness(
	join(directory, "soma.sqlite"),
	[memory, dispatchExtension(agents, readCard), reflections.extension],
	context,
	{ models },
);
const herdr = async (...args: string[]) => (await sh("herdr", ["--session", "fleet", ...args])).stdout;
try {
	const root = await harness.root(context, { agent: { model: { provider: faux.provider.id, modelId: "faux-1" } } });
	const human = await openHumanPort(harness, root, context);
	const notices: string[] = [];
	human.subscribe((event) => {
		if (event.type === "notice") notices.push(event.content);
	});
	await root.commit(async (tx) => {
		await recordFact(tx, {
			at: Date.now(),
			kind: SIGNAL.dispatchFailed,
			text: "agent card-x（卡片 card-x）結束時回報「結果：失敗」。",
			key: "dispatch:card-x:1",
			refs: { entry: 1, card: "card-x", agent: "card-x", seq: 1 },
		});
	}, context);
	await reflections.startReflection(root, 1_000, context);
	harness.resume();
	for (const deadline = Date.now() + 60_000; !notices.some((notice) => notice.startsWith("觀察：")); await delay(200))
		check(Date.now() < deadline, `no reflection notice; notices: ${JSON.stringify(notices)}`);
	await human.close();

	log("card", (await readCard(repo, card)).split("\n"));
	const listed = (await agents.list()).find((agent) => agent.name === card);
	log("fleet", listed);
	log("notices", notices);
	check(listed !== undefined, `agent ${card} is not in the fleet`);
	check(
		notices.some((notice) => notice.includes(`開了一張改程式碼的卡 ${card}`)),
		"the human got no notice of the card",
	);
} finally {
	await harness.close(context);
	await rm(directory, { recursive: true, force: true });
	const agent = JSON.parse(await herdr("agent", "list")).result.agents.find(
		(each: { name: string }) => each.name === card,
	);
	if (agent !== undefined) {
		log("stop", await herdr("worktree", "remove", "--workspace", agent.workspace_id, "--force"));
	}
	await sh("git", ["-C", repo, "worktree", "prune"]);
	log("branch", (await sh("git", ["-C", repo, "branch", "-D", `fleet/${card}`]).catch((error) => error)).stdout);
	log(
		"delete",
		(await sh("obsidian", ["vault=obsidian", "delete", `path=pm/soma/tasks/${card}.md`, "permanent"])).stdout,
	);
	const left = JSON.parse(await herdr("agent", "list")).result.agents.map((each: { name: string }) => each.name);
	log("left", left);
	check(!left.includes(card), `agent ${card} is still in the fleet`);
}
console.log("PASS");
