import type { Context } from "@earendil-works/chord/context";
import {
	type Conversation,
	defineExtension,
	defineTask,
	type TaskId,
	type TaskRuntime,
	type Tx,
} from "@earendil-works/pi-durable";
import { type AgentPort, NotImplemented, PromptRefused } from "../../../ports/agent.ts";
import type { DeferReply, DeferRequest, HandoffRequest } from "../../../ports/defer.ts";
import type { LiveSession } from "../../../ports/live-session.ts";
import {
	type Deferred,
	deferAt,
	deferNotice,
	handoffName,
	handoffRefusal,
	heldSession,
	promptOf,
} from "../../domain/defer.ts";
import type { Job, Reclaim } from "../../domain/dispatch.ts";
import { noticeEntry } from "../../notice.ts";
import { Dispatches } from "../dispatch/index.ts";
import { reclaimer } from "../dispatch/reclaim.ts";
import { Deferrals } from "./deferrals.ts";

export { Deferrals };

/**
 * How a deferral ended: sent, or why it was not, each but `sent` told to the human in one notice: `cancelled`, the
 * move's. `open`: a hand-off whose session another claude still had open.
 */
export type DeferOutcome = "sent" | "gone" | "unresumed" | "unsure" | "failed" | "cancelled" | "open";

type Checkpoint =
	| { phase: "wait"; at: number; tries: number; error?: string }
	// Committed before the agent, gone when this fell due, is started again in `session`, its job held `resuming`.
	// `until` bounds the tries to list the agent before it is started; past it, the agent is waited for unstarted.
	| { phase: "resuming"; tries: number; session: string; until: number }
	// Committed once the start went out, or a window of the agent's name was found: a rerun starts nothing. `until`
	// bounds the wait for the agent to be listed at rest, and `readyMs` past it the wait for a listing that answers.
	// `started` when a start returned, so a notice never tells of one that failed or was never made.
	| { phase: "ready"; tries: number; until: number; started: boolean }
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
 * The job other than its own that holds a hand-off's session, as one soma dispatched in it, or none. A hand-off job of
 * the session is its own: accept gives every hand-off of a session the name of the hand-off job it has.
 */
const holderOf = (jobs: readonly Job[], session: string) =>
	jobs.find((job) => job.sessionId === session && job.handoff !== true);

/**
 * The job a hand-off's session becomes, held as `reclaim` says. Recorded only once its agent is there, so a resume that
 * fails leaves no job behind.
 */
const handoffJob = (item: Deferred, session: string, at: number, reclaim: Reclaim): Job => ({
	card: item.agent,
	agent: item.agent,
	sessionId: session,
	...(item.cwd !== undefined && { repo: item.cwd }),
	status: { state: "idle" },
	createdAt: new Date(at).toISOString(),
	decisions: [],
	handoff: true,
	reclaim,
});

/** `job` with `before`, the reclaim it had before a deferral held it `resuming`, absent when it had none. */
function unheld(job: Job, before: Reclaim | undefined): Job {
	const { reclaim: _held, ...rest } = job;
	return before === undefined ? rest : { ...rest, reclaim: before };
}

/**
 * Releases `agent`'s job from a hold `resuming` when no deferral that holds it is live: one whose task ended without
 * settling, as one faulted or rolled back to a release without the phase, never releases it. Such a deferral's item,
 * left pending, goes too. Called as the agent runs `soma defer`, so it is open: the job is left with no reclaim, not
 * the one it had before the hold, which may be `stopped`.
 */
async function unhold(tx: Tx, conversation: Conversation["id"], agent: string): Promise<void> {
	const doc = await tx.doc(Dispatches, conversation);
	const index = doc.jobs.findIndex((job) => job.agent === agent);
	const current = doc.jobs[index];
	if (current?.reclaim?.phase !== "resuming") return;
	const { items } = await tx.doc(Deferrals, conversation);
	for (const [id, item] of Object.entries(items)) {
		if (item.agent !== agent || item.resuming !== true) continue;
		const status = (await tx.task(Number(id) as TaskId))?.state.status;
		if (status !== undefined && status !== "completing" && status !== "terminal") return;
		delete items[id];
	}
	doc.jobs[index] = unheld(current, undefined);
}

/**
 * Takes deferral `id` of `agent` off the pending ones. With none of the agent's left, its job is no longer due to be
 * stopped, so an agent that got its instruction while still open is not stopped when that turn ends, and a failed stop
 * is forgotten; a stopped one stays stopped. With some left, it is due again unless one is being sent: true when this
 * made it due. A job this deferral held `resuming` gets back the reclaim it had before when the agent is `gone` again,
 * so it is `stopped` only if soma had stopped it, and is otherwise taken as one a prompt went to.
 */
async function settle(
	tx: Tx,
	conversation: Conversation["id"],
	id: string,
	agent: string,
	gone = false,
): Promise<boolean> {
	const { items } = await tx.doc(Deferrals, conversation);
	const own = items[id];
	const before = own?.before && { ...own.before };
	delete items[id];
	const doc = await tx.doc(Dispatches, conversation);
	const index = doc.jobs.findIndex((job) => job.agent === agent);
	const held = doc.jobs[index];
	if (own?.resuming === true && held?.reclaim?.phase === "resuming") {
		doc.jobs[index] = gone ? unheld(held, before) : { ...held, reclaim: { phase: "sending" } };
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
	/**
	 * The git repo root a hand-off's directory is in, which names its job, or undefined outside any repo; main.ts gives
	 * the file system's. Unset, every directory is taken as outside any repo.
	 */
	readonly repoRoot?: (cwd: string) => Promise<string | undefined>;
	/**
	 * The claude that still has a session open, looked for before a hand-off's session is resumed; main.ts gives the one
	 * that reads claude's pid files. Unset, no session is ever open.
	 */
	readonly liveSession?: LiveSession;
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
 * takes the gone path, since the listing cannot tell a stop that never went out, and so does one on an agent side
 * whose `resume` throws NotImplemented. A Claude Code session soma did not dispatch hands itself over the same way: at
 * fire time it becomes a job, resumed in the directory it sent and prompted with the launch rules before the
 * instruction.
 */
export function deferExtension(
	agents: Pick<AgentPort, "list" | "prompt" | "resume" | "stop">,
	options: DeferOptions = {},
) {
	const retryMs = options.retryMs ?? 30_000;
	const tries = options.tries ?? 20;
	const readyMs = options.readyMs ?? 120_000;
	const pollMs = options.pollMs ?? 1_000;
	const repoRoot = options.repoRoot ?? (async () => undefined);
	const liveSession = options.liveSession ?? (async () => undefined);

	const listing = async (agent: string) => (await agents.list()).find((each) => each.name === agent);

	/** A deferral whose job's move took it off the pending ones ends so when it wakes, doing nothing and telling nothing. */
	const cancelled = {
		status: "terminal" as const,
		outcome: { status: "completed" as const, result: "cancelled" as const },
	};

	/** What every phase of deferral `id` does to end, to try again later, and to send its prompt, `tried` times tried. */
	function steps(id: string, item: Deferred, tried: number, runtime: Runtime, context: Context) {
		const ending = async (tx: Tx, outcome: DeferOutcome, notice?: string, gone = false) => {
			await settle(tx, runtime.conversationId, id, item.agent, gone);
			if (notice !== undefined) await tx.appendEntry(runtime.conversationId, noticeEntry("report", "outcome", notice));
			return { status: "terminal" as const, outcome: { status: "completed" as const, result: outcome } };
		};
		const end = (outcome: DeferOutcome, notice?: string, gone = false) =>
			runtime.commit((tx) => ending(tx, outcome, notice, gone), context);
		// A hand-off that found its session open elsewhere held nothing for it, so its ending touches no job: one an
		// earlier resume left stays as it was, its reclaim included, which `settle` would disarm.
		const left = (notice: string) =>
			runtime.commit(async (tx) => {
				const { items } = await tx.doc(Deferrals, runtime.conversationId);
				delete items[id];
				await tx.appendEntry(runtime.conversationId, noticeEntry("report", "outcome", notice));
				return { status: "terminal" as const, outcome: { status: "completed" as const, result: "open" as const } };
			}, context);
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
				const { items } = await tx.doc(Deferrals, runtime.conversationId);
				const own = items[id];
				if (own === undefined) return cancelled;
				const doc = await tx.doc(Dispatches, runtime.conversationId);
				const index = doc.jobs.findIndex((each) => each.agent === item.agent);
				const current = doc.jobs[index];
				const phase = current?.reclaim?.phase;
				// A reclaim that committed `stopping` since the listing wins, and nothing is sent.
				if (phase === "stopping") return ending(tx, "gone", deferNotice.stopping(id, item));
				// Its own resume checked this already, in the commit that held the job.
				const holder = item.session === undefined || own.resuming ? undefined : holderOf(doc.jobs, item.session);
				if (holder !== undefined) return ending(tx, "unresumed", deferNotice.taken(id, item, holder.card));
				if (phase === "resuming" && !own.resuming) {
					held = true;
					return undefined;
				}
				// A stopped one listed again was reopened by the human: it is the agent, and the bridge sees it from now on.
				if (current !== undefined && (phase === "due" || phase === "stopped" || phase === "resuming")) {
					doc.jobs[index] = { ...current, reclaim: { phase: "sending" } };
				}
				// A hand-off's agent listed with no job yet, as one whose resume threw but is there: it is the job from now on.
				if (current === undefined && item.session !== undefined) {
					doc.jobs.push(handoffJob(item, item.session, runtime.now(), { phase: "sending" }));
				}
				const { resuming: _started, before: _held, ...rest } = own;
				items[id] = { ...rest, sending: true };
				sending = true;
				return { status: "running", checkpoint: { phase: "sending", tries: tried } };
			}, context);
			if (held) return retry(busy());
			if (!sending) return;
			try {
				await agents.prompt(item.agent, promptOf(id, item));
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
				const { items } = await tx.doc(Deferrals, runtime.conversationId);
				const own = items[id];
				if (own === undefined) return cancelled;
				const doc = await tx.doc(Dispatches, runtime.conversationId);
				const index = doc.jobs.findIndex((each) => each.agent === item.agent);
				const current = doc.jobs[index];
				const phase = current?.reclaim?.phase;
				// Accept refused a session a job held then; one may have come to hold it since, as a handover's move does.
				const holder = item.session === undefined ? undefined : holderOf(doc.jobs, item.session);
				if (holder !== undefined) return ending(tx, "unresumed", deferNotice.taken(id, item, holder.card));
				// A hand-off's session has no job until its resume returns (`ready`'s commit records it): the item holds the
				// name meanwhile, which another live hand-off of the session waits on, as on a job held `resuming`.
				if (current === undefined && item.session !== undefined) {
					for (const [other, each] of Object.entries(items)) {
						if (other === id || each.agent !== item.agent || each.resuming !== true) continue;
						const status = (await tx.task(Number(other) as TaskId))?.state.status;
						if (status !== undefined && status !== "completing" && status !== "terminal") {
							held = true;
							return undefined;
						}
					}
					items[id] = { ...own, resuming: true };
					return {
						status: "running",
						checkpoint: { phase: "resuming", tries: tried, session: item.session, until: runtime.now() + readyMs },
					};
				}
				if (current === undefined) return ending(tx, "gone", deferNotice.gone(id, item));
				if (phase === "stopping") return ending(tx, "gone", deferNotice.stopping(id, item));
				if (phase === "resuming" || phase === "sending") {
					held = true;
					return undefined;
				}
				doc.jobs[index] = { ...current, reclaim: { phase: "resuming" } };
				const before = current.reclaim && { ...current.reclaim };
				items[id] = { ...own, resuming: true, ...(before && { before }) };
				const until = runtime.now() + readyMs;
				return {
					status: "running",
					checkpoint: { phase: "resuming", tries: tried, session: current.sessionId, until },
				};
			}, context);
			if (held) await retry(busy());
		}

		return { end, left, retry, send, resume };
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
				const { end, left, retry, send, resume } = steps(id, task.input, checkpoint.tries, runtime, context);
				const pending = await runtime.snapshot(Deferrals, runtime.conversationId, context);
				if (pending?.items[id] === undefined) return runtime.commit(() => cancelled, context);
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
				// A hand-off's session is resumed only when no claude has it open, which is looked for before anything is held
				// for the resume: never two writers on one transcript. A look that fails is doubt, never "closed".
				const { session } = task.input;
				if (!listed && session !== undefined) {
					let open: Awaited<ReturnType<LiveSession>>;
					try {
						open = await liveSession(session);
					} catch (error) {
						return retry(error);
					}
					if (open !== undefined) return left(deferNotice.open(id, task.input, open.pid, open.cwd));
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
				let started = false;
				let listed: boolean | undefined;
				for (;;) {
					try {
						listed = (await listing(task.input.agent)) !== undefined;
					} catch {
						if (runtime.now() >= until) break;
						await pause(runtime, pollMs);
						continue;
					}
					if (!listed) {
						try {
							const { cwd } = task.input;
							await agents.resume({
								name: task.input.agent,
								card: task.input.card,
								sessionId: session,
								...(cwd !== undefined && { cwd }),
							});
							started = true;
						} catch (error) {
							// A side that cannot start an agent again ends this as it did before it could.
							if (error instanceof NotImplemented)
								return end("gone", deferNotice.gone(id, task.input, errorText(error)), true);
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
				const ready = {
					status: "running" as const,
					checkpoint: { phase: "ready" as const, tries: tried, until: runtime.now() + readyMs, started },
				};
				const item = task.input;
				// A hand-off's session becomes soma's job once its resume returned, or once a rerun finds its agent listed,
				// as after a crash between the two: then this commit, never a second resume, records it. Its `before` is
				// `stopped`, so a deferral that ends without the agent leaves a job no reconcile takes for one that vanished.
				if (item.session === undefined || !(started || listed === true)) return runtime.commit(() => ready, context);
				return runtime.commit(async (tx) => {
					const { items } = await tx.doc(Deferrals, runtime.conversationId);
					const own = items[id];
					if (own === undefined) return cancelled;
					const doc = await tx.doc(Dispatches, runtime.conversationId);
					if (!doc.jobs.some((each) => each.agent === item.agent)) {
						doc.jobs.push(handoffJob(item, session, runtime.now(), { phase: "resuming" }));
						items[id] = { ...own, before: { phase: "stopped" } };
					}
					return ready;
				}, context);
			},
			// The agent's window is up: it is prompted once it is listed idle or done, which is when claude takes a prompt.
			// Only a listing that answers decides, past `until` too: one that fails is no sign of the agent either way. Listings
			// that still fail `readyMs` past `until`, as rex's do while two windows share the name, end this in doubt.
			ready: async (task, runtime, context) => {
				const { tries: tried, until, started } = task.state.checkpoint;
				const id = String(task.id);
				const { end, send } = steps(id, task.input, tried, runtime, context);
				for (; ; await pause(runtime, pollMs)) {
					let state: string;
					try {
						const found = await listing(task.input.agent);
						if (found === undefined) return end("gone", deferNotice.closed(id, task.input, started), true);
						state = found.status?.state ?? "without a status";
					} catch (error) {
						if (runtime.now() < until + readyMs) continue;
						return end("failed", deferNotice.unlisted(id, task.input, (2 * readyMs) / 1000, errorText(error)));
					}
					if (state === "idle" || state === "done") return send();
					if (runtime.now() >= until)
						return end("failed", deferNotice.unready(id, task.input, readyMs / 1000, state, started));
				}
			},
			// Reached only by a rerun: the run that committed `sending` went on to prompt without ending.
			sending: async (task, runtime, context) => {
				const id = String(task.id);
				let due = false;
				await runtime.commit(async (tx) => {
					due = await settle(tx, runtime.conversationId, id, task.input.agent);
					await tx.appendEntry(
						runtime.conversationId,
						noticeEntry("report", "outcome", deferNotice.unsure(id, task.input)),
					);
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
	 * `soma defer` itself is at work, so it is not stopped under its own command. A job held `resuming` by a deferral
	 * no longer live is released first, so the new one is not held back by it for good.
	 */
	async function defer(conversation: Conversation, request: DeferRequest, context: Context): Promise<DeferReply> {
		if ("session" in request) return handoff(conversation, request, context);
		const setAt = Date.now();
		let at: number;
		try {
			at = deferAt(request.at, setAt);
		} catch (error) {
			return { accepted: false, reason: (error as Error).message };
		}
		const instruction = request.instruction.trim();
		if (instruction === "") return { accepted: false, reason: "the instruction is empty" };
		// Agents rex lists now, none when the listing fails: the defer goes ahead either way.
		const shown = await agents.list().then(
			(listed) => new Set(listed.map((each) => each.name)),
			() => new Set<string>(),
		);
		let rearmed = false;
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
			await unhold(tx, conversation.id, job.agent);
			const item: Deferred = { agent: job.agent, card: job.card, instruction, at, setAt };
			const id = await tx.createTask(Deferral, item, { ownership: { kind: "conversation" }, background: true });
			(await tx.doc(Deferrals, conversation.id)).items[String(id)] = item;
			// A failed stop is tried once more for a new deferral, and a stopped agent that defers is open again, its window
			// reopened since, when rex lists it; one rex does not, as a forged SOMA_AGENT or a child that outlived the
			// window, stays stopped, so no reconcile takes it for a vanished agent. One under way is left as it is. A stop
			// that commits after that listing is caught by the listing after this commit.
			const current = doc.jobs[index] ?? job;
			const phase = current.reclaim?.phase;
			if (phase === undefined || phase === "failed" || (phase === "stopped" && shown.has(job.agent))) {
				doc.jobs[index] = { ...current, reclaim: { phase: "due" } };
				rearmed = phase === "stopped";
			}
			const reply: DeferReply = { accepted: true, id: String(id), at: new Date(at).toISOString() };
			return { reply, agent: job.agent };
		}, context);
		// A stop may have committed between the first listing and the commit above, and left a stopped job armed with no
		// window open. Only a listing that answers and lacks the agent says so; a failed one is doubt, not absence.
		if (agent !== undefined && rearmed) {
			const gone = await agents.list().then(
				(listed) => !listed.some((each) => each.name === agent),
				() => false,
			);
			if (gone) await restop(conversation, request.agent, context);
		}
		// The defer is committed whatever the reclaim meets: a job left due is stopped at its next idle or done, or by the
		// next restart's reconcile.
		if (agent !== undefined) await reclaimer(conversation, agents, context)(agent).catch(() => {});
		return reply;
	}

	/**
	 * Accepts a hand-off from a Claude Code session soma did not dispatch: one commit creates the deferral and its item,
	 * named for the job the session becomes when it falls due (`handoffName`), and nothing else happens until then: no
	 * job, no listing, no reclaim, no stop. A session that already has a hand-off job, or a waiting hand-off, gets that
	 * name again; any other name a job or a waiting deferral holds is another session's. A session any other job holds,
	 * as one soma dispatched that the human resumed by hand, is refused: never two writers on one transcript. A request
	 * the drop directory read again, as after a crash or a reply it could not write, carries the `request` of a waiting
	 * deferral and gets that one's reply with nothing created. One read late, as while soma was down, counts from its own
	 * `setAt` and is refused once that time has passed, since its session expected it then.
	 */
	async function handoff(conversation: Conversation, request: HandoffRequest, context: Context): Promise<DeferReply> {
		const setAt = request.setAt ?? Date.now();
		let at: number;
		try {
			at = deferAt(request.at, setAt);
		} catch (error) {
			return { accepted: false, reason: (error as Error).message };
		}
		const instruction = request.instruction.trim();
		if (instruction === "") return { accepted: false, reason: "the instruction is empty" };
		const { session, cwd } = request;
		const refusal = handoffRefusal(session, cwd);
		if (refusal !== undefined) return { accepted: false, reason: refusal };
		// A directory that cannot be read is named as one outside any repo: the name only has to be the job's own.
		const root = (await repoRoot(cwd).catch(() => undefined)) ?? cwd;
		return conversation.commit(async (tx): Promise<DeferReply> => {
			const deferrals = await tx.doc(Deferrals, conversation.id);
			if (request.request !== undefined) {
				const made = Object.entries(deferrals.items).find(([, each]) => each.request === request.request);
				if (made !== undefined) return { accepted: true, id: made[0], at: new Date(made[1].at).toISOString() };
			}
			if (request.setAt !== undefined && at <= Date.now()) {
				return {
					accepted: false,
					reason: `its time, ${new Date(at).toISOString()}, had passed when soma read the request`,
				};
			}
			const { jobs } = await tx.doc(Dispatches, conversation.id);
			const holder = holderOf(jobs, session);
			if (holder !== undefined) return { accepted: false, reason: heldSession(session, holder.card) };
			const waiting = Object.values(deferrals.items);
			const agent =
				jobs.find((each) => each.handoff === true && each.sessionId === session)?.agent ??
				waiting.find((each) => each.session === session)?.agent ??
				handoffName(
					root,
					session,
					(name) =>
						jobs.some((each) => each.agent === name || each.card === name) ||
						waiting.some((each) => each.agent === name),
				);
			const item: Deferred = {
				agent,
				card: agent,
				instruction,
				at,
				setAt,
				session,
				cwd,
				...(request.request === undefined ? {} : { request: request.request }),
			};
			const id = await tx.createTask(Deferral, item, { ownership: { kind: "conversation" }, background: true });
			deferrals.items[String(id)] = item;
			return { accepted: true, id: String(id), at: new Date(at).toISOString() };
		}, context);
	}

	/** Moves the job of `card` from `due` back to `stopped`; a job in any other phase by now is left to whoever changed it. */
	async function restop(conversation: Conversation, card: string, context: Context): Promise<void> {
		await conversation
			.commit(async (tx) => {
				const doc = await tx.doc(Dispatches, conversation.id);
				const index = doc.jobs.findIndex((each) => each.card === card);
				const job = doc.jobs[index];
				if (job?.reclaim?.phase === "due") doc.jobs[index] = { ...job, reclaim: { phase: "stopped" } };
			}, context)
			.catch(() => {});
	}

	return { extension: defineExtension({ name: "soma.defer", tasks: [Deferral] }), defer };
}
