import type { Context } from "@earendil-works/chord/context";
import { type Conversation, defineDoc } from "@earendil-works/pi-durable";
import type { AgentPort, AgentState, ForeignAgent, ForeignStatusEvent } from "../../../ports/agent.ts";
import { type ForeignAction, observeForeign, type Told, toldOf } from "../../domain/foreign.ts";
import { noticeEntry } from "../../notice.ts";

/** By foreign agent id, the prompt last told to the human; see `observeForeign`. */
export const ForeignPrompts = defineDoc<{ told: Told }>({
	kind: "soma.foreign",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ told: {} }),
	checkpointWhen: () => false,
});

/** Entry kind of the input that wakes the model for a blocked foreign agent the human was told of. */
export const FOREIGN_BLOCKED = "soma.foreign.blocked";

export const foreignRequestId = (id: string, seq: number) => `foreign:${id}:${seq}`;

type Blocked = Extract<AgentState, { state: "blocked" }>;

const where = (agent: ForeignAgent) => `外部 agent ${agent.label}（session ${agent.session}）`;

function noticeContent(agent: ForeignAgent, { kind, msg }: Blocked): string {
	const screen = msg ? `\n${msg}` : "";
	return kind === "auth"
		? `${where(agent)}在等登入或憑證，需要你處理。${screen}`
		: `${where(agent)}卡住了，kind=${kind}，你不在它的畫面前。${screen}`;
}

function wakeContent(agent: ForeignAgent, { kind, msg, fingerprint }: Blocked): string {
	const head = `[bridge] ${where(agent)}卡住了，kind=${kind}，id=${agent.id}。人不在它的畫面前，已經通知人。`;
	const screen = msg ? `\n畫面：\n${msg}\n` : "\n";
	return (
		head +
		screen +
		`可以用 respond 工具代答（foreign=${agent.id}、fingerprint=${fingerprint}、option 填選項編號、寫下理由），` +
		"或什麼都不做，留給人。"
	);
}

/**
 * Host-side rule over foreign agents' statuses (ARCHITECTURE.md "Foreign agents"), outside the model loop. A blocked
 * one is told to the human by a question notice, so the push rule picks the interface that rings, only while the human
 * is not looking at its pane, and once per prompt: the prompt told is kept in `ForeignPrompts`, in the commit of the
 * notice, and forgotten when the agent is seen past it. Only that push wakes the model, with a `foreign:<id>:<seq>`
 * input that offers respond, and not for kind=auth, which is never answered, nor for a prompt whose screen gave no
 * fingerprint to answer by. soma never stops, prompts, defers for or resumes a foreign agent.
 */
export function foreignBridge(conversation: Conversation, agents: AgentPort, context: Context) {
	// One event at a time: each reads what was told, acts, then commits it.
	let queue = Promise.resolve();

	async function apply({ agent, seq, watched }: ForeignStatusEvent): Promise<void> {
		const { status } = agent;
		const told = await conversation.commit(async (tx) => {
			const found = (await tx.doc(ForeignPrompts, conversation.id)).told[agent.id];
			// Copied out as JSON: a doc is a live proxy only valid inside its commit.
			return found && (JSON.parse(JSON.stringify(found)) as Told[string]);
		}, context);
		const action: ForeignAction = observeForeign(told, status, watched);
		if (action === "none") return;

		// The wake precedes the commit of the notice, so a crash in between redoes both on restart, the adapter naming
		// the same observation by the same seq: the requestId makes the second submit return the first.
		if (action === "push" && status.state === "blocked" && status.kind !== "auth" && status.fingerprint !== undefined) {
			await conversation.submit(
				{
					type: "input",
					content: wakeContent(agent, status),
					whenBusy: "followUp",
					entry: { kind: FOREIGN_BLOCKED, data: { id: agent.id, kind: status.kind, seq } },
					requestId: foreignRequestId(agent.id, seq),
				},
				context,
			);
		}
		await conversation.commit(async (tx) => {
			const doc = await tx.doc(ForeignPrompts, conversation.id);
			const { [agent.id]: _past, ...others } = JSON.parse(JSON.stringify(doc.told)) as Told;
			if (action === "forget") {
				doc.told = others;
				return;
			}
			if (status.state !== "blocked") return;
			doc.told = { ...others, [agent.id]: toldOf(status) };
			await tx.appendEntry(conversation.id, noticeEntry("question", noticeContent(agent, status)));
		}, context);
	}

	function handle(event: ForeignStatusEvent): Promise<void> {
		const run = queue.then(() => apply(event));
		queue = run.catch(() => {});
		return run;
	}

	return {
		handle,
		/** Feeds every foreign status the agent side reports from now on; returns the unsubscribe. */
		listen(onError: (error: unknown) => void): () => void {
			return agents.onForeignStatus((event) => void handle(event).catch(onError));
		},
	};
}
