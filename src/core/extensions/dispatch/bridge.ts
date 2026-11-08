import type { Context } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import type { AgentPort, AgentState, AgentStatusEvent } from "../../../ports/agent.ts";
import type { HandoverSettling, Settled } from "../../../ports/handover.ts";
import { complete, observe } from "../../domain/bridge.ts";
import type { Decision, Job } from "../../domain/dispatch.ts";
import { CUT, dormantNotice, reconcile, turning, unfinished } from "../../domain/reconcile.ts";
import { resultNotice, urgent } from "../../domain/report.ts";
import { dispatchSignal, reblockSignal } from "../../domain/signal.ts";
import { noticeEntry } from "../../notice.ts";
import { recordFact } from "../memory/index.ts";
import { commitMove, Dispatches } from "./index.ts";
import { reclaimer } from "./reclaim.ts";

/** Entry kind of a turn the bridge recorded as finished; it carries no model message. */
export const JOB_DONE = "soma.dispatch.done";
/** Entry kind of the input that wakes the model for a blocked agent. */
export const AGENT_BLOCKED = "soma.dispatch.blocked";

export const blockedRequestId = (agent: string, seq: number) => `agent:${agent}:${seq}`;

function wakeContent(job: Job, status: Extract<AgentState, { state: "blocked" }>): string {
	const { kind, msg, fingerprint } = status;
	const head = `[bridge] agent ${job.agent}（卡片 ${job.card}）卡住了，kind=${kind}。`;
	// A ticket job's brief forbids code changes in prose only; the permission prompt is where soma can hold it to that.
	// claude takes a "no" as the user interrupting: its turn ends with no reply and it waits, so the refusal needs a reply.
	const ticket =
		job.ticket === undefined
			? ""
			: "\nThis is a ticket job: its agent must only write one task card in the vault, and change no code. Refuse " +
				"an Edit or Write of any file outside the vault, and any command that changes code, commits or dispatches: " +
				"answer with the option that says no. A refused agent stops and waits, so right after refusing, use the " +
				`reply tool (card=${job.card}) to tell it to write only the card in the vault and to finish with its ` +
				"result line.";
	const screen = msg ? `\n畫面：\n${msg}\n` : "\n";
	const how =
		fingerprint === undefined
			? "畫面讀不出選項，無法代答：用 escalate 工具轉給人並寫下理由。"
			: `用 respond 工具代答（card=${job.card}、fingerprint=${fingerprint}、option 填選項編號、寫下理由），` +
				"或用 escalate 工具轉給人並寫下理由。";
	return head + ticket + screen + how;
}

/**
 * Host-side rules over agent status, outside the model loop (ARCHITECTURE.md "Event bridge").
 * A finished turn is committed to the dispatch list and the transcript with the outcome its
 * reply's first line states, which starts no run, and an urgent one with a notice to the human; only a blocked agent submits an input, and a
 * kind=auth block not even that: it is committed as a notice to the human together with the
 * decision, so the model never sees it to answer. The input's requestId carries the observation's
 * seq, so a resent event, from a repeated snapshot or a restarted core, is admitted once. A turn is
 * recorded once per last transcript record: the same record under a new seq is the same turn.
 * An idle or done agent with a deferral pending is stopped after its turn is recorded (`reclaimer`), and a job soma
 * stopped takes no more statuses: what its closed window reports is no news.
 */
export function eventBridge(conversation: Conversation, agents: AgentPort, context: Context) {
	// One event at a time: each reads the job, acts, then commits what it saw.
	let queue = Promise.resolve();
	const reclaim = reclaimer(conversation, agents, context);

	async function apply(event: AgentStatusEvent): Promise<void> {
		// A doc is a live proxy only valid inside its commit, so the job is copied out as the JSON it is stored as.
		const job = await conversation.commit(async (tx) => {
			const found = (await tx.doc(Dispatches, conversation.id)).jobs.find(
				(candidate) => candidate.agent === event.agent,
			);
			return found && (JSON.parse(JSON.stringify(found)) as Job);
		}, context);
		if (job === undefined || job.reclaim?.phase === "stopped") return;
		const observed = observe(job, event.status, event.seq);
		if (observed.job === job) return;
		const result = observed.action === "complete" ? await agents.readResult(job.agent) : undefined;
		const { job: next, action } = complete(observed, result);
		// A turn that ends without a reply is told apart by its id but says nothing, as an unreadable one.
		const reply = result?.text || undefined;

		// Each side effect precedes the commit of its seq, so a crash in between redoes it on restart:
		// the requestId makes the second submit return the first.
		if (action === "wake" && event.status.state === "blocked") {
			const { kind } = event.status;
			await conversation.submit(
				{
					type: "input",
					content: wakeContent(job, event.status),
					whenBusy: "followUp",
					entry: { kind: AGENT_BLOCKED, data: { agent: job.agent, card: job.card, kind, seq: event.seq } },
					requestId: blockedRequestId(job.agent, event.seq),
				},
				context,
			);
		}
		if (action === "launch" && job.launch !== undefined) await agents.prompt(job.agent, job.launch);

		await conversation.commit(async (tx) => {
			const doc = await tx.doc(Dispatches, conversation.id);
			const index = doc.jobs.findIndex((candidate) => candidate.agent === event.agent);
			const current = doc.jobs[index];
			if (current === undefined || current.seq === event.seq) return;
			// Decisions come from the current job, not the one read above: a respond tool may have added one since, and
			// so may the reclaim, which a defer may have armed since.
			const { launch: _held, handedOver: _handed, ...kept } = current;
			const { decisions: _read, reclaim: _armed, ...fields } = next;
			doc.jobs[index] = { ...kept, ...fields };
			if (action === "escalate") {
				const decision: Decision = {
					at: new Date().toISOString(),
					kind: "auth",
					action: "escalated",
					reason: "kind=auth 一律轉給人，事件橋沒有叫醒模型",
				};
				doc.jobs[index] = { ...kept, ...fields, decisions: [...kept.decisions, decision] };
				const msg = event.status.msg ? `\n${event.status.msg}` : "";
				await tx.appendEntry(
					conversation.id,
					noticeEntry(
						"question",
						"action",
						`agent ${next.agent}（卡片 ${next.card}）在等登入或憑證，需要你處理。${msg}`,
					),
				);
			}
			// Signals commit with the seq, so a resent event records none twice.
			if (action === "wake") {
				const signal = reblockSignal(current, event.status, event.seq, Date.now());
				if (signal !== undefined) await recordFact(tx, signal);
			}
			if (action === "complete") {
				const outcome = next.outcome ?? "未知";
				// Told now, in the commit of its seq, so a resent event or a restart tells it once; the report skips it.
				const notified = reply !== undefined && urgent(outcome, current, Date.now());
				if (notified) {
					await tx.appendEntry(
						conversation.id,
						outcome === "需要你"
							? noticeEntry("question", "action", resultNotice(next, reply))
							: noticeEntry("report", "outcome", resultNotice(next, reply)),
					);
				}
				const done = await tx.appendEntry(conversation.id, {
					kind: JOB_DONE,
					data: {
						agent: next.agent,
						card: next.card,
						state: next.status.state,
						outcome,
						seq: event.seq,
						notified,
					},
				});
				const signal = dispatchSignal(next, outcome, event.seq, done.id, Date.now());
				if (signal !== undefined) await recordFact(tx, signal);
			}
		}, context);
		if (event.status.state === "idle" || event.status.state === "done") await reclaim(job.agent);
	}

	function handle(event: AgentStatusEvent): Promise<void> {
		const run = queue.then(() => apply(event));
		queue = run.catch(() => {});
		return run;
	}

	return {
		handle,
		/** Feeds every status the agent side reports from now on; returns the unsubscribe. */
		listen(onError: (error: unknown) => void): () => void {
			return agents.onStatus((event) => void handle(event).catch(onError));
		},
	};
}

/**
 * What the agent side settled with no `show_job` to record it: a handover cut short, or one whose soma died before its
 * commit. Listening before the reconcile, as main.ts does, the reconcile finds each move recorded. A job on rex takes the
 * session its window runs and the human is told, in one commit, so a job that already holds that session has been told,
 * by `show_job` or by this, in this soma or one before. A job given back is told once, by its return's time, kept with
 * the job in the commit of the notice: unfinished at a startup, by the restart's notice, which never names a done one. A
 * job whose window closed before its move was recorded takes the session too, with no claim of a window: one the
 * reconcile will report gone is told by that, and a done one, which it leaves alone, is told here.
 */
export function handoverBridge(conversation: Conversation, settling: HandoverSettling, context: Context) {
	async function apply(settled: Settled): Promise<void> {
		await conversation.commit(async (tx) => {
			const doc = await tx.doc(Dispatches, conversation.id);
			const index = doc.jobs.findIndex((each) => each.agent === settled.agent);
			const job = doc.jobs[index];
			if (job === undefined) return;
			const { agent, card } = job;
			const report = (content: string) => tx.appendEntry(conversation.id, noticeEntry("report", "outcome", content));
			if (settled.onto === "acp") {
				if (job.toldBack === settled.at) return;
				doc.jobs[index] = { ...job, toldBack: settled.at };
				if (settled.startup && unfinished(job.status)) return;
				await report(
					`agent ${agent} (card ${card}) is back on ACP: its handover was cut short and no window of it opened. ` +
						"A reply goes on in the same session.",
				);
				return;
			}
			if (job.sessionId === settled.sessionId) return;
			if (settled.onto === "gone") {
				const { launch: _sent, ...rest } = job;
				doc.jobs[index] = { ...rest, sessionId: settled.sessionId };
				if (!unfinished(job.status)) {
					await report(
						`agent ${agent} (card ${card}) was handed over to rex, and no window of it is open now: it is gone.`,
					);
				}
				return;
			}
			await commitMove(tx, conversation.id, { agent, card }, settled, " Its handover was cut short and ended there.");
		}, context);
	}
	let queue = Promise.resolve();
	return {
		/** Feeds every job the agent side settles from now on, and those it settled before; returns the unsubscribe. */
		listen(onError: (error: unknown) => void): () => void {
			return settling.onSettled((settled) => {
				queue = queue.then(() => apply(settled)).catch(onError);
				return queue;
			});
		},
	};
}

/**
 * Startup step after `harness.resume()`: catch the dispatch list up with what changed while the
 * core was down. A listing with a seq goes through the bridge like any event, so a turn that
 * finished in the gap is recorded and a block that was already handed to the model is not handed
 * over again. A job left `stopping` by the last process is settled, and one `due` whose agent is at
 * rest is stopped, so a reclaim a crash cut short neither leaves its window open nor reads as a vanished agent.
 * `dormant` names the agents the agent side lists with no process, since they ended with soma, and no status, so their
 * jobs keep the last one soma recorded. A job among them that was in a turn lost it: the turn is recorded over, once,
 * as one with no outcome. The human is told once of those that were not done or failed, with which had a turn cut.
 */
export async function reconcileDispatches(
	conversation: Conversation,
	agents: AgentPort,
	context: Context,
	dormant: readonly string[] = [],
) {
	// Only jobs the listing could have seen: one dispatched while it ran is missing from it, not gone.
	const known = await conversation.commit(
		async (tx) => new Set((await tx.doc(Dispatches, conversation.id)).jobs.map((job) => job.agent)),
		context,
	);
	const listed = await agents.list();
	const bridge = eventBridge(conversation, agents, context);
	for (const { name, status, seq } of listed) {
		if (status !== undefined && seq !== undefined) await bridge.handle({ agent: name, status, seq });
	}
	const armed = await conversation.commit(async (tx) => {
		const doc = await tx.doc(Dispatches, conversation.id);
		const before = doc.jobs.map((job) => job.status.state);
		const reconciled = reconcile(doc.jobs, listed);
		doc.jobs = doc.jobs.map((job, index) => (known.has(job.agent) ? (reconciled[index] ?? job) : job));
		// Told in the commit that marks it, so a restart finds the job already failed and tells it no more.
		for (const [index, job] of doc.jobs.entries()) {
			if (job.status.state !== "error" || before[index] === "error" || before[index] === "done") continue;
			await tx.appendEntry(
				conversation.id,
				noticeEntry("report", "outcome", `agent ${job.agent}（卡片 ${job.card}）不見了，這件工作沒有做完。`),
			);
			await tx.appendEntry(conversation.id, {
				kind: JOB_DONE,
				data: { agent: job.agent, card: job.card, state: "error", outcome: "失敗", notified: true },
			});
		}
		// In the same commit, so the restart tells it once, and the next one finds the cut turn over and records no more.
		const asleep = doc.jobs
			.filter((job) => known.has(job.agent) && dormant.includes(job.agent) && unfinished(job.status))
			.map((job) => ({ agent: job.agent, card: job.card, cut: turning(job.status) }));
		const cut = asleep.filter((job) => job.cut);
		for (const { agent, card } of cut) {
			const index = doc.jobs.findIndex((job) => job.agent === agent);
			const { handedOver: _forgotten, ...rest } = doc.jobs[index] as Job;
			doc.jobs[index] = { ...rest, status: CUT, outcome: "未知" };
			// Told by the notice below, which names it cut.
			await tx.appendEntry(conversation.id, {
				kind: JOB_DONE,
				data: { agent, card, state: "done", outcome: "未知", notified: true },
			});
		}
		if (asleep.length > 0) {
			await tx.appendEntry(
				conversation.id,
				noticeEntry("report", cut.length > 0 ? "action" : "ambient", dormantNotice(asleep, cut)),
			);
		}
		return doc.jobs
			.filter((job) => job.reclaim?.phase === "due" || job.reclaim?.phase === "stopping")
			.map((job) => job.agent);
	}, context);
	const reclaim = reclaimer(conversation, agents, context);
	for (const agent of armed) await reclaim(agent, true);
}
