import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodType } from "zod";
import type { RexClient } from "../../../src/adapters/rex/client.ts";
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

/**
 * An in-memory rex: the hangar's windows, each with one block, any other sessions, the clients connected, and every
 * call made on it. Each reply reads the arrays and blocks as they are then, so a test may change them between calls.
 */
export function rex(blocks: Block[], others: Session[] = [], clients: Client[] = []) {
	const calls: { method: string; payload: Record<string, unknown> }[] = [];
	const events = new Set<(event: SessionEvent) => void>();
	const connected = new Set<() => void>();
	const attached: string[] = [];
	const sessions = () => [{ id: HANGAR, label: "hangar", blocks }, ...others];
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
		"session.new_window": () => ({ window_id: "window:new", block_ids: ["block:new"], revision: 2 }),
		"block.close": (payload) => ({ block_id: payload.block_id, revision: 3 }),
		"block.event": () => ({}),
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
	const client: RexClient = {
		async call<T>(method: string, payload: unknown, schema: ZodType<T>): Promise<T> {
			calls.push({ method, payload: payload as Record<string, unknown> });
			const reply = replies[method];
			if (reply === undefined) throw new Error(`unexpected ${method}`);
			return schema.parse(reply(payload as Record<string, unknown>));
		},
		async attach(sessionId) {
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
		emit: (event: SessionEvent) => {
			for (const listener of events) listener(event);
		},
		status,
		reconnect: () => {
			for (const listener of connected) listener();
		},
		methods: () => calls.map((call) => call.method),
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
