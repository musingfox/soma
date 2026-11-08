import { type AgentListing, type AgentPort, type AgentStatusEvent, PromptRefused } from "../../ports/agent.ts";
import type {
	AgentHandover,
	HandoverOutcome,
	HandoverRefusal,
	HeldSession,
	SessionGiver,
	SessionTaker,
} from "../../ports/handover.ts";

export interface HandoverAgentPortOptions {
	/** Every job starts here, and stays until it is handed over. */
	readonly from: AgentPort & SessionGiver;
	/** Where a job goes when it is handed over; also the side that holds the foreign agents. */
	readonly to: AgentPort & SessionTaker;
}

/** What a handover says when there is nothing to hand over to, or nothing to hand over. */
export const noHandover = (refusal: HandoverRefusal, reason: string): AgentHandover => ({
	handOver: async () => ({ handedOver: false, refusal, reason }),
});

/**
 * Jobs on two agent sides at once, below the core, which goes on seeing one AgentPort: each job runs on `from` until it
 * is handed over, and on `to` from then on. `from` records which it gave up, so a restart routes each job as the soma
 * before it did, and nothing of a job not handed over goes to `to`: the listing asks it nothing until one has been.
 * Statuses of `to` are passed on only for jobs handed over, since its side may hold other agents of the same name. One
 * handover runs at a time. While one is under way its job is listed with no status and takes no prompt, so the core sees
 * neither a vanished agent nor the trust dialog the handover is about to answer (ARCHITECTURE.md "The ACP implementation").
 */
export function createHandoverAgentPort({ from, to }: HandoverAgentPortOptions): AgentPort & AgentHandover {
	const moved = new Map<string, HeldSession>();
	const moving = new Map<string, HeldSession>();
	const loading = from.released().then((sessions) => {
		for (const session of sessions) moved.set(session.name, session);
	});
	const side = async (agent: string) => {
		await loading;
		return moved.has(agent) ? to : from;
	};
	const refused = (refusal: HandoverRefusal, reason: string): HandoverOutcome => ({
		handedOver: false,
		refusal,
		reason,
	});

	async function handOver(agent: string): Promise<HandoverOutcome> {
		await loading;
		if (moved.has(agent)) return refused("not_acp", `${agent} is on rex already, in its window of the same name`);
		const held = await from.releasable(agent);
		if ("refusal" in held) return refused(held.refusal, held.reason);
		const unfit = await to.takeable(held).catch((error: Error) => error.message);
		if (unfit !== undefined) return refused("cannot_resume", unfit);
		moving.set(agent, held);
		try {
			const released = await from.release(agent);
			if ("refusal" in released) return refused(released.refusal, released.reason);
			const taken = await to.take(held);
			moved.set(agent, held);
			return { handedOver: true, ...taken, sessionId: held.claudeSession };
		} catch (error) {
			await from.reinstate(agent);
			return refused(
				"cannot_resume",
				`${(error as Error).message}. Its ACP process has ended and the job stays on ACP: its next prompt starts it again in its session`,
			);
		} finally {
			moving.delete(agent);
		}
	}

	let queue: Promise<unknown> = Promise.resolve();

	return {
		handOver(agent: string): Promise<HandoverOutcome> {
			const run = queue.then(() => handOver(agent));
			queue = run.catch(() => {});
			return run;
		},

		async start(request) {
			await loading;
			if (moved.has(request.name)) throw new Error(`${request.name} was handed over: its window is its agent`);
			return from.start(request);
		},

		/** Goes on in a window as a rex job does, with the model the session last ran on and in the worktree it holds. */
		async resume(request) {
			await loading;
			const session = moved.get(request.name);
			if (moving.has(request.name)) throw new Error(`${request.name} is being handed over`);
			if (session === undefined) return from.resume(request);
			await to.take(session);
		},

		async list(): Promise<readonly AgentListing[]> {
			await loading;
			// Taken before the sides are asked: a move that ends while they answer is in neither answer, and a job missing
			// from a listing reads as gone.
			const moves = [...moving.values()];
			const [here, there] = await Promise.all([from.list(), moved.size === 0 ? [] : to.list()]);
			const onRex = there.filter((agent) => moved.has(agent.name));
			const named = new Set([...here, ...onRex].map((agent) => agent.name));
			return [
				...here,
				...moves
					.filter((session) => !named.has(session.name))
					.map((session) => ({ name: session.name, sessionId: session.sessionId })),
				...onRex,
			];
		},

		async prompt(agent, text) {
			await loading;
			if (moving.has(agent)) throw new PromptRefused(`${agent} is being handed over`);
			return (await side(agent)).prompt(agent, text);
		},

		onStatus(listener: (event: AgentStatusEvent) => void): () => void {
			const offFrom = from.onStatus(listener);
			const offTo = to.onStatus((event) => {
				if (moved.has(event.agent)) listener(event);
			});
			return () => {
				offFrom();
				offTo();
			};
		},

		// While it moves, `from` still reads the session's transcript.
		readResult: async (agent) => (await side(agent)).readResult(agent),

		async readScreen(agent) {
			await loading;
			if (moving.has(agent)) throw new Error(`${agent} is being handed over`);
			return (await side(agent)).readScreen(agent);
		},

		async respond(agent, answer) {
			await loading;
			if (moving.has(agent)) return { sent: false, refusal: "not_blocked" };
			return (await side(agent)).respond(agent, answer);
		},

		async stop(agent) {
			await loading;
			if (moving.has(agent)) throw new Error(`${agent} is being handed over`);
			return (await side(agent)).stop(agent);
		},

		listForeign: () => to.listForeign(),
		onForeignStatus: (listener) => to.onForeignStatus(listener),
		readForeignResult: (id) => to.readForeignResult(id),
		readForeignScreen: (id) => to.readForeignScreen(id),
		respondForeign: (id, answer) => to.respondForeign(id, answer),
		promptForeign: (id, text) => to.promptForeign(id, text),
	};
}
