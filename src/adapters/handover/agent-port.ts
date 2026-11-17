import { type AgentListing, type AgentPort, type AgentStatusEvent, PromptRefused } from "../../ports/agent.ts";
import {
	type AgentHandover,
	type AnswerHeld,
	type Cut,
	type HandingOver,
	type HandoverOutcome,
	type HandoverRefusal,
	type HandoverSettling,
	type HeldSession,
	type SessionGiver,
	type SessionTaker,
	type Settled,
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
 * handover runs at a time. While one is under way its job is listed with no status, takes no prompt and reports nothing,
 * from the cut of its turn until the caller has recorded how it ended, so the core sees neither a vanished agent, nor the
 * end of a cut turn as a finished one, nor the trust dialog the handover is about to answer; what the job reports then is
 * passed on once, as the observation it is (ARCHITECTURE.md "The ACP implementation").
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
}: HandoverAgentPortOptions): AgentPort & AgentHandover & HandoverSettling & { dormant(): Promise<readonly string[]> } {
	const moved = new Map<string, HeldSession>();
	const moving = new Map<string, HeldSession>();
	const undecided = new Map<string, Undecided>();
	// Jobs on rex whose landing the listeners have not answered yet, or whose answer failed: what their window says waits
	// for that, and where it failed, is what tries it again.
	const unrecorded = new Map<string, Unrecorded>();
	// Why each job was last told undecided: once per reason, however many looks find it the same.
	const told = new Map<string, Why>();
	const statusListeners = new Set<(event: AgentStatusEvent) => void>();
	// The jobs a status of went out since `passOn` began.
	const heard = new Set<string>();
	/**
	 * What the job reports now goes out, as nothing did while it was held, unless something newer already has. A side that
	 * has nothing to say, or does not answer, says nothing; the core reads a seq it holds as the observation it recorded.
	 */
	async function passOn(agent: string): Promise<void> {
		if (unrecorded.has(agent)) return;
		heard.delete(agent);
		const listed = await (moved.has(agent) ? to : from).list().catch(() => []);
		const { status, seq } = listed.find(({ name }) => name === agent) ?? {};
		if (status === undefined || seq === undefined || heard.has(agent)) return;
		for (const listener of statusListeners) listener({ agent, status, seq });
	}

	/** What names a return of the agent, as `givenBack` says it at every startup: the one value a return is told by. */
	const returnOf = async (agent: string) => (await from.givenBack()).find(({ name }) => name === agent)?.at ?? 0;
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
			unrecorded.set(name, { said: [] });
			undecided.delete(name);
			await from.confirm(name);
			onError(new Error(`${name} was left mid-handover and its window is open: it is on rex`));
			tell({ agent: name, onto: "rex", sessionId: session.claudeSession });
			return;
		}
		await from.reinstate(name);
		undecided.delete(name);
		onError(new Error(`${name} was left mid-handover and no window of it is open: it is dormant on ACP`));
		if (started) tell({ agent: name, onto: "acp", at: await returnOf(name), startup: false });
		else back.push(name);
	}

	/**
	 * A settled job, its window's place still to be read off rex, which only one on rex needs and only once it is told.
	 * `released`: only a final mark says it is there, which holds nothing of a window that closed since.
	 */
	type Telling =
		| Extract<Settled, { onto: "acp" }>
		| {
				readonly agent: string;
				readonly onto: "rex";
				readonly sessionId: string;
				readonly released?: HeldSession;
				readonly answered?: true;
		  };
	/**
	 * What the window of a job not recorded has said, in order, and the telling of it that failed, if one has. `listed` is
	 * the status a listing withheld of it. `answered`: rex answered that telling and a listener failed.
	 */
	type Unrecorded = { readonly said: AgentStatusEvent[]; again?: Telling; listed?: number; answered?: boolean };
	const listeners = new Set<(settled: Settled) => void | Promise<void>>();
	const unheard: Telling[] = [];
	/** Throws when rex cannot say whether a released job's window is there: the job's next status tries it again. */
	async function settledOf(telling: Telling): Promise<Settled> {
		if (telling.onto === "acp") return telling;
		const { agent, sessionId, released, answered } = telling;
		if (released !== undefined && (await to.holds(released, to.hangar)) !== "window") {
			return { agent, onto: "gone", sessionId };
		}
		const last = await to.readResult(agent).catch(() => undefined);
		return {
			agent,
			onto: "rex",
			sessionId,
			window: agent,
			session: await to.label().catch(() => to.hangar),
			...(last === undefined ? {} : { lastRecord: last.id }),
			...(answered ? { answered } : {}),
		};
	}
	async function deliver(telling: Telling): Promise<void> {
		let answered = false;
		try {
			const settled = await settledOf(telling);
			answered = true;
			await Promise.all([...listeners].map((listener) => listener(settled)));
		} catch (error) {
			if (telling.onto === "rex") {
				unrecorded.set(telling.agent, { said: [], ...unrecorded.get(telling.agent), again: telling, answered });
			}
			throw error;
		}
		const held = unrecorded.get(telling.agent);
		if (held === undefined) return;
		unrecorded.delete(telling.agent);
		if (held.said.length === 0) return passOn(telling.agent);
		for (const event of held.said) for (const listener of statusListeners) listener(event);
	}
	function tell(telling: Telling): void {
		if (listeners.size === 0 || !started) unheard.push(telling);
		else void deliver(telling).catch(onError);
	}
	/**
	 * The status waits for the telling, and is what tries one that failed again: one try per status, none while one is
	 * under way. Any status says rex answers now. After a listener's failure only a new one tries: the status watch's first
	 * look repeats what the startup's listing withheld, and that soma's reconcile holds to the job as it reads.
	 */
	function waits(event: AgentStatusEvent, job: Unrecorded): void {
		// Each listener hears the same event from `to`.
		if (job.said.at(-1)?.seq !== event.seq) job.said.push(event);
		const { again } = job;
		if (again === undefined || (job.answered && event.seq === job.listed)) return;
		job.again = undefined;
		tell(again);
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
	let started = false;
	const loading = (async () => {
		for (const session of await from.released()) {
			moved.set(session.name, session);
			tell({ agent: session.name, onto: "rex", sessionId: session.claudeSession, released: session });
		}
		for (const session of await from.handingOver()) {
			// A time ahead of this clock, one set back since it was written, would hold the job for as long, or overflow a timer.
			const at = session.at === undefined ? {} : { at: Math.min(session.at, now()) };
			undecided.set(session.name, { ...session, ...at, why: "rex" });
		}
		await look();
		for (const { name, at } of await from.givenBack()) tell({ agent: name, onto: "acp", at, startup: true });
		started = true;
	})();
	const side = async (agent: string) => {
		await loading;
		return moved.has(agent) ? to : from;
	};
	const refused = (refusal: HandoverRefusal, reason: string): Extract<HandoverOutcome, { handedOver: false }> => ({
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
	const backOnAcp = (error: Error, at: number): HandoverOutcome => ({
		...refused(
			"cannot_resume",
			`${error.message}. Its ACP process has ended and the job stays on ACP: its next prompt starts it again in its session`,
		),
		back: at,
	});

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
			return backOnAcp(error, await returnOf(agent));
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
					"the side it is on, and the human is told which in a notice",
			);
		}
		hold(job, there === "loose" ? "loose" : "grace");
		atGraceEnd();
		return refused(
			"cannot_resume",
			`${error.message}. Its ACP process has ended and the job is undecided: ${stillMoving(agent)}. It takes no ` +
				"prompt until it is known which side it is on, then goes on on that side, and the human is told which in a notice",
		);
	}

	/** The move itself, with the job held. What was cut is cut whatever comes of the rest. */
	async function move(agent: string, held: HeldSession): Promise<HandoverOutcome> {
		const cutting = await from.cut(agent);
		if (cutting !== undefined && "refusal" in cutting) return refused(cutting.refusal, cutting.reason);
		const cut: { cut?: Cut } = cutting === undefined ? {} : { cut: cutting };
		const mark = { hangar: to.hangar, at: now() };
		try {
			const released = await from.release(agent, mark);
			if ("refusal" in released) return { ...refused(released.refusal, released.reason), ...cut };
		} catch (error) {
			await from.reinstate(agent);
			return { ...backOnAcp(error as Error, await returnOf(agent)), ...cut };
		}
		// In the hangar the mark names, so the mark names where any window of this take is.
		const taken = await to.take(held, mark.hangar).catch((error: Error) => error);
		const outcome =
			taken instanceof Error
				? await afterFailedTake(agent, { ...held, ...mark }, taken)
				: await landed(agent, held, taken);
		return { ...outcome, ...cut };
	}

	async function handOver(
		agent: string,
		record?: (outcome: HandoverOutcome) => Promise<void>,
	): Promise<HandoverOutcome> {
		await loading;
		if (undecided.has(agent)) await look();
		if (moved.has(agent)) return refused("not_acp", `${agent} is on rex already, in its window of the same name`);
		if (undecided.has(agent)) return refused("cannot_resume", stillMoving(agent));
		const held = await from.releasable(agent);
		if ("refusal" in held) return refused(held.refusal, held.reason);
		const unfit = await to.takeable(held).catch((error: Error) => error.message);
		if (unfit !== undefined) return refused("cannot_resume", unfit);
		moving.set(agent, held);
		try {
			const outcome = await move(agent, held);
			const toKeep = outcome.handedOver || outcome.cut !== undefined || outcome.back !== undefined;
			if (toKeep) {
				await record?.(outcome).catch((error: Error) => {
					onError(error);
					if (!outcome.handedOver) return;
					unrecorded.set(agent, { said: [] });
					tell({ agent, onto: "rex", sessionId: outcome.sessionId, answered: true });
				});
			}
			return outcome;
		} finally {
			moving.delete(agent);
			await passOn(agent);
		}
	}

	let queue: Promise<unknown> = Promise.resolve();
	let flushed: Promise<unknown> = Promise.resolve();

	return {
		dormant: async () => {
			await loading;
			return [...(await from.dormant()), ...back];
		},

		onSettled(listener) {
			listeners.add(listener);
			flushed = loading.then(() => Promise.all(unheard.splice(0).map((telling) => deliver(telling).catch(onError))));
			return () => listeners.delete(listener);
		},

		heard: async () => {
			await flushed;
		},

		handOver(agent, record) {
			const run = queue.then(() => handOver(agent, record));
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
			const [all, there] = await Promise.all([from.list(), moved.size === 0 ? [] : to.list()]);
			// One whose turn is being cut is still in `from`'s answer.
			const here = all.filter((agent) => !moving.has(agent.name));
			// A status of a job whose landing is not recorded would read as the end of a turn on it as it was recorded before.
			const onRex = there
				.filter((agent) => moved.has(agent.name))
				.map(({ status, seq, ...agent }) => {
					const held = listeners.size > 0 ? unrecorded.get(agent.name) : undefined;
					if (held !== undefined) held.listed = seq;
					return held !== undefined || status === undefined ? agent : { ...agent, status, seq };
				});
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
			statusListeners.add(listener);
			const pass = (event: AgentStatusEvent) => {
				heard.add(event.agent);
				listener(event);
			};
			const offFrom = from.onStatus((event) => {
				if (!moving.has(event.agent)) pass(event);
			});
			const offTo = to.onStatus((event) => {
				if (!moved.has(event.agent) || moving.has(event.agent)) return;
				const held = unrecorded.get(event.agent);
				if (held === undefined) pass(event);
				else waits(event, held);
			});
			return () => {
				statusListeners.delete(listener);
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
