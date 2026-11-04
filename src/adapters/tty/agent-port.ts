import { constants } from "node:fs";
import { copyFile, stat } from "node:fs/promises";
import { join } from "node:path";
import xterm from "@xterm/headless";
import { readPerfCoresViaSysctl, resolveHangarCapWithSource } from "../../agent-cli/hangar-cap.ts";
import {
	answerKeys,
	type BlockedScreen,
	isTrustDialog,
	readBlockedScreen,
} from "../../agent-cli/permission/blocked-screen.ts";
import { awaitingReply, readLastRecord, resolveTranscriptPath } from "../../agent-cli/transcript.ts";
import { type Git, mainCheckout, openWorktree, runGit } from "../../agent-cli/worktree.ts";
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

type Disposable = { dispose(): void };

/** The part of a node-pty terminal the adapter uses. */
export interface Pty {
	onData(listener: (data: string) => void): Disposable;
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable;
	write(data: string): void;
	kill(signal?: string): void;
}

export type SpawnPty = (
	file: string,
	args: string[],
	options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => Pty;

export interface TtyAgentPortOptions {
	/** node-pty's spawn; injected so tests never load the native module. */
	readonly spawn: SpawnPty;
	readonly cap?: number;
	/** The agent's command; defaults to `claude`, found on PATH. */
	readonly command?: string;
	/** Where claude keeps its transcripts; defaults to ~/.claude/projects. */
	readonly projectsDir?: string;
	readonly git?: Git;
	/** The environment claude starts with, less the marks of a claude session soma itself may run in. */
	readonly env: NodeJS.ProcessEnv;
	/** How long a sent prompt may take to turn the agent working before `\r` is sent once more. */
	readonly confirmMs?: number;
	/** Pause between the keys of one answer, so claude reads an arrow and the Enter after it as two keys. */
	readonly keyGapMs?: number;
	/** How long claude may run without a record before its screen is read for the trust dialog. */
	readonly trustMs?: number;
	/** How long readResult waits for claude to write the reply to a turn it reported over. */
	readonly replyMs?: number;
	/** How long after a read that replyMs cut short the turn's end is reported again, so the core reads it once more. */
	readonly recheckMs?: number;
	/** Pause between reads of a blocked screen that did not parse yet; claude may still be drawing it. */
	readonly redrawMs?: number;
	readonly now?: () => number;
	readonly onError?: (error: Error) => void;
}

const COLS = 120;
const ROWS = 40;
const BLOCKED_KINDS: readonly string[] = ["permission", "question", "auth"] satisfies BlockedKind[];
// Reads of a blocked record's screen, redrawMs apart, before it is taken not to parse.
const BLOCKED_READS = 3;
// What a running claude hands its children to mark them as its own session. Inherited from a soma started inside
// claude, CLAUDE_CODE_CHILD_SESSION turns off the agent's transcript, which readResult reads.
const PARENT_SESSION_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(CHILD_SESSION|SESSION_\w+|MESSAGING_\w+|ENTRYPOINT))$/;
// The OSC 7501 feature-detection reply: claude reports its status only to a terminal that answers the probe.
const PROBE_REPLY = "\x1b]7501;?\x1b\\";

/** One agent: claude in a pty soma holds, with the emulator that keeps its screen. */
type Agent = {
	readonly name: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly pty: Pty;
	readonly term: InstanceType<typeof xterm.Terminal>;
	readonly startedAt: number;
	/** The root record as claude last reported it; undefined before the first report and after a clear. */
	record?: AgentState;
	/** What the adapter last emitted, and under which seq. */
	seen?: { readonly status: AgentState; readonly seq: number };
	/** A working seen and not yet ended; when the last one ended, in ms, while no working followed. */
	turning: boolean;
	turnEnded?: number;
	exited: boolean;
	/** The agent's work, one at a time, so a slow screen read is never overtaken by its next report. */
	queue: Promise<void>;
	recheck?: NodeJS.Timeout;
};

/** OSC 7501's own vocabulary, which the port shares; a blocked record without a kind is taken as a permission prompt. */
export function stateOf(pairs: ReadonlyMap<string, string>): AgentState | undefined {
	const state = pairs.get("state");
	const msg = pairs.get("msg");
	const text = msg === undefined ? {} : { msg };
	if (state === "blocked") {
		const kind = pairs.get("kind") ?? "";
		return { state, kind: BLOCKED_KINDS.includes(kind) ? (kind as BlockedKind) : "permission", ...text };
	}
	if (state === "idle" || state === "working" || state === "done" || state === "error") return { state, ...text };
	return undefined;
}

/** An OSC 7501 report's pairs, with msg and title decoded; `?` is the probe and parses to undefined. */
export function parseReport(body: string): Map<string, string> | undefined {
	if (body.trim() === "?") return undefined;
	const pairs = new Map<string, string>();
	for (const pair of body.split(":")) {
		const at = pair.indexOf("=");
		if (at <= 0) continue;
		const key = pair.slice(0, at).trim();
		const value = pair.slice(at + 1).trim();
		pairs.set(key, key === "msg" || key === "title" ? Buffer.from(value, "base64").toString("utf8") : value);
	}
	return pairs;
}

function blockedOf({ kind, msg, prompt }: BlockedScreen): AgentState {
	const options = prompt?.options.map(({ id, label }) => ({ id, label }));
	return { state: "blocked", kind, msg, ...(prompt ? { fingerprint: prompt.fingerprint, options } : {}) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs each card's claude in a pty soma holds itself, in its own `fleet/<card>` worktree, with no multiplexer. The
 * agents die with soma, and no human can look at their screens (ARCHITECTURE.md "How agent-side adapters differ").
 */
export function createTtyAgentPort(options: TtyAgentPortOptions): AgentPort {
	const { spawn } = options;
	const command = options.command ?? "claude";
	const git = options.git ?? runGit;
	const confirmMs = options.confirmMs ?? 3_000;
	const keyGapMs = options.keyGapMs ?? 200;
	const trustMs = options.trustMs ?? 3_000;
	const replyMs = options.replyMs ?? 2_000;
	const recheckMs = options.recheckMs ?? 10_000;
	const redrawMs = options.redrawMs ?? 500;
	const now = options.now ?? Date.now;
	const onError = options.onError ?? ((error: Error) => console.warn(`[tty] ${error.message}`));
	const cap = options.cap ?? resolveHangarCapWithSource(undefined, readPerfCoresViaSysctl).cap;

	const agents = new Map<string, Agent>();
	const listeners = new Set<(event: AgentStatusEvent) => void>();
	let lastSeq = 0;
	// Microseconds of the adapter's clock, never repeated: the agents live no longer than this process does.
	const nextSeq = () => {
		lastSeq = Math.max(now() * 1000, lastSeq + 1);
		return lastSeq;
	};

	function emit(agent: Agent, status: AgentState): void {
		const seq = nextSeq();
		agent.seen = { status, seq };
		if (status.state === "working") agent.turning = true;
		else if (status.state !== "blocked") {
			agent.turnEnded = agent.turning ? now() : undefined;
			agent.turning = false;
		}
		if (status.state === "working" || status.state === "blocked") clearTimeout(agent.recheck);
		for (const listener of listeners) listener({ agent: agent.name, status, seq });
	}

	const enqueue = (agent: Agent, work: () => Promise<void>) => {
		agent.queue = agent.queue.then(work).catch((error: Error) => onError(error));
	};

	function screenText(agent: Agent): string {
		const buffer = agent.term.buffer.active;
		const lines: string[] = [];
		for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
		while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
		return lines.join("\n");
	}

	/** The emulator's screen once every byte the pty sent so far is parsed. */
	const readScreen = (agent: Agent) =>
		new Promise<BlockedScreen>((resolve) => agent.term.write("", () => resolve(readBlockedScreen(screenText(agent)))));

	/** A blocked record's status with the prompt read off the screen, read again while it does not parse yet. */
	async function statusOf(agent: Agent, record: AgentState): Promise<AgentState> {
		if (record.state !== "blocked") return record;
		let screen = await readScreen(agent);
		for (let read = 1; read < BLOCKED_READS && screen.prompt === undefined; read++) {
			await sleep(redrawMs);
			screen = await readScreen(agent);
		}
		return screen.prompt === undefined ? record : blockedOf(screen);
	}

	/** The main checkout of the repo `cwd` is in; `cwd` itself when git cannot tell, as claude trusts a plain folder. */
	async function rootOf(cwd: string): Promise<string> {
		try {
			return (await mainCheckout(git, cwd)) ?? cwd;
		} catch (error) {
			onError(error as Error);
			return cwd;
		}
	}

	/** claude's folder-trust dialog, which it draws before it reports any record. */
	async function trustDialog(agent: Agent): Promise<void> {
		if (agent.exited || agent.record !== undefined || now() - agent.startedAt < trustMs) return;
		const screen = await readScreen(agent);
		if (!isTrustDialog(screen) || agent.record !== undefined) return;
		const seen = agent.seen?.status;
		if (seen?.state === "blocked" && seen.fingerprint === screen.prompt?.fingerprint) return;
		const msg = `${screen.msg}\nAnswering yes trusts the repository root ${await rootOf(agent.cwd)}, and with it every worktree of that repository.`;
		emit(agent, blockedOf({ ...screen, msg }));
	}

	const trustCheck = setInterval(() => {
		for (const agent of agents.values()) enqueue(agent, () => trustDialog(agent));
	}, trustMs);
	trustCheck.unref();

	function launch(request: StartRequest, cwd: string): Agent {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(options.env)) {
			if (value !== undefined && !PARENT_SESSION_ENV.test(key)) env[key] = value;
		}
		const pty = spawn(command, ["--session-id", request.sessionId], {
			name: "xterm-256color",
			cols: COLS,
			rows: ROWS,
			cwd,
			env,
		});
		const term = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
		const agent: Agent = {
			name: request.name,
			sessionId: request.sessionId,
			cwd,
			pty,
			term,
			startedAt: now(),
			turning: false,
			exited: false,
			queue: Promise.resolve(),
		};
		term.parser.registerOscHandler(7501, (body) => {
			const pairs = parseReport(body);
			if (pairs === undefined) {
				pty.write(PROBE_REPLY);
				return true;
			}
			// Subagents report child records under an id; the agent is the root record.
			if ((pairs.get("id") ?? "") !== "") return true;
			if (pairs.get("state") === "clear") {
				agent.record = undefined;
				return true;
			}
			const record = stateOf(pairs);
			if (record === undefined) return true;
			agent.record = record;
			enqueue(agent, async () => {
				const status = await statusOf(agent, record);
				// A block whose screen read saw a later report is over; that report follows in the queue.
				if (record.state === "blocked" && agent.record !== record) return;
				emit(agent, status);
			});
			return true;
		});
		// The emulator answers the terminal's other queries, such as the cursor position, itself.
		term.onData((data) => pty.write(data));
		pty.onData((data) => term.write(data));
		pty.onExit(({ exitCode }) => {
			agent.exited = true;
			clearTimeout(agent.recheck);
			if (agents.get(agent.name) !== agent) return;
			// After the emulator parsed what claude wrote before it exited, whose reports come first.
			term.write("", () =>
				enqueue(agent, async () => emit(agent, { state: "error", msg: `claude exited with code ${exitCode}` })),
			);
		});
		return agent;
	}

	function only(name: string): Agent {
		const agent = agents.get(name);
		if (agent === undefined) throw new Error(`tty has no agent named ${name}`);
		return agent;
	}

	const keyOf = (agent: Agent, name: string): string | undefined => {
		if (/^\d$/.test(name)) return name;
		const arrow = agent.term.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[";
		return { Up: `${arrow}A`, Down: `${arrow}B`, Enter: "\r" }[name];
	};

	/** Resolves true once the agent reports working, false when `ms` passes first. */
	async function turnsWorking(agent: Agent, ms: number): Promise<boolean> {
		for (const deadline = now() + ms; now() < deadline; await sleep(50)) {
			if (agent.record?.state === "working") return true;
		}
		return agent.record?.state === "working";
	}

	/** Reports the agent's status again under a new seq, unless it went on to work or to a prompt since. */
	function scheduleRecheck(agent: Agent): void {
		clearTimeout(agent.recheck);
		agent.recheck = setTimeout(() => {
			enqueue(agent, async () => {
				const status = agent.seen?.status;
				if (agent.exited || status === undefined || status.state === "working" || status.state === "blocked") return;
				emit(agent, status);
			});
		}, recheckMs);
		agent.recheck.unref();
	}

	return {
		async start(request: StartRequest): Promise<void> {
			const existing = agents.get(request.name);
			if (existing !== undefined && !existing.exited)
				throw new Error(`tty already runs an agent named ${request.name}`);
			const running = [...agents.values()].filter((agent) => !agent.exited).length;
			if (running >= cap) throw new Error(`hangar is full: ${running} of ${cap} agents running`);
			const path = await openWorktree(git, request.cwd, request.card);
			// obw finds its vault through this untracked file, which a fresh worktree lacks.
			await copyFile(join(request.cwd, ".obsidian.yaml"), join(path, ".obsidian.yaml"), constants.COPYFILE_EXCL).catch(
				(error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT" && error.code !== "EEXIST") throw error;
				},
			);
			// Checked again: another start of the same name may have got here while git ran.
			if (agents.get(request.name)?.exited === false)
				throw new Error(`tty already runs an agent named ${request.name}`);
			agents.set(request.name, launch(request, path));
		},

		// Only rex resumes an agent for now (ARCHITECTURE.md "Agent-deferred instructions").
		resume: () => Promise.reject(new Error("tty AgentPort: resume is not implemented")),

		async list(): Promise<readonly AgentListing[]> {
			return [...agents.values()].map((agent) => ({
				name: agent.name,
				sessionId: agent.sessionId,
				...(agent.seen === undefined ? {} : agent.seen),
			}));
		},

		async prompt(agent: string, text: string): Promise<void> {
			const target = only(agent);
			if (target.exited) throw new Error(`tty agent ${agent} has exited: a prompt would go nowhere`);
			const state = target.record?.state;
			// Typed into a prompt, the text's `\r` would choose the highlighted option.
			if (state !== "idle" && state !== "done") {
				throw new Error(
					`tty agent ${agent} is ${state ?? "without a status record"}: a prompt goes only to idle or done`,
				);
			}
			// A bracketed paste keeps a multi-line prompt one message.
			const paste = target.term.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text;
			target.pty.write(paste);
			target.pty.write("\r");
			// Only an idle claude can still hold the text unsent; on any other screen `\r` would answer a prompt.
			if (!(await turnsWorking(target, confirmMs)) && target.record?.state === "idle") target.pty.write("\r");
		},

		onStatus(listener: (event: AgentStatusEvent) => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		/**
		 * What the agent's claude transcript ends on, as the rex adapter reads it: claude writes a turn's records only
		 * after it reported the turn over, so after a turn end the transcript is read once it was written since then and
		 * does not end awaiting the reply, or as it is when replyMs passes first, with the end reported again later.
		 */
		async readResult(agent: string): Promise<AgentResult | undefined> {
			// An agent a restart lost has no transcript this process can name.
			const target = agents.get(agent);
			if (target === undefined) return undefined;
			await target.queue;
			const ended = target.turnEnded;
			for (const deadline = now() + replyMs; ; ) {
				const path = await resolveTranscriptPath(target.sessionId, target.cwd, options.projectsDir);
				if (ended === undefined) return path === undefined ? undefined : readLastRecord(path);
				const written = path !== undefined && (await stat(path)).mtimeMs >= ended;
				if (written && !(await awaitingReply(path))) return readLastRecord(path);
				if (now() >= deadline) {
					scheduleRecheck(target);
					return path === undefined ? undefined : readLastRecord(path);
				}
				await sleep(100);
			}
		},

		async respond(agent: string, answer: Answer): Promise<AnswerOutcome> {
			const target = agents.get(agent);
			const record = target?.record;
			// Without a record, the trust dialog is the one block claude can be in. An agent a restart lost waits on nothing.
			if (target === undefined || target.exited || (record !== undefined && record.state !== "blocked")) {
				return { sent: false, refusal: "not_blocked" };
			}
			const screen = await readScreen(target);
			if (record === undefined && !isTrustDialog(screen)) return { sent: false, refusal: "not_blocked" };
			const { kind, prompt } = screen;
			if (kind === "auth") return { sent: false, refusal: "auth" };
			if (prompt === undefined) return { sent: false, refusal: "unreadable" };
			if (prompt.fingerprint !== answer.fingerprint) return { sent: false, refusal: "stale" };
			if (!prompt.options.some((option) => option.id === answer.option)) {
				return { sent: false, refusal: "unknown_option" };
			}
			const keys = answerKeys(prompt, answer.option)?.map((key) => keyOf(target, key));
			if (keys === undefined || keys.some((key) => key === undefined)) return { sent: false, refusal: "unreadable" };
			for (const [index, key] of keys.entries()) {
				if (index > 0) await sleep(keyGapMs);
				target.pty.write(key as string);
			}
			return { sent: true };
		},

		async stop(agent: string): Promise<void> {
			const target = only(agent);
			agents.delete(agent);
			clearTimeout(target.recheck);
			if (!target.exited) target.pty.kill();
			target.term.dispose();
		},
	};
}
