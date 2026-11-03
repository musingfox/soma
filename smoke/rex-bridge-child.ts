// The core as the rex event-bridge smoke runs it: main.ts's startup with the rex adapter and the event bridge
// listening, the faux model standing in for one that calls `dispatch` and `respond`, and a stub card that asks for a
// result line and a one-word answer. Dispatches into the rex session $SOMA_REX_SESSION_ID on the server at
// $SOMA_REX_SOCKET.
//   run <db> [<card> <repo>]   start up, submit 「派 <card> <repo>」 when given, then report once a second
// A line `trust <card>` on stdin submits 「信任 <card>」, the human's go-ahead for the folder-trust dialog the model
// asked about. The faux model answers it with `respond`, choosing "Yes, I trust this folder" with the fingerprint the
// wake gave, and only when the dialog it was woken for names $SOMA_SMOKE_TRUST_PATH, the smoke's own fresh worktree.
// SOMA_SMOKE_HANG_AFTER_WAKE=1 freezes the process once a wake's run has finished, before the bridge commits the job's
// seq, so the driver can kill -9 it in that window.
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation, SubmissionDraft } from "@earendil-works/pi-durable";
import { createRexAgentPort } from "../src/adapters/rex/agent-port.ts";
import { createRexClient, defaultRexSocket } from "../src/adapters/rex/client.ts";
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
if (mode !== "run" || db === undefined) throw new Error("usage: rex-bridge-child.ts run <db> [<card> <repo>]");
const hangar = process.env.SOMA_REX_SESSION_ID;
if (hangar === undefined) throw new Error("SOMA_REX_SESSION_ID names the smoke's rex session");
const trustPath = process.env.SOMA_SMOKE_TRUST_PATH;
const emit = (record: object) => console.log(JSON.stringify(record));

const client = createRexClient({ socketPath: process.env.SOMA_REX_SOCKET ?? defaultRexSocket(homedir()) });
const agents = createRexAgentPort({
	client,
	sessionId: hangar,
	onError: (error) => emit({ event: "rex_error", error: error.message }),
});

type Message = { role: string; content: unknown };
const textOf = (message: Message | undefined) =>
	typeof message?.content === "string"
		? message.content
		: Array.isArray(message?.content)
			? message.content
					.flatMap((part: { type?: string; text?: string }) => (part.type === "text" ? [part.text ?? ""] : []))
					.join("")
			: "";
const squeeze = (text: string) => text.replace(/\s+/g, "");

/** The respond call for the trust dialog the last wake about `card` showed, or why there is none. */
function trustAnswer(messages: Message[], card: string): AssistantMessage | string {
	const wake = messages.map(textOf).findLast((text) => text.includes("[bridge]") && text.includes(`卡片 ${card}）`));
	if (wake === undefined) return `沒有 ${card} 的卡住通知。`;
	const fingerprint = /fingerprint=([0-9a-f]+)/.exec(wake)?.[1];
	const option = /^(\d+)\. Yes, I trust this folder$/m.exec(wake)?.[1];
	// Only the smoke's own fresh worktree is ever trusted; the screen may wrap its path.
	if (trustPath === undefined || !squeeze(wake).includes(squeeze(trustPath)))
		return "畫面上的資料夾不是這次 smoke 的。";
	if (fingerprint === undefined || option === undefined) return "畫面不是資料夾信任對話框。";
	return fauxAssistantMessage(
		[fauxToolCall("respond", { card, option, fingerprint, reason: "smoke 自己建的新 repo，人說可以信任" })],
		{ stopReason: "toolUse" },
	) as AssistantMessage;
}

// Dispatches on 「派」, asks the human on a wake, and answers the dialog with respond once the human says 信任.
const faux = fauxProvider();
faux.setResponses(
	Array.from({ length: 20 }, () => (transcript: { messages: Message[] }) => {
		const last = transcript.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage(`好。${textOf(last)}`);
		const text = textOf(last);
		if (text.includes("[bridge]")) return fauxAssistantMessage("這是資料夾信任對話框，要信任這個資料夾嗎？");
		const trusted = /信任 ([a-z0-9-]+)/.exec(text)?.[1];
		if (trusted !== undefined) {
			const answer = trustAnswer(transcript.messages, trusted);
			return typeof answer === "string" ? fauxAssistantMessage(answer) : answer;
		}
		const [, card, repo] = /派 ([a-z0-9-]+) (\S+)/.exec(text) ?? [];
		if (card === undefined || repo === undefined) return fauxAssistantMessage("?");
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
					return async (draft: SubmissionDraft, ctx: Context) => {
						const submission = await target.submit(draft, ctx);
						if (!draft.requestId?.startsWith("agent:")) return submission;
						await submission.wait(context);
						emit({ event: "woke", requestId: draft.requestId, calls: faux.state.callCount });
						// A pending promise alone lets node exit; the timer keeps it alive until the kill.
						return new Promise(() => setInterval(() => {}, 60_000));
					};
				},
			})
		: root;

await reconcileDispatches(watched, agents, context);
eventBridge(watched, agents, context).listen((error) => emit({ event: "bridge_error", error: String(error) }));
emit({ event: "started", pid: process.pid, calls: faux.state.callCount });

createInterface({ input: process.stdin }).on("line", (line) => {
	const trusted = /^trust ([a-z0-9-]+)$/.exec(line)?.[1];
	if (trusted === undefined) return;
	void root
		.submit({ type: "input", content: `信任 ${trusted}`, requestId: `terminal:trust-${trusted}` }, context)
		.then((submission) => submission.wait(context))
		.then(() => emit({ event: "trusted", calls: faux.state.callCount }));
});

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
