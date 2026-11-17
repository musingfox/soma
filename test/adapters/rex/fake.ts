import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodType } from "zod";
import { type RexClient, RexRpcError } from "../../../src/adapters/rex/client.ts";
import type { SessionEvent } from "../../../src/adapters/rex/schema.ts";

export const HANGAR = "session:hangar";
export const SESSION = "0e9d6c1f-4a3b-4a52-9c85-2f6d3f6f2f10";
export const AT = "2026-10-27T01:02:03.456789+08:00";
/** AT in microseconds since the epoch. */
export const AT_US = Date.parse("2026-10-27T01:02:03+08:00") * 1000 + 456_789;

export type Block = {
	/** The label of the block's window. */
	name: string;
	block: string;
	label?: string;
	argv0?: string;
	cwd?: string;
	records?: object[];
	screen?: string;
	/** The foreground's pid; 9 by default. */
	pid?: number;
	/** The window the block is in, shared by the blocks of a split; its own window by default. */
	window?: string;
	/** Placed in no window. */
	detached?: boolean;
	/** The creator that made the block; rex's terminal by default. */
	creator?: string;
	/** When each client last asked for the block's size, by client id. */
	desired?: Record<string, string>;
};

/** A client connected to rex, as client.list reports it. */
export type Client = { id: string; kind?: string; state?: string };

/** A session other than the hangar. */
export type Session = { id: string; label: string; blocks: Block[] };

export const fixture = (name: string) =>
	readFileSync(join(import.meta.dirname, "../../agent-cli/permission/fixtures", name), "utf8");

/** `screen` with the cursor of its dialog one option on or back, wrapping as claude's does; as it was if none is drawn. */
function movedCursor(screen: string, by: 1 | -1): string {
	const lines = screen.split("\n");
	const from = lines.findLastIndex((line) => /^\s*❯ /.test(line));
	if (from === -1) return screen;
	let first = from;
	while (lines[first - 1]?.trim()) first -= 1;
	let last = from;
	while (lines[last + 1]?.trim()) last += 1;
	const count = last - first + 1;
	const to = first + ((from - first + by + count) % count);
	lines[from] = (lines[from] as string).replace("❯", " ");
	lines[to] = (lines[to] as string).replace(/^( *) {2}(?=\S)/, "$1❯ ");
	return lines.join("\n");
}

/**
 * An in-memory rex: the hangar's windows, each with one block, any other sessions, the clients connected, and every
 * call made on it. `hangar` is the hangar's label. Each reply reads the arrays and blocks as they are then, so a test may change them between calls.
 * A session `lose` names exists no more: rex answers any call naming it, an attach too, with session_not_found.
 * `session.create` makes an empty session, `session:made-<n>`, which `made` holds.
 */
export function rex(blocks: Block[], others: Session[] = [], clients: Client[] = [], hangar = "hangar") {
	const calls: { method: string; payload: Record<string, unknown> }[] = [];
	const events = new Set<(event: SessionEvent) => void>();
	const connected = new Set<() => void>();
	const attached: string[] = [];
	const gone = new Set<string>();
	const made: Session[] = [];
	const sessions = () => [{ id: HANGAR, label: hangar, blocks }, ...others, ...made].filter(({ id }) => !gone.has(id));
	const notFound = (method: string, session: unknown) =>
		typeof session === "string" && gone.has(session)
			? new RexRpcError(method, "session_not_found", `session ${session} not found`, 404)
			: undefined;
	const of = (payload: Record<string, unknown>) =>
		sessions().find((session) => session.id === payload.session_id)?.blocks ?? [];
	const byId = (payload: Record<string, unknown>) => of(payload).find((each) => each.block === payload.block_id);
	const windowOf = (block: Block) => block.window ?? `window:${block.block}`;
	const replies: Record<string, (payload: Record<string, unknown>) => unknown> = {
		"session.view": (payload) => {
			const windows = new Map<string, { label: string; blocks: object[] }>();
			for (const each of of(payload)) {
				if (each.detached) continue;
				const window = windows.get(windowOf(each)) ?? { label: each.name, blocks: [] };
				const { block, label } = each;
				window.blocks.push({ block_id: block, ...(label === undefined ? {} : { label }) });
				windows.set(windowOf(each), window);
			}
			return {
				revision: 1,
				session_id: payload.session_id,
				windows: [...windows].map(([id, window]) => ({
					window_id: id,
					label: window.label,
					layers: [{ kind: "tiled", blocks: window.blocks }],
				})),
			};
		},
		"session.attach_all": () => ({
			sessions: sessions().map(({ id, label }) => ({ session_id: id, label })),
		}),
		"session.list_blocks": (payload) => ({
			blocks: of(payload).map((block) => ({
				block_id: block.block,
				label: block.label ?? "shell",
				creator_name: block.creator ?? "com.superlogical.terminal",
				placement: block.detached ? "detached" : "placed",
				...(block.detached ? {} : { window_id: windowOf(block) }),
			})),
		}),
		"client.list": () => ({
			clients: clients.map(({ id, kind, state }) => ({
				client_id: id,
				...(kind === undefined ? {} : { info: { kind } }),
				...(state === undefined ? {} : { connection_state: state }),
			})),
		}),
		"com.superlogical.terminal.size": (payload) => ({
			columns: 80,
			rows: 24,
			desired: Object.entries(byId(payload)?.desired ?? {}).map(([client_id, updated_at]) => ({
				client_id,
				columns: 80,
				rows: 24,
				updated_at,
			})),
		}),
		"session.create": (payload) => {
			const id = `session:made-${made.length + 1}`;
			made.push({ id, label: String(payload.label ?? "quiet-meadow"), blocks: [] });
			return { session_id: id };
		},
		"session.new_window": () => ({ window_id: "window:new", block_ids: ["block:new"], revision: 2 }),
		"block.close": (payload) => ({ block_id: payload.block_id, revision: 3 }),
		// An arrow moves the cursor drawn on the block's screen, as claude redraws it.
		"block.event": (payload) => {
			const found = byId(payload);
			const { type, payload: key } = payload.event as { type: string; payload: { key?: string; action?: string } };
			const by = { arrow_down: 1, arrow_up: -1 }[key.key ?? ""] as 1 | -1 | undefined;
			if (found?.screen !== undefined && type === "key" && key.action === "press" && by !== undefined) {
				found.screen = movedCursor(found.screen, by);
			}
			return {};
		},
		"com.superlogical.terminal.write": (payload) => ({
			bytes_written: String((payload.args as { data: string }).data).length,
		}),
		"com.superlogical.terminal.program_status": (payload) => ({ records: byId(payload)?.records ?? [] }),
		"com.superlogical.terminal.format": (payload) => ({ content: byId(payload)?.screen ?? "" }),
		"com.superlogical.terminal.process": (payload) => {
			const found = byId(payload);
			return {
				last_exit: null,
				foreground: {
					pid: found?.pid ?? 9,
					user_id: 501,
					name: "2.1.310",
					argv0: found?.argv0 ?? "-fish",
					cwd: found?.cwd,
				},
			};
		},
	};
	const originals = { ...replies };
	const client: RexClient = {
		async call<T>(method: string, payload: unknown, schema: ZodType<T>): Promise<T> {
			calls.push({ method, payload: payload as Record<string, unknown> });
			const lost = notFound(method, (payload as { session_id?: unknown } | undefined)?.session_id);
			if (lost !== undefined) throw lost;
			const reply = replies[method];
			if (reply === undefined) throw new Error(`unexpected ${method}`);
			return schema.parse(reply(payload as Record<string, unknown>));
		},
		async attach(sessionId) {
			const lost = notFound("session.attach", sessionId);
			if (lost !== undefined) throw lost;
			attached.push(sessionId);
		},
		onSessionEvent(listener) {
			events.add(listener);
			return () => events.delete(listener);
		},
		onConnected(listener) {
			connected.add(listener);
			return () => connected.delete(listener);
		},
		close() {},
	};
	const status = (block: string, record: object, id = "") =>
		({
			session_id: HANGAR,
			event: {
				type: "block_event",
				payload: {
					block_id: block,
					creator_name: "com.superlogical.terminal",
					name: "program_status_changed",
					payload: { id, record, reason: "report" },
				},
			},
		}) satisfies SessionEvent;
	return {
		client,
		calls,
		attached,
		made,
		/** The session, the hangar unless named, exists no more. */
		lose: (id = HANGAR) => {
			gone.add(id);
		},
		emit: (event: SessionEvent) => {
			for (const listener of events) listener(event);
		},
		status,
		reconnect: () => {
			for (const listener of connected) listener();
		},
		methods: () => calls.map((call) => call.method),
		/** Answers `method` from now on with `reply` instead, which may throw or return what the schema rejects. */
		replace: (method: string, reply: (payload: Record<string, unknown>) => unknown) => {
			replies[method] = reply;
		},
		/** What `method` answered before any replacement. */
		original: (method: string) => {
			const reply = originals[method];
			if (reply === undefined) throw new Error(`unexpected ${method}`);
			return reply;
		},
	};
}

export function git(porcelain = "", branches = "") {
	const runs: string[][] = [];
	return {
		runs,
		git: async (repo: string, args: readonly string[]) => {
			runs.push([repo, ...args]);
			if (args[0] === "worktree" && args[1] === "list") return porcelain;
			if (args[0] === "branch") return branches;
			return "";
		},
	};
}
