// main.ts's startup and terminal client, with the faux model standing in for one that calls `dispatch` on
// 「派 <card> <repo>」 (no API key on this machine). Talks to the herdr session at $SOMA_HERDR_SOCKET.
//   node smoke/terminal-child.ts <db>
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHerdrAgentPort } from "../src/adapters/herdr/agent-port.ts";
import { createHerdrClient } from "../src/adapters/herdr/client.ts";
import { runTerminal } from "../src/adapters/terminal/index.ts";
import { dispatchExtension, reconcileDispatches } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { openHumanPort } from "../src/core/human-port.ts";

const context = BACKGROUND_CONTEXT;
const [db] = process.argv.slice(2);
if (db === undefined) throw new Error("usage: terminal-child.ts <db>");

const faux = fauxProvider();
faux.setResponses(
	Array.from({ length: 8 }, () => async (transcript: { messages: { role: string; content: unknown }[] }) => {
		const last = transcript.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage("已派工。");
		const [, card, repo] = /派 ([a-z0-9-]+) (\S+?)"/.exec(JSON.stringify(last?.content ?? "")) ?? [];
		if (card === undefined || repo === undefined) return fauxAssistantMessage("沒有要派的卡。");
		// Long enough for the working state to be seen.
		await new Promise((resolve) => setTimeout(resolve, 1500));
		return fauxAssistantMessage([fauxToolCall("dispatch", { card, repo })], {
			stopReason: "toolUse",
		}) as AssistantMessage;
	}),
);
const models = createModels();
models.setProvider(faux.provider);

const agents = createHerdrAgentPort({ client: createHerdrClient({ socketPath: process.env.SOMA_HERDR_SOCKET }) });
const harness = await openHarness(db, [dispatchExtension(agents)], context, { models });
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
harness.resume();
await reconcileDispatches(root, agents, context);
const human = await openHumanPort(harness, root, context);
await runTerminal({ human, input: process.stdin, output: process.stdout, env: process.env });
await human.close();
await harness.close(context);
