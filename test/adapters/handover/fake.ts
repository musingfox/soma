import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AcpAgentPort } from "../../../src/adapters/acp/agent-port.ts";
import { createHandoverAgentPort, HANDOVER_GRACE_MS } from "../../../src/adapters/handover/agent-port.ts";
import { createRexAgentPort } from "../../../src/adapters/rex/agent-port.ts";
import { harness as acpHarness, sleep } from "../acp/fake.ts";
import { AT, type Block, HANGAR, rex, type Session } from "../rex/fake.ts";

export const AT_IDLE = { state: "idle", updated_at: AT };

/** A clock only a test moves. */
export function fakeClock(start = 1_700_000_000_000) {
	let at = start;
	return {
		now: () => at,
		advance: (ms: number) => {
			at += ms;
		},
	};
}

/**
 * Jobs on two sides, as main.ts wires them: the real ACP adapter running the fake agent, and the real rex adapter on the
 * in-memory rex, whose new window becomes a block with `opened` over a claude that reports idle. `blocks` holds the
 * hangar's, `others` the human's sessions. Given `restartOf`, the cwd of another `sides`, it is that soma restarted.
 */
export async function sides(
	options: {
		restartOf?: string;
		blocks?: Block[];
		others?: Session[];
		opened?: Partial<Block>;
		fake?: Record<string, string>;
		takeMs?: number;
		/** Rex answers nothing from the start, until the `rexUp` of the result. */
		rexDown?: boolean;
		/** The clock of the handover, whose grace period is then the real one unless `graceMs` names another. */
		clock?: ReturnType<typeof fakeClock>;
		/** None by default, so a job with no window goes back to ACP at the first look. */
		graceMs?: number;
		/** How often a job rex did not answer about is looked at again: `graceMs`, or 60 s where that is none. */
		relookMs?: number;
		/** How soon a failed listing of a job on rex is made again: 5 s by default. */
		relistMs?: number;
		/** How long a cut waits for a turn to stop. */
		cutMs?: number;
		/** How long after an idle the rex side looks at its claude's pid file again: the adapter's own by default. */
		clearMs?: number;
		/** Each side as the handover sees it, to hang or fail one of its calls. */
		from?: (port: AcpAgentPort) => AcpAgentPort;
		to?: (port: ReturnType<typeof createRexAgentPort>) => ReturnType<typeof createRexAgentPort>;
	} = {},
) {
	const acp = await acpHarness({
		cwd: options.restartOf,
		...(options.fake ? { fake: options.fake } : {}),
		...(options.cutMs === undefined ? {} : { cutMs: options.cutMs }),
	});
	const projects = join(acp.cwd, "..", "projects");
	const sessionsDir = join(acp.cwd, "..", "sessions");
	const blocks = options.blocks ?? [];
	const hangar = rex(blocks, options.others ?? []);
	let windows = 0;
	hangar.replace("session.new_window", ({ window_label, layout }) => {
		const { label, options: opening } = (layout as { block: { label: string; options: { cwd: string } } }).block;
		const block = `block:new-${++windows}`;
		const name = window_label as string;
		blocks.push({ name, block, label, argv0: "claude", cwd: opening.cwd, records: [AT_IDLE], ...options.opened });
		return { window_id: `window:${block}`, block_ids: [block], revision: 2 };
	});
	hangar.replace("block.close", ({ block_id }) => {
		blocks.splice(
			blocks.findIndex((each) => each.block === block_id),
			1,
		);
		return { block_id, revision: 3 };
	});
	const { call, attach } = hangar.client;
	const away = () => Promise.reject(new Error("rex is away"));
	const rexDown = () => {
		hangar.client.call = away;
		hangar.client.attach = away;
	};
	const rexUp = () => {
		hangar.client.call = call;
		hangar.client.attach = attach;
	};
	if (options.rexDown) rexDown();
	const onRex = createRexAgentPort({
		client: hangar.client,
		sessionId: HANGAR,
		projectsDir: projects,
		sessionsDir,
		processStart: async () => undefined,
		env: { SOMA_SOCKET: "/run/soma.sock" },
		path: "/opt/soma/bin",
		confirmMs: 10,
		replyMs: 100,
		recheckMs: 50,
		redrawMs: 5,
		keyGapMs: 1,
		settleMs: 0,
		takeMs: options.takeMs ?? 200,
		...(options.clearMs === undefined ? {} : { clearMs: options.clearMs }),
		onError: () => {},
	});
	const said: string[] = [];
	const onError = (error: Error) => said.push(error.message);
	const { clock, graceMs = clock === undefined ? 0 : HANDOVER_GRACE_MS } = options;
	const { relookMs = graceMs || HANDOVER_GRACE_MS } = options;
	const agents = createHandoverAgentPort({
		from: options.from?.(acp.port) ?? acp.port,
		to: options.to?.(onRex) ?? onRex,
		onError,
		graceMs,
		relookMs,
		...(options.relistMs === undefined ? {} : { relistMs: options.relistMs }),
		...(clock === undefined ? {} : { now: clock.now }),
	});
	return {
		acp,
		agents,
		hangar,
		blocks,
		onRex,
		rexDown,
		rexUp,
		said,
		onError,
		windowsOpened: () => hangar.calls.filter((call) => call.method === "session.new_window"),
		typed: () =>
			hangar.calls
				.filter((call) => call.method === "block.event")
				.flatMap(({ payload }) => {
					const { event } = payload as { event: { type: string; payload: { text?: string } } };
					return event.type === "paste" ? [event.payload.text] : [];
				}),
		entry: async (name = "card-a") =>
			JSON.parse(await readFile(acp.sessionsFile, "utf8"))[name] as {
				acpSessionId: string;
				cwd: string;
				handedOver?: true;
				handingOver?: true;
				hangar?: string;
				handingOverAt?: number;
				windowAskedAt?: number;
				givenBack?: number;
				model?: string;
			},
		/** Lets go of what `FAKE_ACP_HELD` holds. */
		release: async (what: "new" | "load" | "stop") => {
			await mkdir(projects, { recursive: true });
			await writeFile(join(projects, `release-${what}`), "");
		},
		closed: () => readFile(join(projects, "closed"), "utf8").catch(() => ""),
		cancelled: () => readFile(join(projects, "cancelled"), "utf8").catch(() => ""),
		pids: async () =>
			(await readFile(join(acp.cwd, "..", `pids-${acp.instance}`), "utf8").catch(() => ""))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => Number(line.split(" ")[1])),
		/** Starts card-a over ACP and runs one turn on it, so it is at rest with a transcript. */
		ran: async (name = "card-a", prompt = "the word is KIWI") => {
			await acp.start(name);
			await acp.until("idle", 0, name);
			const from = acp.events.length;
			await agents.prompt(name, prompt);
			await acp.until("done", from, name);
		},
		/** The claude of the hangar's last window is in `sessionId` from now on, as a /clear leaves its pid file. */
		cleared: async (sessionId: string) => {
			const pid = blocks.at(-1)?.pid ?? 9;
			await mkdir(sessionsDir, { recursive: true });
			await writeFile(join(sessionsDir, `${pid}.json`), JSON.stringify({ pid, sessionId, status: "idle" }));
		},
		/** Appends a user turn and its reply to the session's transcript, as the window's claude writes them. */
		wrote: (session: { acpSessionId: string; cwd: string }, reply: string) => {
			const directory = join(projects, session.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
			mkdirSync(directory, { recursive: true });
			const id = `${Date.now()}-${Math.random()}`;
			const record = (type: string, uuid: string, message: object) =>
				`${JSON.stringify({ type, uuid, cwd: session.cwd, message })}\n`;
			appendFileSync(
				join(directory, `${session.acpSessionId}.jsonl`),
				record("user", `u-${id}`, { role: "user", content: "again" }) +
					record("assistant", `a-${id}`, {
						id: `m-${id}`,
						role: "assistant",
						content: [{ type: "text", text: reply }],
					}),
			);
		},
	};
}

export const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

export { sleep };
