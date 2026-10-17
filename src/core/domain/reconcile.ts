import type { AgentListing } from "../../ports/agent.ts";
import type { DispatchList } from "./dispatch.ts";

/**
 * Brings each job's status up to what the agent side lists now. The listing is the
 * truth, so a status is replaced outright rather than walked through `transition`:
 * a core that was down can miss every step in between. A job whose agent is no
 * longer listed failed unless it had already finished; jobs are never added here,
 * since the agent side also holds agents soma did not dispatch.
 */
export function reconcile(jobs: DispatchList, listed: readonly AgentListing[]): DispatchList {
	const byName = new Map(listed.map((agent) => [agent.name, agent]));
	return jobs.map((job) => {
		const agent = byName.get(job.agent);
		if (agent === undefined) {
			if (job.status.state === "done" || job.status.state === "error") return job;
			return { ...job, status: { state: "error", msg: "agent is gone" } };
		}
		return agent.status === undefined ? job : { ...job, status: agent.status };
	});
}
