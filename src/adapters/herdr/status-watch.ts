// Ported from musingfox/cc-mobile server/herdr/pane-events.ts @ d9f0690: the stream-plus-snapshot status
// source and its poll tiers, keyed by agent name and reporting herdr's state_change_seq instead of
// driving a phone.
/**
 * The event stream alone is not a status source: a pure status change emits only
 * `pane.agent_status_changed`, whose subscription needs a concrete pane id, and `pane.updated`
 * carries no transition counter. So a `session.snapshot` poll is the source, and any stream event
 * only makes the next tick take one. The snapshot's agent rows carry `state_change_seq`, which
 * moves on every status change and holds still otherwise, so a status is reported once per seq
 * and a repeated snapshot reports nothing.
 */

import type { AgentStatusEvent } from "../../ports/agent.ts";
import { STATE_BY_AGENT_STATUS } from "./agent-state.ts";
import type { AgentInfo, SessionSnapshot } from "./schema.ts";
import type { SubscribeEventsOptions, SubscriptionHandle } from "./subscribe.ts";

export const DEFAULT_STATUS_POLL_MS = 1_000;

/**
 * Ticks between two snapshot RPCs; the timer keeps its 1 s beat.
 *   1   somebody listens and an agent is running: a settle must land within a second.
 *   5   somebody listens but no agent is seen yet: only a new one to notice.
 *   3   nobody listens, but push subscribers want a finished turn.
 *   30  nobody listens: close to off, kept so a daemon restart is eventually noticed.
 */
const DISCOVERY_POLL_TICKS = 5;
const DORMANT_POLL_TICKS = 30;
const PUSH_SUBSCRIBER_POLL_TICKS = 3;

export function pollEvery(listening: boolean, pushing: boolean, agentsRunning: boolean): number {
	if (!listening) return pushing ? PUSH_SUBSCRIBER_POLL_TICKS : DORMANT_POLL_TICKS;
	return agentsRunning ? 1 : DISCOVERY_POLL_TICKS;
}

export type TimerHandle = unknown;

export interface StatusWatchOptions {
	subscribe: (options: SubscribeEventsOptions) => Promise<SubscriptionHandle>;
	snapshot: () => Promise<Pick<SessionSnapshot, "agents">>;
	onStatus: (event: AgentStatusEvent) => void;
	/** Whether anyone waits on what the poll reads; defaults to always. */
	listening?: () => boolean;
	pushing?: () => boolean;
	pollIntervalMs?: number;
	setIntervalFn?: (fn: () => void, ms: number) => TimerHandle;
	clearIntervalFn?: (handle: TimerHandle) => void;
	onError?: (error: Error) => void;
}

export function createStatusWatch(options: StatusWatchOptions) {
	const { subscribe, snapshot, onStatus } = options;
	const listening = options.listening ?? (() => true);
	const pushing = options.pushing ?? (() => false);
	const setIntervalFn =
		options.setIntervalFn ??
		((fn: () => void, ms: number) => {
			const timer = setInterval(fn, ms);
			// A background poll must never be the reason a process stays alive.
			timer.unref();
			return timer;
		});
	const clearIntervalFn =
		options.clearIntervalFn ?? ((handle: TimerHandle) => clearInterval(handle as ReturnType<typeof setInterval>));
	const onError = options.onError ?? ((error: Error) => console.warn(`[herdr] status watch: ${error.message}`));

	const seen = new Map<string, { status: string; seq: number }>();
	let handle: SubscriptionHandle | undefined;
	let poll: TimerHandle | undefined;
	let stopped = false;
	/** Tail-style guard: a slow snapshot makes the next tick skip, not pile up. */
	let polling = false;
	/** One warning per outage, not one per second. */
	let pollFailing = false;
	let agentsRunning = false;
	let ticksWaited = 0;
	/** Something arrived on the stream: re-read the whole picture on the next tick. */
	let dueNext = false;
	let listeningLastTick = false;

	function observe(agent: Pick<AgentInfo, "name" | "agent_status" | "state_change_seq">): void {
		const { name, agent_status: status, state_change_seq: seq } = agent;
		const state = STATE_BY_AGENT_STATUS[status];
		// An unnamed agent was not started by agent.start; without a counter nothing proves a repeat.
		if (!name || state === undefined || seq === undefined) return;
		const last = seen.get(name);
		if (last?.seq === seq && last.status === status) return;
		seen.set(name, { status, seq });
		onStatus({ agent: name, status: state, seq });
	}

	function observeSnapshot(current: Pick<SessionSnapshot, "agents">): void {
		agentsRunning = current.agents.some((agent) => STATE_BY_AGENT_STATUS[agent.agent_status] !== undefined);
		for (const agent of current.agents) observe(agent);
	}

	async function pollOnce(): Promise<void> {
		if (polling || stopped) return;
		polling = true;
		try {
			observeSnapshot(await snapshot());
			pollFailing = false;
		} catch (error) {
			if (!pollFailing) {
				pollFailing = true;
				onError(error instanceof Error ? error : new Error(String(error)));
			}
		} finally {
			polling = false;
		}
	}

	function dueThisTick(): boolean {
		const now = listening();
		// A listener that has just arrived gets a look straight away, once per arrival.
		const attached = now && !listeningLastTick;
		listeningLastTick = now;
		ticksWaited += 1;
		// A stream event only shortcuts a wait somebody is waiting on: a working claude retitles its
		// pane every second and would otherwise hold the poll at full speed for nobody.
		const shortcut = (dueNext && now) || attached;
		if (ticksWaited < pollEvery(now, pushing(), agentsRunning) && !shortcut) return false;
		ticksWaited = 0;
		dueNext = false;
		return true;
	}

	/** Never rejects: a dead stream only costs the shortcut, the poll still reports every status. */
	async function start(): Promise<void> {
		try {
			const opened = await subscribe({
				subscriptions: [{ type: "pane.updated" }],
				onEvent: () => {
					dueNext = true;
				},
				// The stream carries no sequence numbers, so a reconnect re-aligns from a fresh snapshot.
				onResync: observeSnapshot,
				onError,
			});
			if (stopped) opened.stop();
			else handle = opened;
		} catch (error) {
			onError(error instanceof Error ? error : new Error(String(error)));
		}
		if (poll === undefined && !stopped) {
			poll = setIntervalFn(() => {
				if (dueThisTick()) void pollOnce();
			}, options.pollIntervalMs ?? DEFAULT_STATUS_POLL_MS);
		}
	}

	function stop(): void {
		stopped = true;
		handle?.stop();
		handle = undefined;
		if (poll !== undefined) {
			clearIntervalFn(poll);
			poll = undefined;
		}
	}

	return { start, stop };
}
