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
	name: string;
	block: string;
	label?: string;
	argv0?: string;
	cwd?: string;
	records?: object[];
	screen?: string;
};

export const fixture = (name: string) =>
	readFileSync(join(import.meta.dirname, "../../agent-cli/permission/fixtures", name), "utf8");

/** An in-memory rex: the hangar's windows, each with one block, and every call made on it. */
export function rex(blocks: Block[]) {
	const calls: { method: string; payload: Record<string, unknown> }[] = [];
	const events = new Set<(event: SessionEvent) => void>();
	const connected = new Set<() => void>();
	const attached: string[] = [];
	const byId = (payload: Record<string, unknown>) => blocks.find((each) => each.block === payload.block_id);
	const replies: Record<string, (payload: Record<string, unknown>) => unknown> = {
		"session.view": () => ({
			revision: 1,
			session_id: HANGAR,
			windows: blocks.map(({ name, block, label }) => ({
				window_id: `window:${block}`,
				label: name,
				layers: [{ kind: "tiled", blocks: [{ block_id: block, ...(label === undefined ? {} : { label }) }] }],
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
				foreground: { pid: 9, user_id: 501, name: "2.1.310", argv0: found?.argv0 ?? "-fish", cwd: found?.cwd },
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
