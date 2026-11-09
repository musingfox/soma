// The core as the dispatch smoke runs it: main.ts's startup, with the faux model standing in for one that
// calls `dispatch` (no API key on this machine). Talks to the herdr session at $HERDR_SOCKET_PATH. Its claude runs with
// $CLAUDE_CONFIG_DIR, where its transcripts go too.
//   dispatch <db> <card> <repo>   start up, then submit 「派 <card>」 and wait for the answer
//   reopen <db>                   start up only: resume, let any interrupted dispatch rerun, reconcile
// SOMA_SMOKE_HANG_AFTER_START=1 freezes the process once herdr has acked agent.start, before the
// dispatch list is written, so the driver can kill -9 it in that window.
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHerdrAgentPort } from "../src/adapters/herdr/agent-port.ts";
import { createHerdrClient } from "../src/adapters/herdr/client.ts";
import { reconcileDispatches } from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import type { AgentPort } from "../src/ports/agent.ts";
import { startingInConfig } from "./herdr-claude.ts";

const context = BACKGROUND_CONTEXT;
const [mode, db, card, repo] = process.argv.slice(2);
if (db === undefined) throw new Error("usage: dispatch-child.ts dispatch <db> <card> <repo> | reopen <db>");
const config = process.env.CLAUDE_CONFIG_DIR;
if (config === undefined) throw new Error("CLAUDE_CONFIG_DIR must be set");
const emit = (record: object) => console.log(JSON.stringify(record));

const herdr = createHerdrAgentPort({
	client: startingInConfig(createHerdrClient({ socketPath: process.env.HERDR_SOCKET_PATH }), config),
	projectsDir: join(config, "projects"),
});
const agents: AgentPort =
	process.env.SOMA_SMOKE_HANG_AFTER_START === "1"
		? {
				...herdr,
				async start(request) {
					await herdr.start(request);
					emit({ event: "agent_started", sessionId: request.sessionId, pid: process.pid });
					// A pending promise alone lets node exit; the timer keeps it alive until the kill.
					await new Promise(() => setInterval(() => {}, 60_000));
				},
			}
		: herdr;

// Calls dispatch once per user input, and answers in text once the tool result is in.
const faux = fauxProvider();
faux.setResponses(
	Array.from({ length: 8 }, () => (transcript: { messages: { role: string; content: unknown }[] }) => {
		const last = transcript.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage("已派工。");
		const text = JSON.stringify(last?.content ?? "");
		const [, card, repo] = /派 ([a-z0-9-]+) (\S+?)"/.exec(text) ?? [];
		if (card === undefined || repo === undefined) return fauxAssistantMessage("沒有要派的卡。");
		return fauxAssistantMessage([fauxToolCall("dispatch", { card, repo })], {
			stopReason: "toolUse",
		}) as AssistantMessage;
	}),
);
const models = createModels();
models.setProvider(faux.provider);

const harness = await openHarness(
	db,
	[dispatchExtension(agents, async (_repo, card) => `# ${card}\n\n只回覆 ok 兩個字，不要使用任何工具。`)],
	context,
	{ models },
);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
harness.resume();
await reconcileDispatches(root, agents, context);
emit({ event: "started", pid: process.pid });

if (mode === "dispatch") {
	if (card === undefined || repo === undefined) throw new Error("dispatch needs <card> <repo>");
	const submission = await root.submit(
		{ type: "input", content: `派 ${card} ${repo}`, requestId: `terminal:${card}` },
		context,
	);
	await submission.wait(context);
} else if (mode === "reopen") {
	await root.waitForIdle(context);
	await reconcileDispatches(root, agents, context);
} else {
	throw new Error(`unknown mode: ${mode}`);
}
emit({ event: "jobs", jobs: (await harness.snapshot(Dispatches, root.id, context))?.jobs ?? [] });
await harness.close(context);
