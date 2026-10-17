// The core as the event-bridge smoke runs it: main.ts's startup with the event bridge listening, the faux
// model standing in for one that calls `dispatch` (no API key on this machine), and a stub card that
// asks for a result line and a one-word answer. Talks to the herdr session at $HERDR_SOCKET_PATH.
//   run <db> [<card> <repo>]   start up, submit 「派 <card> <repo>」 when given, then report once a second
// Each report line carries the faux request count of this process, the bridge's entries and the jobs.
// SOMA_SMOKE_HANG_AFTER_WAKE=1 freezes the process once a wake's run has finished, before the bridge
// commits the job's seq, so the driver can kill -9 it in that window.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation } from "@earendil-works/pi-durable";
import { createHerdrAgentPort } from "../src/adapters/herdr/agent-port.ts";
import { createHerdrClient } from "../src/adapters/herdr/client.ts";
import {
	AGENT_BLOCKED,
	blockedRequestId,
	eventBridge,
	JOB_DONE,
	reconcileDispatches,
} from "../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../src/core/harness.ts";

const context = BACKGROUND_CONTEXT;
const [mode, db, card, repo] = process.argv.slice(2);
if (mode !== "run" || db === undefined) throw new Error("usage: bridge-child.ts run <db> [<card> <repo>]");
const emit = (record: object) => console.log(JSON.stringify(record));

const agents = createHerdrAgentPort({ client: createHerdrClient() });
const faux = fauxProvider();
faux.setResponses(
	Array.from({ length: 20 }, () => (transcript: { messages: { role: string; content: unknown }[] }) => {
		const last = transcript.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage("已派工。");
		const [, card, repo] = /派 ([a-z0-9-]+) (\S+?)"/.exec(JSON.stringify(last?.content ?? "")) ?? [];
		if (card === undefined || repo === undefined) return fauxAssistantMessage("轉給人。");
		return fauxAssistantMessage([fauxToolCall("dispatch", { card, repo })], {
			stopReason: "toolUse",
		}) as AssistantMessage;
	}),
);
const models = createModels();
models.setProvider(faux.provider);
const stubCard = async (_repo: string, card: string) =>
	`# ${card}\n\n第一行寫「結果：完成」，第二行只寫 ok 兩個字，不要使用任何工具。`;

const harness = await openHarness(db, [dispatchExtension(agents, stubCard)], context, { models });
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
harness.resume();

const watched: Conversation =
	process.env.SOMA_SMOKE_HANG_AFTER_WAKE === "1"
		? new Proxy(root, {
				get(target, key) {
					const value = Reflect.get(target, key);
					if (key !== "submit") return typeof value === "function" ? value.bind(target) : value;
					return async (...args: Parameters<Conversation["submit"]>) => {
						const submission = await target.submit(...args);
						if (!args[0].requestId?.startsWith("herdr:")) return submission;
						await submission.wait(context);
						emit({ event: "woke", requestId: args[0].requestId, calls: faux.state.callCount });
						// A pending promise alone lets node exit; the timer keeps it alive until the kill.
						return new Promise(() => setInterval(() => {}, 60_000));
					};
				},
			})
		: root;

await reconcileDispatches(watched, agents, context);
eventBridge(watched, agents, context).listen((error) => emit({ event: "bridge_error", error: String(error) }));
emit({ event: "started", pid: process.pid, calls: faux.state.callCount });

if (card !== undefined && repo !== undefined) {
	const submission = await root.submit(
		{ type: "input", content: `派 ${card} ${repo}`, requestId: `terminal:${card}` },
		context,
	);
	await submission.wait(context);
}

for (;;) {
	const entries = (await root.entries({}, 1000, undefined, context)).items;
	const jobs = (await harness.snapshot(Dispatches, root.id, context))?.jobs ?? [];
	const admitted = await Promise.all(
		jobs.map((job) =>
			root.commit(
				async (tx) =>
					job.seq === undefined
						? undefined
						: (await tx.submissionByRequest(root.id, blockedRequestId(job.agent, job.seq)))?.status,
				context,
			),
		),
	);
	emit({
		event: "report",
		calls: faux.state.callCount,
		blocked: entries.filter((entry) => entry.kind === AGENT_BLOCKED).map((entry) => entry.data),
		done: entries.filter((entry) => entry.kind === JOB_DONE).map((entry) => entry.data),
		jobs: jobs.map(({ launch, ...job }, index) => ({
			...job,
			launchHeld: launch !== undefined,
			wake: admitted[index],
		})),
	});
	await new Promise((resolve) => setTimeout(resolve, 1_000));
}
