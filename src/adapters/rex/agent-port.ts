import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import type { ZodType } from "zod";
import { readPerfCoresViaSysctl, resolveHangarCapWithSource } from "../../agent-cli/hangar-cap.ts";
import { readFinalMessage, resolveTranscriptPath } from "../../agent-cli/transcript.ts";
import type {
	AgentListing,
	AgentPort,
	AgentResult,
	AgentState,
	AgentStatusEvent,
	Answer,
	AnswerOutcome,
	BlockedKind,
	StartRequest,
} from "../../ports/agent.ts";
import type { RexClient } from "./client.ts";
import {
	BlockClosedResultSchema,
	BlockEventSchema,
	EmptyResultSchema,
	NewWindowResultSchema,
	ProcessResultSchema,
	ProgramStatusChangedSchema,
	ProgramStatusResultSchema,
	type RexWindow,
	SHELL_FLAVOR,
	type StatusRecord,
	TERMINAL,
	ViewSchema,
	WriteResultSchema,
} from "./schema.ts";
import { type Git, openWorktree, runGit } from "./worktree.ts";

export interface RexAgentPortOptions {
	readonly client: RexClient;
	/** The hangar: the rex session every agent gets a window in. Found by id, never by label, which is not unique. */
	readonly sessionId: string;
	readonly cap?: number;
	/** Where claude keeps its transcripts; defaults to ~/.claude/projects. */
	readonly projectsDir?: string;
	readonly git?: Git;
	/** How long a sent prompt may take to turn the agent working before `\r` is sent once more. */
	readonly confirmMs?: number;
	readonly onError?: (error: Error) => void;
}

/** One agent: a window named after it, holding the block its claude runs in. */
type Pane = { readonly name: string; readonly blockId: string; readonly label?: string };

const BLOCKED_KINDS: readonly string[] = ["permission", "question", "auth"] satisfies BlockedKind[];
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Any of these can change which window a block is in, or what the window is called.
const VIEW_EVENTS = new Set(["session_view_changed", "window_created", "window_closed", "window_label_changed"]);

const isRoot = (record: StatusRecord) => record.id === undefined || record.id === "";

/** OSC 7501's own vocabulary, which the port shares; a state rex does not know reads as idle, as its API says. */
export function stateOf(record: StatusRecord): AgentState {
	const { state, kind, msg } = record;
	const text = msg === undefined ? {} : { msg };
	if (state === "blocked") {
		// claude names the kind; one left out is a prompt on screen like any permission prompt.
		return { state, kind: BLOCKED_KINDS.includes(kind ?? "") ? (kind as BlockedKind) : "permission", ...text };
	}
	if (state === "working" || state === "done" || state === "error") return { state, ...text };
	return { state: "idle", ...text };
}

// An RFC 3339 time split at its fraction of a second, which rex sends to the microsecond.
const TIMESTAMP = /^(.+T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i;

/**
 * Names an observation: rex re-sends a record whenever anything in it changed, updated_at included, so one report is
 * one value, and a new value promises no transition (src/ports/agent.ts). It is updated_at in microseconds since the
 * epoch, since Date.parse keeps milliseconds and two reports within one would then read as one observation.
 */
export function seqOf(record: StatusRecord): number | undefined {
	const [, whole, fraction = "", zone] = TIMESTAMP.exec(record.updated_at) ?? [];
	const seconds = whole === undefined ? Number.NaN : Date.parse(`${whole}${zone}`);
	if (Number.isNaN(seconds)) return undefined;
	const seq = seconds * 1000 + Number(fraction.slice(0, 6).padEnd(6, "0"));
	return Number.isSafeInteger(seq) ? seq : undefined;
}

/** The block claude runs in: the window's first tiled block, the only one start() makes. */
function paneOf(window: RexWindow): Pane | undefined {
	const tiled = window.layers?.find((layer) => layer.kind === "tiled") ?? window.layers?.[0];
	const block = tiled?.blocks?.find((each) => each.block_id !== null);
	if (window.label === undefined || block?.block_id == null) return undefined;
	return { name: window.label, blockId: block.block_id, ...(block.label === undefined ? {} : { label: block.label }) };
}

/**
 * Dispatches each card's claude into a window of the hangar rex session, in its own `fleet/<card>` worktree.
 * ARCHITECTURE.md「rex 的實作」is the design. Stubbed in this slice: `respond`, the folder-trust dialog check (it
 * holds only for repos the human trusts) and counting the hangar's claude blocks against the cap.
 */
export function createRexAgentPort(options: RexAgentPortOptions): AgentPort {
	const { client, sessionId } = options;
	const git = options.git ?? runGit;
	const confirmMs = options.confirmMs ?? 3_000;
	const onError = options.onError ?? ((error: Error) => console.warn(`[rex] ${error.message}`));
	const cap = options.cap ?? resolveHangarCapWithSource(undefined, readPerfCoresViaSysctl).cap;
	// Stub in this slice: the hangar's claude blocks are not counted yet, so the hangar never reads as full.
	const occupied = async () => 0;

	const blockCall = <T>(method: string, blockId: string, schema: ZodType<T>, args = {}) =>
		client.call(`${TERMINAL}.${method}`, { session_id: sessionId, block_id: blockId, args }, schema);

	/** Every pane of the hangar, by window name; a name can be on more than one window. */
	async function panes(): Promise<Map<string, Pane[]>> {
		await client.attach(sessionId);
		const view = await client.call("session.view", { session_id: sessionId }, ViewSchema);
		const byName = new Map<string, Pane[]>();
		for (const window of view.windows ?? []) {
			const pane = paneOf(window);
			if (pane !== undefined) byName.set(pane.name, [...(byName.get(pane.name) ?? []), pane]);
		}
		return byName;
	}

	function only(byName: Map<string, Pane[]>, agent: string): Pane {
		const found = byName.get(agent) ?? [];
		if (found.length > 1) throw new Error(`rex hangar ${sessionId} has ${found.length} windows named ${agent}`);
		const [pane] = found;
		if (pane === undefined) throw new Error(`rex hangar ${sessionId} has no window named ${agent}`);
		return pane;
	}

	async function isClaude(blockId: string): Promise<boolean> {
		const { foreground } = await blockCall("process", blockId, ProcessResultSchema);
		return foreground?.argv0 === "claude";
	}

	/** The root record's status while claude is in the foreground: subagents leave child records with an id. */
	async function observe(blockId: string): Promise<{ status: AgentState; seq: number } | undefined> {
		const [{ records }, claude] = await Promise.all([
			blockCall("program_status", blockId, ProgramStatusResultSchema),
			isClaude(blockId),
		]);
		const root = records.find(isRoot);
		const seq = root && seqOf(root);
		return root === undefined || seq === undefined || !claude ? undefined : { status: stateOf(root), seq };
	}

	/** The root record's state as rex reports it, undefined when there is none or it cannot be read. */
	async function rootState(blockId: string): Promise<string | undefined> {
		try {
			const { records } = await blockCall("program_status", blockId, ProgramStatusResultSchema);
			return records.find(isRoot)?.state;
		} catch (error) {
			onError(error as Error);
			return undefined;
		}
	}

	const write = (blockId: string, data: string) => blockCall("write", blockId, WriteResultSchema, { data });

	/** Resolves true once the block's root record turns working, false when `ms` passes first. */
	function turnsWorking(blockId: string, ms: number) {
		let stop = () => {};
		const done = new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), ms);
			const off = client.onSessionEvent((event) => {
				if (event.session_id !== sessionId || event.event.type !== "block_event") return;
				const block = BlockEventSchema.safeParse(event.event.payload);
				if (!block.success || block.data.block_id !== blockId || block.data.name !== "program_status_changed") return;
				const changed = ProgramStatusChangedSchema.safeParse(block.data.payload);
				if (changed.success && changed.data.id === "" && changed.data.record.state === "working") resolve(true);
			});
			stop = () => {
				clearTimeout(timer);
				off();
			};
		});
		return { done, stop: () => stop() };
	}

	const listeners = new Set<(event: AgentStatusEvent) => void>();
	let unwatch: (() => void) | undefined;

	/** Events only, no polling: a connection (re)opened re-reads each block once, since events in a gap are lost. */
	function watch(): () => void {
		const emit = (event: AgentStatusEvent) => {
			for (const listener of listeners) listener(event);
		};
		// Which window each block is in, by name; null for a name more than one window has.
		let names: Map<string, string | null> | undefined;
		const lastSeq = new Map<string, number>();
		async function refresh(): Promise<Map<string, string | null>> {
			const fresh = new Map<string, string | null>();
			for (const [name, list] of await panes()) {
				for (const pane of list) fresh.set(pane.blockId, list.length === 1 ? name : null);
			}
			names = fresh;
			return fresh;
		}
		function report(blockId: string, name: string | null | undefined, status: AgentState, seq: number): void {
			if (name === undefined) return;
			if (name === null) {
				onError(new Error(`rex hangar ${sessionId}: two windows share block ${blockId}'s name`));
				return;
			}
			// The same seq is the same observation, which a resync re-reads. A lower one is a report the resync already
			// read past, whose event queued behind it.
			const last = lastSeq.get(blockId);
			if (last !== undefined && seq <= last) return;
			lastSeq.set(blockId, seq);
			emit({ agent: name, status, seq });
		}

		// One at a time, so a slow lookup is never overtaken by the block's next report.
		let queue = Promise.resolve();
		const enqueue = (work: () => Promise<void>) => {
			queue = queue.then(work).catch((error: Error) => onError(error));
		};
		const resync = () =>
			enqueue(async () => {
				const fresh = await refresh();
				await Promise.all(
					[...fresh].map(async ([blockId, name]) => {
						const seen = await observe(blockId);
						if (seen !== undefined) report(blockId, name, seen.status, seen.seq);
					}),
				);
			});

		const offEvent = client.onSessionEvent((event) => {
			if (event.session_id !== sessionId) return;
			if (VIEW_EVENTS.has(event.event.type)) names = undefined;
			if (event.event.type !== "block_event") return;
			const block = BlockEventSchema.safeParse(event.event.payload);
			if (!block.success || block.data.name !== "program_status_changed") return;
			const changed = ProgramStatusChangedSchema.safeParse(block.data.payload);
			if (!changed.success || changed.data.id !== "") return;
			const { block_id: blockId } = block.data;
			const { record } = changed.data;
			const seq = seqOf(record);
			if (seq === undefined) return;
			enqueue(async () => {
				const known = names?.has(blockId) ? names : await refresh();
				if (!known.has(blockId) || !(await isClaude(blockId))) return;
				report(blockId, known.get(blockId), stateOf(record), seq);
			});
		});
		const offConnected = client.onConnected(resync);
		void client.attach(sessionId).then(resync, (error: Error) => onError(error));
		return () => {
			offEvent();
			offConnected();
		};
	}

	return {
		async start(request: StartRequest): Promise<void> {
			const running = await occupied();
			if (running >= cap) throw new Error(`hangar is full: ${running} of ${cap} agents running`);
			const path = await openWorktree(git, request.cwd, request.card);
			// obw finds its vault through this untracked file, which a fresh worktree lacks.
			await copyFile(join(request.cwd, ".obsidian.yaml"), join(path, ".obsidian.yaml"), constants.COPYFILE_EXCL).catch(
				(error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT" && error.code !== "EEXIST") throw error;
				},
			);
			await client.attach(sessionId);
			// An interactive shell types claude's command, so the block outlives claude exiting, as a herdr pane does.
			// The block's label keeps the session id, which nothing else in rex records.
			await client.call(
				"session.new_window",
				{
					session_id: sessionId,
					window_label: request.name,
					focus: false,
					layout: {
						block: {
							flavor: SHELL_FLAVOR,
							label: request.sessionId,
							options: { cwd: path, initial_input: `claude --session-id ${request.sessionId}\n` },
						},
					},
				},
				NewWindowResultSchema,
			);
		},

		async list(): Promise<readonly AgentListing[]> {
			const byName = await panes();
			const duplicated = [...byName].filter(([, list]) => list.length > 1).map(([name]) => name);
			if (duplicated.length > 0) {
				throw new Error(`rex hangar ${sessionId} has more than one window named ${duplicated.join(", ")}`);
			}
			return Promise.all(
				[...byName.values()].map(async ([pane]) => {
					const { name, blockId, label } = pane as Pane;
					const seen = await observe(blockId);
					return {
						name,
						...(seen === undefined ? {} : seen),
						...(label !== undefined && SESSION_ID.test(label) ? { sessionId: label } : {}),
					};
				}),
			);
		},

		async prompt(agent: string, text: string): Promise<void> {
			const { blockId } = only(await panes(), agent);
			// Typed into a prompt, the text's `\r` would choose the highlighted option.
			const { records } = await blockCall("program_status", blockId, ProgramStatusResultSchema);
			const state = records.find(isRoot)?.state;
			if (state !== "idle" && state !== "done") {
				throw new Error(
					`rex agent ${agent} is ${state ?? "without a status record"}: a prompt goes only to idle or done`,
				);
			}
			const working = turnsWorking(blockId, confirmMs);
			try {
				// A paste keeps a multi-line prompt one message; claude takes `\r` as Enter where a typed key may not.
				await client.call(
					"block.event",
					{ session_id: sessionId, block_id: blockId, event: { type: "paste", payload: { text } } },
					EmptyResultSchema,
				);
				await write(blockId, "\r");
				// Only an idle claude can still hold the text unsent; on any other screen `\r` would answer a prompt.
				if (!(await working.done) && (await rootState(blockId)) === "idle") await write(blockId, "\r");
			} finally {
				working.stop();
			}
		},

		onStatus(listener: (event: AgentStatusEvent) => void): () => void {
			listeners.add(listener);
			unwatch ??= watch();
			return () => {
				listeners.delete(listener);
				if (listeners.size > 0) return;
				unwatch?.();
				unwatch = undefined;
			};
		},

		/** The agent's last assistant message, read off its claude transcript; undefined while there is none. */
		async readResult(agent: string): Promise<AgentResult | undefined> {
			const { blockId, label } = only(await panes(), agent);
			if (label === undefined || !SESSION_ID.test(label)) return undefined;
			const { foreground, child } = await blockCall("process", blockId, ProcessResultSchema);
			const path = await resolveTranscriptPath(label, foreground?.cwd ?? child?.cwd, options.projectsDir);
			return path === undefined ? undefined : readFinalMessage(path);
		},

		// Stub in this slice: the screen is not read, so no answer can be checked against it.
		async respond(_agent: string, _answer: Answer): Promise<AnswerOutcome> {
			return { sent: false, refusal: "unreadable" };
		},

		async stop(agent: string): Promise<void> {
			const { blockId } = only(await panes(), agent);
			await client.call("block.close", { session_id: sessionId, block_id: blockId }, BlockClosedResultSchema);
		},
	};
}
