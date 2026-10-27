import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import type { ZodType } from "zod";
import { readPerfCoresViaSysctl, resolveHangarCapWithSource } from "../../agent-cli/hangar-cap.ts";
import { answerKeys, type BlockedScreen, readBlockedScreen } from "../../agent-cli/permission/blocked-screen.ts";
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
import { type ProcessStart, readProcessStart } from "./process-start.ts";
import {
	BlobReadResultSchema,
	BlockClosedResultSchema,
	BlockEventSchema,
	EmptyResultSchema,
	FormatResultSchema,
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
import { type Git, mainCheckout, openWorktree, runGit } from "./worktree.ts";

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
	/** Pause between the keys of one answer, so claude reads an arrow and the Enter after it as two keys. */
	readonly keyGapMs?: number;
	/** How long claude may be in the foreground without a record before its screen is read for the trust dialog. */
	readonly trustMs?: number;
	readonly processStart?: ProcessStart;
	/** Pause between reads of a blocked screen that did not parse yet; claude may still be drawing it. */
	readonly redrawMs?: number;
	readonly now?: () => number;
	readonly onError?: (error: Error) => void;
}

type Seen = { readonly status: AgentState; readonly seq: number };

/** One agent: a window named after it, holding the block its claude runs in. */
type Pane = { readonly name: string; readonly blockId: string; readonly label?: string };

const BLOCKED_KINDS: readonly string[] = ["permission", "question", "auth"] satisfies BlockedKind[];
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Any of these can change which window a block is in, or what the window is called.
const VIEW_EVENTS = new Set(["session_view_changed", "window_created", "window_closed", "window_label_changed"]);

const isRoot = (record: StatusRecord) => record.id === undefined || record.id === "";

// The tail of the screen and scrollback that is read: a prompt is drawn at the bottom.
const SCREEN_BYTES = 65_536;
// Reads of a blocked record's screen, redrawMs apart, before it is taken not to parse.
const BLOCKED_READS = 3;

/** claude's folder-trust dialog, which it draws before it reports any status (ARCHITECTURE.md「rex 的實作」). */
export const isTrustDialog = (screen: BlockedScreen) =>
	screen.kind === "permission" &&
	screen.prompt?.options.some((option) => /trust this folder/i.test(option.label)) === true;

// rex's key event is client.key's `key` object, as a keyboard reports it; block.event takes it under type `key`.
const NAMED_KEYS: Record<string, { key: string; text: string }> = {
	Up: { key: "arrow_up", text: "" },
	Down: { key: "arrow_down", text: "" },
	Enter: { key: "enter", text: "\r" },
};

/** The key `answerKeys` names, as rex spells it; undefined for any other, such as a two-digit option. */
function keyOf(name: string): { key: string; text: string; unshifted_codepoint: number } | undefined {
	const key = /^\d$/.test(name) ? { key: `digit_${name}`, text: name } : NAMED_KEYS[name];
	return key && { ...key, unshifted_codepoint: key.text.codePointAt(0) ?? 0 };
}

function blockedOf({ kind, msg, prompt }: BlockedScreen): AgentState {
	const options = prompt?.options.map(({ id, label }) => ({ id, label }));
	return { state: "blocked", kind, msg, ...(prompt ? { fingerprint: prompt.fingerprint, options } : {}) };
}

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
 * ARCHITECTURE.md「rex 的實作」is the design. Stubbed in this slice: counting the hangar's claude blocks against the cap.
 */
export function createRexAgentPort(options: RexAgentPortOptions): AgentPort {
	const { client, sessionId } = options;
	const git = options.git ?? runGit;
	const confirmMs = options.confirmMs ?? 3_000;
	const keyGapMs = options.keyGapMs ?? 200;
	const trustMs = options.trustMs ?? 3_000;
	const processStart = options.processStart ?? readProcessStart;
	const now = options.now ?? Date.now;
	const redrawMs = options.redrawMs ?? 500;
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

	/**
	 * What the block shows while claude is in the foreground: the root record's status (subagents leave child records
	 * with an id), or, while claude has reported none, its folder-trust dialog. `recorded` says a root record is there,
	 * which ends the dialog check for the block.
	 */
	async function observe(blockId: string): Promise<{ seen?: Seen; recorded: boolean }> {
		const [{ records }, { foreground }] = await Promise.all([
			blockCall("program_status", blockId, ProgramStatusResultSchema),
			blockCall("process", blockId, ProcessResultSchema),
		]);
		const root = records.find(isRoot);
		const recorded = root !== undefined;
		if (foreground?.argv0 !== "claude") return { recorded };
		const seq = root && seqOf(root);
		const seen =
			root === undefined
				? await trustDialog(blockId, foreground.pid, foreground.cwd)
				: seq === undefined
					? undefined
					: { status: await statusOf(blockId, root), seq };
		return seen === undefined ? { recorded } : { seen, recorded };
	}

	/**
	 * A root record's status. A blocked one carries the prompt read off the screen, its options and fingerprint, as
	 * herdr's does, since rex's record names neither and respond needs the fingerprint. claude may report the block
	 * before it has drawn the prompt, so a screen that does not parse is read again, as herdr's is; one that still does
	 * not, or cannot be read, leaves the record's own status, a block nobody can answer.
	 */
	async function statusOf(blockId: string, record: StatusRecord): Promise<AgentState> {
		const status = stateOf(record);
		if (status.state !== "blocked") return status;
		try {
			let screen = await readScreen(blockId);
			for (let read = 1; read < BLOCKED_READS && screen.prompt === undefined; read++) {
				await new Promise((resolve) => setTimeout(resolve, redrawMs));
				screen = await readScreen(blockId);
			}
			return screen.prompt === undefined ? status : blockedOf(screen);
		} catch (error) {
			onError(error as Error);
			return status;
		}
	}

	/**
	 * claude's folder-trust dialog, for which claude reports no record, read off the screen once claude has been in the
	 * foreground for trustMs. Its seq is the time that first held, in microseconds: every read of one dialog, by any soma
	 * process, names it alike, so a restarted core wakes the model under the requestId the first one did. Its msg ends
	 * naming what a yes trusts: claude records the trust for the repo's main checkout, not the worktree it runs in.
	 */
	async function trustDialog(blockId: string, pid: number, cwd: string | undefined): Promise<Seen | undefined> {
		const started = await processStart(pid);
		if (started === undefined || now() - started < trustMs) return undefined;
		const screen = await readScreen(blockId);
		if (!isTrustDialog(screen)) return undefined;
		const root = cwd === undefined ? "of the folder claude runs in" : await rootOf(cwd);
		const msg = `${screen.msg}\nAnswering yes trusts the repository root ${root}, and with it every worktree of that repository.`;
		return { status: blockedOf({ ...screen, msg }), seq: (started + trustMs) * 1000 };
	}

	// By cwd, so every report of one dialog names the same root, the fallback too: a msg that changed is a new prompt.
	const roots = new Map<string, string>();
	/** The main checkout of the repo `cwd` is in; `cwd` itself when git cannot tell, as claude trusts a plain folder. */
	async function rootOf(cwd: string): Promise<string> {
		const known = roots.get(cwd);
		if (known !== undefined) return known;
		let root = cwd;
		try {
			root = (await mainCheckout(git, cwd)) ?? cwd;
		} catch (error) {
			onError(error as Error);
		}
		roots.set(cwd, root);
		return root;
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

	/** The block's screen as plain text, cut to its last SCREEN_BYTES: the whole scrollback can outgrow one reply. */
	async function readScreen(blockId: string): Promise<BlockedScreen> {
		const args = { format: "text", trim: true, max_bytes: SCREEN_BYTES };
		const first = await blockCall("format", blockId, FormatResultSchema, args);
		if (first.id === undefined || first.total === undefined || first.eof === true) {
			return readBlockedScreen(first.content);
		}
		let text = "";
		for (let offset = Math.max(0, first.total - SCREEN_BYTES); ; ) {
			const part = await blockCall("blob_read", blockId, BlobReadResultSchema, { id: first.id, offset });
			text += part.data;
			offset += Buffer.byteLength(part.data);
			if (part.eof || part.data === "") return readBlockedScreen(text);
		}
	}

	/** A press and a release, as `rex send-key` sends them, straight to the block so no key binding takes it. */
	async function press(blockId: string, key: NonNullable<ReturnType<typeof keyOf>>): Promise<void> {
		for (const action of ["press", "release"]) {
			await client.call(
				"block.event",
				{
					session_id: sessionId,
					block_id: blockId,
					event: { type: "key", payload: { ...key, mods: "", composing: false, action } },
				},
				EmptyResultSchema,
			);
		}
	}

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
		// Blocks a root record was seen for, whose trust-dialog check is over.
		const recorded = new Set<string>();
		// Blocks whose last emitted status was read off the screen, under a seq of the adapter's clock.
		const synthesized = new Set<string>();
		async function refresh(): Promise<Map<string, string | null>> {
			const fresh = new Map<string, string | null>();
			for (const [name, list] of await panes()) {
				for (const pane of list) fresh.set(pane.blockId, list.length === 1 ? name : null);
			}
			names = fresh;
			return fresh;
		}
		function report(
			blockId: string,
			name: string | null | undefined,
			status: AgentState,
			seq: number,
			synthetic = false,
		): void {
			if (name === undefined) return;
			if (name === null) {
				onError(new Error(`rex hangar ${sessionId}: two windows share block ${blockId}'s name`));
				return;
			}
			// The same seq is the same observation, which a resync re-reads. A lower one is a report the resync already
			// read past, whose event queued behind it; but a record rex stamped is never older than a dialog read off the
			// screen under the adapter's clock.
			const last = lastSeq.get(blockId);
			if (last !== undefined && seq <= last && (synthetic || !synthesized.has(blockId))) return;
			lastSeq.set(blockId, seq);
			if (synthetic) synthesized.add(blockId);
			else synthesized.delete(blockId);
			emit({ agent: name, status, seq });
		}

		/** Reports what the block shows; a trust dialog seen again goes under a new seq, above the last one emitted. */
		async function look(blockId: string, name: string | null): Promise<void> {
			const { seen, recorded: has } = await observe(blockId);
			if (has) recorded.add(blockId);
			if (seen === undefined) return;
			if (has) return report(blockId, name, seen.status, seen.seq);
			// A record that arrived while the screen was read is newer than the dialog.
			if (recorded.has(blockId)) return;
			const last = lastSeq.get(blockId);
			report(blockId, name, seen.status, last === undefined ? seen.seq : Math.max(now() * 1000, last + 1), true);
		}

		// One at a time, so a slow lookup is never overtaken by the block's next report.
		let queue = Promise.resolve();
		const enqueue = (work: () => Promise<void>) => {
			queue = queue.then(work).catch((error: Error) => onError(error));
		};
		const resync = () =>
			enqueue(async () => {
				const fresh = await refresh();
				await Promise.all([...fresh].map(([blockId, name]) => look(blockId, name)));
			});

		// claude draws the trust dialog without reporting anything, so a block without a record is looked at again.
		let checking = false;
		const trustCheck = setInterval(() => {
			if (checking) return;
			checking = true;
			enqueue(async () => {
				try {
					const known = names ?? (await refresh());
					const unrecorded = [...known].filter(([blockId]) => !recorded.has(blockId));
					await Promise.all(unrecorded.map(([blockId, name]) => look(blockId, name)));
				} finally {
					checking = false;
				}
			});
		}, trustMs);
		trustCheck.unref();

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
			// At once, so a dialog check whose screen read is in flight does not report past this record.
			recorded.add(blockId);
			const seq = seqOf(record);
			if (seq === undefined) return;
			enqueue(async () => {
				const known = names?.has(blockId) ? names : await refresh();
				if (!known.has(blockId) || !(await isClaude(blockId))) return;
				report(blockId, known.get(blockId), await statusOf(blockId, record), seq);
			});
		});
		const offConnected = client.onConnected(resync);
		void client.attach(sessionId).then(resync, (error: Error) => onError(error));
		return () => {
			clearInterval(trustCheck);
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
					const { seen } = await observe(blockId);
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

		// As herdr's: fresh status, fresh screen, then the keys read off that screen.
		async respond(agent: string, answer: Answer): Promise<AnswerOutcome> {
			const { blockId } = only(await panes(), agent);
			const [{ records }, claude] = await Promise.all([
				blockCall("program_status", blockId, ProgramStatusResultSchema),
				isClaude(blockId),
			]);
			const root = records.find(isRoot);
			// Without a record, the trust dialog is the one block claude can be in.
			if (root === undefined ? !claude : root.state !== "blocked") return { sent: false, refusal: "not_blocked" };
			const screen = await readScreen(blockId);
			if (root === undefined && !isTrustDialog(screen)) return { sent: false, refusal: "not_blocked" };
			const { kind, prompt } = screen;
			if (kind === "auth") return { sent: false, refusal: "auth" };
			if (prompt === undefined) return { sent: false, refusal: "unreadable" };
			if (prompt.fingerprint !== answer.fingerprint) return { sent: false, refusal: "stale" };
			if (!prompt.options.some((option) => option.id === answer.option)) {
				return { sent: false, refusal: "unknown_option" };
			}
			const keys = answerKeys(prompt, answer.option)?.map(keyOf);
			if (keys === undefined || keys.some((key) => key === undefined)) return { sent: false, refusal: "unreadable" };
			for (const [index, key] of keys.entries()) {
				if (index > 0) await new Promise((resolve) => setTimeout(resolve, keyGapMs));
				await press(blockId, key as NonNullable<typeof key>);
			}
			return { sent: true };
		},

		async stop(agent: string): Promise<void> {
			const { blockId } = only(await panes(), agent);
			await client.call("block.close", { session_id: sessionId, block_id: blockId }, BlockClosedResultSchema);
		},
	};
}
