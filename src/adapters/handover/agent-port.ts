import { type AgentListing, type AgentPort, type AgentStatusEvent, PromptRefused } from "../../ports/agent.ts";
import {
	type AgentHandover,
	type AnswerHeld,
	type HandingOver,
	type HandoverOutcome,
	type HandoverRefusal,
	type HeldSession,
	type SessionGiver,
	type SessionTaker,
	type Taken,
	TakeRefused,
} from "../../ports/handover.ts";

/**
 * How long a job whose take may still open a window stays undecided: well past `requestTimeoutMs`, the 10 s after which
 * a client gives up on a `session.new_window` that rex may still be running.
 */
export const HANDOVER_GRACE_MS = 60_000;

export interface HandoverAgentPortOptions {
	/** Every job starts here, and stays until it is handed over. */
	readonly from: AgentPort & SessionGiver;
	/** Where a job goes when it is handed over; also the side that holds the foreign agents. */
	readonly to: AgentPort & SessionTaker;
	readonly onError?: (error: Error) => void;
	/** Set in tests; HANDOVER_GRACE_MS otherwise. */
	readonly graceMs?: number;
	readonly now?: () => number;
}

/** What a handover says when there is nothing to hand over to, or nothing to hand over. */
export const noHandover = (refusal: HandoverRefusal, reason: string): AgentHandover => ({
	handOver: async () => ({ handedOver: false, refusal, reason }),
});

/** Why a job whose handover was cut short is on neither side yet. */
type Why = "rex" | "grace" | "loose" | "elsewhere";
type Undecided = HandingOver & { readonly why: Why };

/**
 * Jobs on two agent sides at once, below the core, which goes on seeing one AgentPort: each job runs on `from` until it
 * is handed over, and on `to` from then on. `from` records which it gave up, so a restart routes each job as the soma
 * before it did, and nothing of a job not handed over goes to `to`: the listing asks it nothing until one has been.
 * Statuses of `to` are passed on only for jobs handed over, since its side may hold other agents of the same name. One
 * handover runs at a time. While one is under way its job is listed with no status and takes no prompt, so the core sees
 * neither a vanished agent nor the trust dialog the handover is about to answer (ARCHITECTURE.md "The ACP implementation").
 *
 * A handover cut short leaves `from`'s mark of one in progress, and only a look at `to` ends it: a window there, the job
 * is on `to`; `to` answers and no block of it there at or after the end of the grace period, it goes back to `from`. Until
 * then, while `to` cannot answer, or while it holds a block of the job in no window yet, the job is undecided: as one under
 * way, and looked at again at the end of the grace period and at the next listing, prompt, answer or handover of it, each
 * of which goes on on the side the look finds or refuses saying why.
 */
export function createHandoverAgentPort({
	from,
	to,
	onError = (error) => console.warn(`[handover] ${error.message}`),
	graceMs = HANDOVER_GRACE_MS,
	now = Date.now,
}: HandoverAgentPortOptions): AgentPort & AgentHandover & { dormant(): Promise<readonly string[]> } {
	const moved = new Map<string, HeldSession>();
	const moving = new Map<string, HeldSession>();
	const undecided = new Map<string, Undecided>();
	// Why each job was last told undecided: once per reason, however many looks find it the same.
	const told = new Map<string, Why>();

	const hangarOf = ({ hangar }: HandingOver) => hangar ?? to.hangar;
	// A mark that records no time is from before they did, and older than any grace period.
	const graceEnds = ({ at }: HandingOver) => (at ?? 0) + graceMs;
	const WHY: Record<Why, (job: HandingOver) => string> = {
		rex: () => "rex does not answer to say which side it is on",
		grace: (job) =>
			`its window may still open: it goes back to ACP only if none has by the end of the grace period, ` +
			`${Math.ceil((graceEnds(job) - now()) / 1000)} s from now`,
		loose: (job) =>
			`a block labelled with its session is in rex session ${hangarOf(job)}, but in no window a listing reads as the job`,
		elsewhere: (job) =>
			`its window is in rex session ${hangarOf(job)}, and this soma's hangar is ${to.hangar}, so neither side lists it`,
	};
	const whyUndecided = (job: Undecided) => WHY[job.why](job);

	/** The job stays undecided, for this reason from now on. */
	function hold(session: HandingOver, why: Why, detail = ""): void {
		const { name } = session;
		const job = { ...session, why };
		undecided.set(name, job);
		if (told.get(name) !== why) onError(new Error(`${name} is undecided: ${whyUndecided(job)}${detail}`));
		told.set(name, why);
	}

	async function settle(session: Undecided): Promise<void> {
		const { name } = session;
		const hangar = hangarOf(session);
		const there = await to.holds(session, hangar).catch((error: Error) => error);
		if (there instanceof Error) return hold(session, "rex", `: ${there.message}`);
		if (there === "loose") return hold(session, "loose");
		if (there === "window" && hangar !== to.hangar) return hold(session, "elsewhere");
		if (there === "none" && now() < graceEnds(session)) return hold(session, "grace");
		told.delete(name);
		if (there === "window") {
			moved.set(name, session);
			undecided.delete(name);
			await from.confirm(name);
			onError(new Error(`${name} was left mid-handover and its window is open: it is on rex`));
			return;
		}
		await from.reinstate(name);
		undecided.delete(name);
		onError(new Error(`${name} was left mid-handover and no window of it is open: it is dormant on ACP`));
	}

	let looking: Promise<unknown> | undefined;
	/** One look at a time: a second caller waits for the one under way rather than settling the same job twice. */
	function look(): Promise<unknown> {
		if (undecided.size === 0) return Promise.resolve();
		looking ??= Promise.all([...undecided.values()].map(settle)).finally(() => {
			looking = undefined;
			atGraceEnd();
		});
		return looking;
	}

	let graceTimer: NodeJS.Timeout | undefined;
	/** Looks when the first grace period under way ends, so a job waiting it out needs no caller to leave undecided. */
	function atGraceEnd(): void {
		clearTimeout(graceTimer);
		const ends = [...undecided.values()].filter(({ why }) => why === "grace").map(graceEnds);
		if (ends.length === 0) return;
		graceTimer = setTimeout(() => void look().catch(onError), Math.max(0, Math.min(...ends) - now()));
		graceTimer.unref();
	}

	// The names the startup's look gave back to `from`: dormant as those it found itself are, to the core's reconcile.
	const back: string[] = [];
	const loading = (async () => {
		for (const session of await from.released()) moved.set(session.name, session);
		const left = await from.handingOver();
		for (const session of left) undecided.set(session.name, { ...session, why: "rex" });
		await look();
		back.push(...left.map(({ name }) => name).filter((name) => !moved.has(name) && !undecided.has(name)));
	})();
	const side = async (agent: string) => {
		await loading;
		return moved.has(agent) ? to : from;
	};
	const refused = (refusal: HandoverRefusal, reason: string): HandoverOutcome => ({
		handedOver: false,
		refusal,
		reason,
	});
	const inHand = (agent: string) => moving.has(agent) || undecided.has(agent);
	const stillMoving = (agent: string) => {
		const job = undecided.get(agent);
		return job === undefined
			? `${agent} is being handed over`
			: `${agent} is being handed over, and ${whyUndecided(job)}`;
	};
	const backOnAcp = (error: Error) =>
		refused(
			"cannot_resume",
			`${error.message}. Its ACP process has ended and the job stays on ACP: its next prompt starts it again in its session`,
		);

	async function landed(agent: string, session: HeldSession, taken: Taken): Promise<HandoverOutcome> {
		moved.set(agent, session);
		await from.confirm(agent);
		return { handedOver: true, ...taken, sessionId: session.claudeSession };
	}

	/**
	 * A `take` that threw may have opened the window all the same, as when the reply to its opening was lost, and unless
	 * rex plainly refused it may do so yet: the grace period counts from now.
	 */
	async function afterFailedTake(agent: string, session: HandingOver, error: Error): Promise<HandoverOutcome> {
		const there = await to.holds(session, to.hangar).catch((failure: Error) => failure);
		if (there === "window") return landed(agent, session, await to.adopt(session));
		const plain = error instanceof TakeRefused;
		if (there === "none" && plain) {
			await from.reinstate(agent);
			return backOnAcp(error);
		}
		let job = session;
		if (!plain) {
			const at = now();
			job = { ...session, at };
			await from.markedAt(agent, at);
		}
		if (there instanceof Error) {
			hold(job, "rex", `: ${there.message}`);
			return refused(
				"cannot_resume",
				`${error.message}. Its ACP process has ended, and rex does not answer (${there.message}), so whether its ` +
					"window opened is not known: the job is undecided, and takes no prompt until rex answers, then goes on on " +
					"the side it is on",
			);
		}
		hold(job, there === "loose" ? "loose" : "grace");
		atGraceEnd();
		return refused(
			"cannot_resume",
			`${error.message}. Its ACP process has ended and the job is undecided: ${stillMoving(agent)}. It takes no ` +
				"prompt until it is known which side it is on, then goes on on that side",
		);
	}

	async function handOver(agent: string): Promise<HandoverOutcome> {
		await loading;
		if (undecided.has(agent)) await look();
		if (moved.has(agent)) return refused("not_acp", `${agent} is on rex already, in its window of the same name`);
		if (undecided.has(agent)) return refused("cannot_resume", stillMoving(agent));
		const held = await from.releasable(agent);
		if ("refusal" in held) return refused(held.refusal, held.reason);
		const unfit = await to.takeable(held).catch((error: Error) => error.message);
		if (unfit !== undefined) return refused("cannot_resume", unfit);
		moving.set(agent, held);
		const mark = { hangar: to.hangar, at: now() };
		try {
			try {
				const released = await from.release(agent, mark);
				if ("refusal" in released) return refused(released.refusal, released.reason);
			} catch (error) {
				await from.reinstate(agent);
				return backOnAcp(error as Error);
			}
			const taken = await to.take(held).catch((error: Error) => error);
			if (taken instanceof Error) return await afterFailedTake(agent, { ...held, ...mark }, taken);
			return await landed(agent, held, taken);
		} finally {
			moving.delete(agent);
		}
	}

	let queue: Promise<unknown> = Promise.resolve();

	return {
		dormant: async () => {
			await loading;
			return [...(await from.dormant()), ...back];
		},

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
			if (inHand(request.name)) throw new Error(stillMoving(request.name));
			if (session === undefined) return from.resume(request);
			await to.take(session);
		},

		async list(): Promise<readonly AgentListing[]> {
			await loading;
			await look();
			// Taken before the sides are asked: a move that ends while they answer is in neither answer, and a job missing
			// from a listing reads as gone.
			const moves = [...moving.values(), ...undecided.values()];
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
			if (undecided.has(agent)) await look();
			if (inHand(agent)) throw new PromptRefused(stillMoving(agent));
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
			if (inHand(agent)) throw new Error(stillMoving(agent));
			return (await side(agent)).readScreen(agent);
		},

		async respond(agent, answer) {
			await loading;
			if (undecided.has(agent)) await look();
			if (inHand(agent)) {
				const held: AnswerHeld = { sent: false, refusal: "not_blocked", reason: stillMoving(agent) };
				return held;
			}
			return (await side(agent)).respond(agent, answer);
		},

		async stop(agent) {
			await loading;
			if (inHand(agent)) throw new Error(stillMoving(agent));
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
