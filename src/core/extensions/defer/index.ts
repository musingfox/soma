import type { Context } from "@earendil-works/chord/context";
import { type Conversation, defineExtension, defineTask, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { type AgentPort, PromptRefused } from "../../../ports/agent.ts";
import type { DeferReply, DeferRequest } from "../../../ports/defer.ts";
import { type Deferred, deferAt, deferNotice, deferredPrompt } from "../../domain/defer.ts";
import { noticeEntry } from "../../notice.ts";
import { Dispatches } from "../dispatch/index.ts";
import { reclaimer } from "../dispatch/reclaim.ts";
import { Deferrals } from "./deferrals.ts";

export { Deferrals };

/** How a deferral ended: sent, or why it was not, each but `sent` told to the human in one notice. */
export type DeferOutcome = "sent" | "gone" | "unresumed" | "unsure" | "failed";

type Checkpoint =
	| { phase: "wait"; at: number; tries: number; error?: string }
	// Committed before the agent, gone when this fell due, is started again in `session`, its job held `resuming`.
	// `until` bounds the tries to list the agent before it is started; past it, the agent is waited for unstarted.
	| { phase: "resuming"; tries: number; session: string; until: number }
	// Committed once the start went out, or a window of the agent's name was found: a rerun starts nothing. `until`
	// bounds the wait for the agent to be listed at rest.
	| { phase: "ready"; tries: number; until: number }
	// Committed before the prompt goes out: a rerun that finds it cannot tell whether the agent got it.
	| { phase: "sending"; tries: number };

type Runtime = TaskRuntime<Deferred, Checkpoint, DeferOutcome, object>;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Waits `ms` on the task's timer; throws once the run is over, as when soma shuts down. */
async function pause(runtime: Runtime, ms: number): Promise<void> {
	runtime.signal.throwIfAborted();
	await new Promise<void>((resolve) => {
		const done = () => {
			disarm();
			runtime.signal.removeEventListener("abort", done);
			resolve();
		};
		const disarm = runtime.setTimer(done, ms);
		runtime.signal.addEventListener("abort", done);
	});
	runtime.signal.throwIfAborted();
}

/**
 * Marks deferral `id` of `agent` as no longer being sent. Its job, held `sending` while a prompt may go out, is due again
 * once no deferral of the agent is being sent. True when this moved it to `due`.
 */
async function release(tx: Tx, conversation: Conversation["id"], id: string, agent: string): Promise<boolean> {
	const { items } = await tx.doc(Deferrals, conversation);
	const item = items[id];
	if (item?.sending) {
		const { sending: _sent, ...rest } = item;
		items[id] = rest;
	}
	if (Object.values(items).some((each) => each.agent === agent && each.sending)) return false;
	const doc = await tx.doc(Dispatches, conversation);
	const index = doc.jobs.findIndex((job) => job.agent === agent);
	const current = doc.jobs[index];
	if (current?.reclaim?.phase !== "sending") return false;
	doc.jobs[index] = { ...current, reclaim: { phase: "due" } };
	return true;
}

/**
 * Takes deferral `id` of `agent` off the pending ones. With none of the agent's left, its job is no longer due to be
 * stopped, so an agent that got its instruction while still open is not stopped when that turn ends, and a failed stop
 * is forgotten; a stopped one stays stopped. With some left, it is due again unless one is being sent: true when this
 * made it due. A job this deferral held `resuming` is `stopped` when the agent is `gone` again, as one soma stopped,
 * and otherwise taken as one a prompt went to.
 */
async function settle(
	tx: Tx,
	conversation: Conversation["id"],
	id: string,
	agent: string,
	gone = false,
): Promise<boolean> {
	const { items } = await tx.doc(Deferrals, conversation);
	const resumed = items[id]?.resuming === true;
	delete items[id];
	const doc = await tx.doc(Dispatches, conversation);
	const index = doc.jobs.findIndex((job) => job.agent === agent);
	const held = doc.jobs[index];
	if (resumed && held?.reclaim?.phase === "resuming") {
		doc.jobs[index] = { ...held, reclaim: { phase: gone ? "stopped" : "sending" } };
		if (gone) return false;
	}
	if (Object.values(items).some((item) => item.agent === agent)) return release(tx, conversation, id, agent);
	const current = doc.jobs[index];
	const phase = current?.reclaim?.phase;
	if (current === undefined || (phase !== "due" && phase !== "sending" && phase !== "failed")) return false;
	const { reclaim: _disarmed, ...rest } = current;
	doc.jobs[index] = rest;
	return false;
}

export interface DeferOptions {
	/** How long after a prompt that failed, say to a busy agent, it is tried again. */
	readonly retryMs?: number;
	/** Prompts tried, the first included, before the human is told it was not sent. */
	readonly tries?: number;
	/** How long an agent started again may take to be listed at rest before the human is told it was not sent. */
	readonly readyMs?: number;
	/** Pause between listings while an agent started again is not at rest yet. */
	readonly pollMs?: number;
	/**
	 * Stops `agent` if its job is due and it is listed at rest, as `reclaimer` does; called when a rerun has made a job
	 * due again, which no status event may follow. The host runs it only after its reconcile, so it never takes a stop
	 * the reconcile has under way for one a crash cut short, nor the other way round.
	 */
	readonly reclaim?: (agent: string) => Promise<void>;
}

/**
 * Deferrals an agent asks for with `soma defer` (ARCHITECTURE.md "Event bridge": host code, not the model). Each is a
 * background task of the root conversation that sleeps until `at` and then prompts the agent through `agents`,
 * submitting nothing to the conversation. The prompt goes out at most once: the task commits `sending` before it, so a
 * crash between the prompt and the terminal commit ends the rerun with a notice instead of a second prompt. An accepted
 * defer arms its job's reclaim, and stops an agent already at rest. The `sending` commit also moves a due job to
 * `sending`, after checking its phase in the same commit, so a reclaim and a prompt never both go ahead: an idle the
 * agent reports between the prompt and its end stops nothing. An agent gone at fire time, stopped by soma or closed by
 * hand, is started again in its session (`resume`, past the hangar cap) under the `resuming` checkpoint, and prompted
 * once it is listed at rest, as a dispatched agent's launch prompt waits for its first idle; one soma was stopping
 * takes the gone path, since the listing cannot tell a stop that never went out.
 */
export function deferExtension(
	agents: Pick<AgentPort, "list" | "prompt" | "resume" | "stop">,
	options: DeferOptions = {},
) {
	const retryMs = options.retryMs ?? 30_000;
	const tries = options.tries ?? 20;
	const readyMs = options.readyMs ?? 120_000;
	const pollMs = options.pollMs ?? 1_000;

	const listing = async (agent: string) => (await agents.list()).find((each) => each.name === agent);

	/** What every phase of deferral `id` does to end, to try again later, and to send its prompt, `tried` times tried. */
	function steps(id: string, item: Deferred, tried: number, runtime: Runtime, context: Context) {
		const ending = async (tx: Tx, outcome: DeferOutcome, notice?: string, gone = false) => {
			await settle(tx, runtime.conversationId, id, item.agent, gone);
			if (notice !== undefined) await tx.appendEntry(runtime.conversationId, noticeEntry("report", notice));
			return { status: "terminal" as const, outcome: { status: "completed" as const, result: outcome } };
		};
		const end = (outcome: DeferOutcome, notice?: string, gone = false) =>
			runtime.commit((tx) => ending(tx, outcome, notice, gone), context);
		const retry = (error: unknown) => {
			const message = errorText(error);
			const count = tried + 1;
			if (count >= tries) return end("failed", deferNotice.failed(id, item, count, message));
			const until = runtime.now() + retryMs;
			return runtime.commit(async (tx) => {
				// A prompt refused before it typed holds the job no longer: it may be stopped while this waits.
				await release(tx, runtime.conversationId, id, item.agent);
				return { status: "sleeping", until, checkpoint: { phase: "wait", at: until, tries: count, error: message } };
			}, context);
		};
		// Another deferral of the agent holds its job while it starts the agent again or prompts it.
		const busy = () => new Error(`agent ${item.agent} is being started again for another deferred instruction`);

		/** Prompts the listed agent, at most once, its job held `sending` from the commit before. */
		async function send(): Promise<void> {
			let sending = false;
			let held = false;
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(Dispatches, runtime.conversationId);
				const index = doc.jobs.findIndex((each) => each.agent === item.agent);
				const current = doc.jobs[index];
				const phase = current?.reclaim?.phase;
				// A reclaim that committed `stopping` since the listing wins, and nothing is sent.
				if (phase === "stopping") return ending(tx, "gone", deferNotice.stopping(id, item));
				const { items } = await tx.doc(Deferrals, runtime.conversationId);
				const own = items[id];
				if (phase === "resuming" && !own?.resuming) {
					held = true;
					return undefined;
				}
				// A stopped one listed again was reopened by the human: it is the agent, and the bridge sees it from now on.
				if (current !== undefined && (phase === "due" || phase === "stopped" || phase === "resuming")) {
					doc.jobs[index] = { ...current, reclaim: { phase: "sending" } };
				}
				if (own !== undefined) {
					const { resuming: _started, ...rest } = own;
					items[id] = { ...rest, sending: true };
				}
				sending = true;
				return { status: "running", checkpoint: { phase: "sending", tries: tried } };
			}, context);
			if (held) return retry(busy());
			if (!sending) return;
			try {
				await agents.prompt(item.agent, deferredPrompt(id, item));
			} catch (error) {
				// Tried again only when the adapter refused before it typed, as rex does for a busy agent: any other
				// failure may come after the text reached the agent, and the prompt goes out at most once.
				if (error instanceof PromptRefused) return retry(error);
				return end("unsure", deferNotice.unsure(id, item, errorText(error)));
			}
			await end("sent");
		}

		/** Holds the job `resuming` for this deferral, unless another holds it, and moves on to starting the agent. */
		async function resume(): Promise<void> {
			let held = false;
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(Dispatches, runtime.conversationId);
				const index = doc.jobs.findIndex((each) => each.agent === item.agent);
				const current = doc.jobs[index];
				const phase = current?.reclaim?.phase;
				if (current === undefined) return ending(tx, "gone", deferNotice.gone(id, item));
				if (phase === "stopping") return ending(tx, "gone", deferNotice.stopping(id, item));
				if (phase === "resuming" || phase === "sending") {
					held = true;
					return undefined;
				}
				doc.jobs[index] = { ...current, reclaim: { phase: "resuming" } };
				const { items } = await tx.doc(Deferrals, runtime.conversationId);
				const own = items[id];
				if (own !== undefined) items[id] = { ...own, resuming: true };
				const until = runtime.now() + readyMs;
				return {
					status: "running",
					checkpoint: { phase: "resuming", tries: tried, session: current.sessionId, until },
				};
			}, context);
			if (held) await retry(busy());
		}

		return { end, retry, send, resume };
	}

	const Deferral = defineTask<Deferred, Checkpoint, DeferOutcome>({
		name: "soma.defer",
		version: 1,
		initial: ({ at }) => ({ phase: "wait", at, tries: 0 }),
		phases: {
			wait: async (task, runtime, context) => {
				const checkpoint = task.state.checkpoint;
				if (runtime.now() < checkpoint.at) return runtime.sleepUntil(checkpoint.at, checkpoint, context);
				const id = String(task.id);
				const { end, retry, send, resume } = steps(id, task.input, checkpoint.tries, runtime, context);
				const job = (await runtime.snapshot(Dispatches, runtime.conversationId, context))?.jobs.find(
					(each) => each.agent === task.input.agent,
				);
				// soma was stopping the agent: the listing cannot tell a stop that never went out.
				if (job?.reclaim?.phase === "stopping") return end("gone", deferNotice.stopping(id, task.input));
				let listed: boolean;
				try {
					listed = (await listing(task.input.agent)) !== undefined;
				} catch (error) {
					return retry(error);
				}
				// Gone, as soma stopped it or the human closed its window: it is started again in its session first.
				return listed ? send() : resume();
			},
			// Listed first, so a rerun never starts an agent again that a start a crash cut short has started already. A
			// listing that fails is no sign the agent is gone: past `until` it is left to `ready`, which starts nothing.
			resuming: async (task, runtime, context) => {
				const { tries: tried, session, until } = task.state.checkpoint;
				const id = String(task.id);
				const { end } = steps(id, task.input, tried, runtime, context);
				const unresumed = (error: unknown) =>
					end("unresumed", deferNotice.unresumed(id, task.input, errorText(error)), true);
				for (;;) {
					let listed: boolean;
					try {
						listed = (await listing(task.input.agent)) !== undefined;
					} catch {
						if (runtime.now() >= until) break;
						await pause(runtime, pollMs);
						continue;
					}
					if (!listed) {
						try {
							await agents.resume({ name: task.input.agent, card: task.input.card, sessionId: session });
						} catch (error) {
							// A window of the name made since, by the human or by this start before it failed, is the agent; one
							// a listing that fails cannot rule out is looked for by `ready`.
							const after = await listing(task.input.agent).then(
								(found) => found !== undefined,
								() => undefined,
							);
							if (after === false) return unresumed(error);
						}
					}
					break;
				}
				// Timed from the start, so a start a crash cut short long ago still gets the whole wait.
				return runtime.commit(
					() => ({ status: "running", checkpoint: { phase: "ready", tries: tried, until: runtime.now() + readyMs } }),
					context,
				);
			},
			// The agent's window is up: it is prompted once it is listed idle or done, which is when claude takes a prompt.
			// Only a listing that answers decides, past `until` too: one that fails is no sign of the agent either way.
			ready: async (task, runtime, context) => {
				const { tries: tried, until } = task.state.checkpoint;
				const id = String(task.id);
				const { end, send } = steps(id, task.input, tried, runtime, context);
				for (; ; await pause(runtime, pollMs)) {
					let state: string;
					try {
						const found = await listing(task.input.agent);
						if (found === undefined) return end("gone", deferNotice.closed(id, task.input), true);
						state = found.status?.state ?? "without a status";
					} catch {
						continue;
					}
					if (state === "idle" || state === "done") return send();
					if (runtime.now() >= until) return end("failed", deferNotice.unready(id, task.input, readyMs / 1000, state));
				}
			},
			// Reached only by a rerun: the run that committed `sending` went on to prompt without ending.
			sending: async (task, runtime, context) => {
				const id = String(task.id);
				let due = false;
				await runtime.commit(async (tx) => {
					due = await settle(tx, runtime.conversationId, id, task.input.agent);
					await tx.appendEntry(runtime.conversationId, noticeEntry("report", deferNotice.unsure(id, task.input)));
					return { status: "terminal", outcome: { status: "completed", result: "unsure" } };
				}, context);
				// The process that typed the prompt, if it did, is dead: an agent the listing shows at rest now is not one
				// just pasted to. Not awaited: the task has ended, and a stop that hangs must not hold it.
				if (due) void options.reclaim?.(task.input.agent).catch(() => {});
			},
		},
		abort: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				await settle(tx, runtime.conversationId, String(task.id), task.input.agent);
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});

	/**
	 * Accepts `request` when its agent names a job of the conversation's dispatch list, and creates its task in the same
	 * commit, with the job due to be stopped; refuses it with a reason the agent can read otherwise. An agent the listing
	 * shows idle or done already is stopped before the reply, as one at work is when its turn ends; one that runs
	 * `soma defer` itself is at work, so it is not stopped under its own command.
	 */
	async function defer(conversation: Conversation, request: DeferRequest, context: Context): Promise<DeferReply> {
		const setAt = Date.now();
		let at: number;
		try {
			at = deferAt(request.at, setAt);
		} catch (error) {
			return { accepted: false, reason: (error as Error).message };
		}
		const instruction = request.instruction.trim();
		if (instruction === "") return { accepted: false, reason: "the instruction is empty" };
		const { reply, agent } = await conversation.commit(async (tx) => {
			const doc = await tx.doc(Dispatches, conversation.id);
			const index = doc.jobs.findIndex((each) => each.card === request.agent);
			const job = doc.jobs[index];
			if (job === undefined) {
				const reply: DeferReply = {
					accepted: false,
					reason: `soma dispatched no agent for card "${request.agent}" (SOMA_AGENT); it defers instructions only for agents it dispatched`,
				};
				return { reply, agent: undefined };
			}
			const item: Deferred = { agent: job.agent, card: job.card, instruction, at, setAt };
			const id = await tx.createTask(Deferral, item, { ownership: { kind: "conversation" }, background: true });
			(await tx.doc(Deferrals, conversation.id)).items[String(id)] = item;
			// A failed stop is tried once more for a new deferral; one stopped or under way is left as it is.
			const phase = job.reclaim?.phase;
			if (phase === undefined || phase === "failed") doc.jobs[index] = { ...job, reclaim: { phase: "due" } };
			const reply: DeferReply = { accepted: true, id: String(id), at: new Date(at).toISOString() };
			return { reply, agent: job.agent };
		}, context);
		// The defer is committed whatever the reclaim meets: a job left due is stopped at its next idle or done, or by the
		// next restart's reconcile.
		if (agent !== undefined) await reclaimer(conversation, agents, context)(agent).catch(() => {});
		return reply;
	}

	return { extension: defineExtension({ name: "soma.defer", tasks: [Deferral] }), defer };
}
