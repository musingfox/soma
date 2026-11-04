import type { AgentListing } from "../../ports/agent.ts";
import type { DispatchList } from "./dispatch.ts";

/**
 * Brings each job's status up to what the agent side lists now. The listing is the
 * truth, so a status is replaced outright rather than walked through `transition`:
 * a core that was down can miss every step in between. A job whose agent is no
 * longer listed failed unless it had already finished; jobs are never added here,
 * since the agent side also holds agents soma did not dispatch. A listed status other
 * than blocked forgets the block last handed over, as an observed one does, so the
 * same prompt asked again is handed over again. A job whose agent soma set out to stop is
 * stopped, not failed, once the agent is no longer listed: the stop went through, perhaps
 * before a restart could record it.
 */
export function reconcile(jobs: DispatchList, listed: readonly AgentListing[]): DispatchList {
	const byName = new Map(listed.map((agent) => [agent.name, agent]));
	return jobs.map((job) => {
		const agent = byName.get(job.agent);
		if (agent === undefined) {
			const phase = job.reclaim?.phase;
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
