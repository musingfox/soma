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
 * fingerprint to answer by. A handling that failed is retried until the agent reports again or is gone. soma never
 * stops, prompts, defers for or resumes a foreign agent.
 */
export function foreignBridge(conversation: Conversation, agents: AgentPort, context: Context) {
	// One event at a time: each reads what was told, acts, then commits it.
	let queue = Promise.resolve();
	// By agent id, the last event whose handling failed; the adapter has recorded its seq as reported, so it will not come
	// again until something changes.
	const failed = new Map<string, ForeignStatusEvent>();

	async function apply({ agent, seq, watched }: ForeignStatusEvent): Promise<void> {
		const { status } = agent;
		// WHY one commit: the wake, the notice and the prompt told are stored together or not at all. Two commits, wake
		// first, left a crash between them with a model told "the human was notified" and no notice, which a human who went
		// back to the pane before the restart would never be sent (the restart then sees the pane watched and pushes
		// nothing); notice first would lose the wake instead. In one commit a crash or a throw leaves nothing, so the
		// retry or the restart is the first and only push; the requestId still makes a wake submitted some other way
		// return the first.
		await conversation.commit(async (tx) => {
			const doc = await tx.doc(ForeignPrompts, conversation.id);
			// Copied out as JSON: a doc is a live proxy, and it is read before the admission, written after it.
			const found = doc.told[agent.id];
			const told = found && (JSON.parse(JSON.stringify(found)) as Told[string]);
			const others = JSON.parse(JSON.stringify(doc.told)) as Told;
			delete others[agent.id];
			const action: ForeignAction = observeForeign(told, status, watched);
			if (action === "none") return;
			if (action === "forget") {
				doc.told = others;
				return;
			}
			if (status.state !== "blocked") return;
			// The admission goes before this commit's other table writes, once.
			if (status.kind !== "auth" && status.fingerprint !== undefined) {
				await conversation.submit(tx, {
					type: "input",
					content: wakeContent(agent, status),
					whenBusy: "followUp",
					entry: { kind: FOREIGN_BLOCKED, data: { id: agent.id, kind: status.kind, seq } },
					requestId: foreignRequestId(agent.id, seq),
				});
			}
			const prompt = toldOf(status);
			doc.told = { ...others, [agent.id]: prompt };
			await tx.appendEntry(
				conversation.id,
				noticeEntry("question", noticeContent(agent, status), undefined, { id: agent.id, told: prompt }),
			);
		}, context);
	}

	function handle(event: ForeignStatusEvent): Promise<void> {
		// A newer report of the agent replaces a failed one, whether or not it succeeds itself.
		failed.delete(event.agent.id);
		const run = queue.then(() =>
			apply(event).catch((error: unknown) => {
				failed.set(event.agent.id, event);
				throw error;
			}),
		);
		queue = run.catch(() => {});
		return run;
	}

	/**
	 * Handles again each event whose handling failed and whose agent is still listed; its status is the last the agent
	 * side reported, as it reports again on any change. Returns the errors of those that failed once more.
	 */
	async function retry(): Promise<unknown[]> {
		if (failed.size === 0) return [];
		const listed = new Set((await agents.listForeign()).map(({ id }) => id));
		const errors: unknown[] = [];
		for (const [id, event] of [...failed]) {
			if (!listed.has(id)) failed.delete(id);
			else await handle(event).catch((error: unknown) => errors.push(error));
		}
		return errors;
	}

	return {
		handle,
		retry,
		/**
		 * Feeds every foreign status the agent side reports from now on, and every `retryMs` handles again the ones that
		 * failed; returns the unsubscribe.
		 */
		listen(onError: (error: unknown) => void, retryMs = 15_000): () => void {
			const off = agents.onForeignStatus((event) => void handle(event).catch(onError));
			const timer = setInterval(() => void retry().then((errors) => errors.forEach(onError), onError), retryMs);
			timer.unref();
			return () => {
				off();
				clearInterval(timer);
			};
		},
	};
}
