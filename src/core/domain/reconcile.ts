import type { AgentListing, AgentState } from "../../ports/agent.ts";
import type { Cut } from "../../ports/handover.ts";
import type { DispatchList, Job } from "./dispatch.ts";

/**
 * Brings each job's status up to what the agent side lists now. The listing is the
 * truth, so a status is replaced outright rather than walked through `transition`:
 * a core that was down can miss every step in between. A job whose agent is no
 * longer listed failed unless it had already finished; jobs are never added here,
 * since the agent side also holds agents soma did not dispatch. A listed status other
 * than blocked forgets the block last handed over, as an observed one does, so the
 * same prompt asked again is handed over again. A job whose agent soma set out to stop is
 * stopped, not failed, once the agent is no longer listed: the stop went through, perhaps
 * before a restart could record it. One a deferral is starting again is left to that deferral,
 * whose start may not have gone out yet.
 */
export function reconcile(jobs: DispatchList, listed: readonly AgentListing[]): DispatchList {
	const byName = new Map(listed.map((agent) => [agent.name, agent]));
	return jobs.map((job) => {
		const agent = byName.get(job.agent);
		if (agent === undefined) {
			const phase = job.reclaim?.phase;
			if (phase === "resuming") return job;
			if (phase === "stopping" || phase === "stopped" || phase === "failed") {
				return phase === "stopped" ? job : { ...job, reclaim: { phase: "stopped" } };
			}
			if (job.status.state === "done" || job.status.state === "error") return job;
			return { ...job, status: { state: "error", msg: "agent is gone" } };
		}
		if (agent.status === undefined) return job;
		if (agent.status.state === "blocked") return { ...job, status: agent.status };
		const { handedOver: _forgotten, ...rest } = job;
		return { ...rest, status: agent.status };
	});
}

/** Whether a job in this status had a turn running, which an agent that ended with soma lost. */
export const turning = (status: AgentState) =>
	status.state === "working" || (status.state === "blocked" && status.kind !== "auth");

/** Whether a job in this status still had work to go on with: one that was neither done nor failed. */
export const unfinished = (status: AgentState) => status.state !== "done" && status.state !== "error";

/** The status of a job whose turn a restart cut short: over, with no reply to read an outcome from. */
export const CUT: AgentState = { state: "done", msg: "the turn was cut short when soma restarted" };

/** The status of a job a handover cut the turn of and that did not land: over, with no reply to read an outcome from. */
export const HANDOVER_CUT: AgentState = {
	state: "done",
	msg: "the turn was cut short by a handover that did not land",
};

/** What a job recorded in a turn lost when it moved with no `show_job` to say so: its turn, and the prompt it waited on. */
export function cutOf(status: AgentState): Cut | undefined {
	if (!turning(status)) return undefined;
	return status.state === "blocked" && status.msg !== undefined ? { prompt: status.msg } : {};
}

/** What was cut as the human reads it. A prompt is quoted without its options, which nothing can choose any more. */
export function cutSentence({ prompt }: Cut): string {
	return prompt === undefined
		? "Its running turn was cut."
		: `The permission prompt it was waiting on was cancelled, and its turn with it: "${prompt.replace(/\n1\. [\s\S]*$/, "")}".`;
}

/** The same in the notice of a move: nothing waits in the window, and how to go on is the human's to say there. */
export const cutInWindow = (cut: Cut) =>
	` ${cutSentence(cut)} ${cut.prompt === undefined ? "Tell" : "The window's claude will not ask again: tell"} it in the ` +
	"window how to go on.";

/**
 * The one notice of a restart whose agent side left unfinished jobs dormant, naming each and the ones whose turn the
 * restart cut short; each goes on in its session with a reply.
 */
export function dormantNotice(
	jobs: readonly Pick<Job, "agent" | "card">[],
	cut: readonly Pick<Job, "agent" | "card">[],
): string {
	const named = (each: readonly Pick<Job, "agent" | "card">[]) =>
		each.map((job) => `agent ${job.agent}（卡片 ${job.card}）`).join("、");
	const head =
		`soma 重新啟動後，${jobs.length} 件工作的 agent 停著，session 都還在：${named(jobs)}。` +
		"回覆其中一件，它就在原本的 session 裡接著做，之前的對話都還在。";
	return cut.length === 0
		? `${head}沒有哪一輪被重啟打斷。`
		: `${head}其中 ${named(cut)}正在做的那一輪被重啟打斷了，沒有做完；要它接著做，就回覆它。`;
}
