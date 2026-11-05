import type { Context } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import type { AgentListing, AgentPort } from "../../../ports/agent.ts";
import { reclaimFailedNotice } from "../../domain/defer.ts";
import type { Job, Reclaim } from "../../domain/dispatch.ts";
import { noticeEntry } from "../../notice.ts";
import { Deferrals } from "../defer/deferrals.ts";
import { Dispatches } from "./index.ts";

/**
 * Stops an agent that deferred an instruction once it is at rest, so a waiting agent holds no hangar slot (ARCHITECTURE.md
 * "Agent-deferred instructions"). Host code, like the event bridge: no model call. The job's `reclaim` moves from `due`
 * to `stopping` in a commit before `stop`, and to `stopped` after it, so only one caller stops it, and a restart that
 * finds `stopping` knows a stop may have gone out. The agent's state is read fresh from the listing just before, so one
 * the human or the agent has made busy since its last report is left alone until its next idle or done.
 */
export function reclaimer(conversation: Conversation, agents: Pick<AgentPort, "list" | "stop">, context: Context) {
	const read = (agent: string) =>
		conversation.commit(async (tx) => {
			const found = (await tx.doc(Dispatches, conversation.id)).jobs.find((job) => job.agent === agent);
			// Copied out as JSON: a doc is a live proxy only valid inside its commit.
			return found && (JSON.parse(JSON.stringify(found)) as Job);
		}, context);

	/** Moves the job from `from` to `to`, unless another caller moved it first; a notice goes in the same commit. */
	const move = (agent: string, from: Reclaim["phase"], to: Reclaim, notice?: string) =>
		conversation.commit(async (tx) => {
			const doc = await tx.doc(Dispatches, conversation.id);
			const index = doc.jobs.findIndex((job) => job.agent === agent);
			const current = doc.jobs[index];
			if (current?.reclaim?.phase !== from) return false;
			doc.jobs[index] = { ...current, reclaim: to };
			if (notice !== undefined) await tx.appendEntry(conversation.id, noticeEntry("report", "ambient", notice));
			return true;
		}, context);

	const listing = async (agent: string): Promise<AgentListing | undefined> =>
		(await agents.list()).find((each) => each.name === agent);

	/**
	 * Settles a job left `stopping` whose agent is still listed, so no stop landed: with a deferral of the agent still
	 * pending, it stays `stopping` for the stop to go out now when `atRest`, and is `due` again otherwise. With none, as
	 * when the deferral fell due while soma was down and ended then, the job is no longer due to be stopped at all.
	 * True when the stop is to go out.
	 */
	const settleStopping = (agent: string, atRest: boolean) =>
		conversation.commit(async (tx) => {
			const doc = await tx.doc(Dispatches, conversation.id);
			const index = doc.jobs.findIndex((job) => job.agent === agent);
			const current = doc.jobs[index];
			if (current?.reclaim?.phase !== "stopping") return false;
			const { items } = await tx.doc(Deferrals, conversation.id);
			if (Object.values(items).some((item) => item.agent === agent)) {
				if (atRest) return true;
				doc.jobs[index] = { ...current, reclaim: { phase: "due" } };
				return false;
			}
			const { reclaim: _disarmed, ...rest } = current;
			doc.jobs[index] = rest;
			return false;
		}, context);

	/**
	 * Stops `agent` when its job is `due` and the agent is listed idle or done. With `recover`, as a restart calls it, a
	 * job left `stopping` is settled too: stopped when the agent is gone, and otherwise, its window being open so no stop
	 * landed, as `settleStopping` says. A `stop` that fails ends `failed` with one notice, unless the agent is no longer
	 * listed after it; it is not tried again.
	 */
	return async function reclaim(agent: string, recover = false): Promise<void> {
		const phase = (await read(agent))?.reclaim?.phase;
		if (phase !== "due" && !(recover && phase === "stopping")) return;
		let listed: AgentListing | undefined;
		try {
			listed = await listing(agent);
		} catch {
			// Nothing went out: the next idle or done, or the next restart, tries again.
			return;
		}
		if (listed === undefined) {
			// A due agent that left on its own is gone, which the restart's reconcile reports, as for any job.
			if (phase === "stopping") await move(agent, "stopping", { phase: "stopped" });
			return;
		}
		const state = listed.status?.state;
		const atRest = state === "idle" || state === "done";
		if (phase === "stopping" && !(await settleStopping(agent, atRest))) return;
		if (!atRest) return;
		if (phase === "due" && !(await move(agent, "due", { phase: "stopping" }))) return;
		try {
			await agents.stop(agent);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const gone = await listing(agent).then(
				(after) => after === undefined,
				() => false,
			);
			if (!gone) {
				const job = await read(agent);
				await move(
					agent,
					"stopping",
					{ phase: "failed", error: message },
					reclaimFailedNotice(agent, job?.card ?? agent, message),
				);
				return;
			}
		}
		await move(agent, "stopping", { phase: "stopped" });
	};
}
