import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, copyFile, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	type ClientConnection,
	client,
	methods,
	ndJsonStream,
	type PermissionOption,
	PROTOCOL_VERSION,
	type PromptResponse,
	RequestError,
	type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { agentEnv } from "../../agent-cli/env.ts";
import { readPerfCoresViaSysctl, resolveHangarCapWithSource } from "../../agent-cli/hangar-cap.ts";
import {
	awaitingReply,
	readConversationTail,
	readLastRecord,
	resolveTranscriptPath,
} from "../../agent-cli/transcript.ts";
import { type Git, openWorktree, runGit } from "../../agent-cli/worktree.ts";
import {
	type AgentListing,
	type AgentPort,
	type AgentResult,
	type AgentState,
	type AgentStatusEvent,
	type Answer,
	type AnswerOutcome,
	NotImplemented,
	PromptRefused,
	type ResumeRequest,
	type StartRequest,
} from "../../ports/agent.ts";
import { drawTranscript } from "./screen.ts";

export interface AcpAgentPortOptions {
	/** The environment the ACP agent starts with, less the marks of a claude session soma itself may run in. */
	readonly env: NodeJS.ProcessEnv;
	/** Set in every agent's environment, next to `SOMA_AGENT`, which names the agent's card. */
	readonly vars?: Readonly<Record<string, string>>;
	/** A directory put first on every agent's PATH, so its tools find soma's own commands. */
	readonly path?: string;
	/** The ACP agent to run, one process per job; defaults to claude-agent-acp on the node soma runs on. */
	readonly command?: string;
	readonly args?: readonly string[];
	readonly cap?: number;
	/** Where claude keeps its transcripts; defaults to ~/.claude/projects. */
	readonly projectsDir?: string;
	readonly git?: Git;
	/**
	 * Where each agent's ACP session id and cwd are kept, and whether soma stopped it. As it is made, the port lists each
	 * agent it holds that soma did not stop and that ran a prompt as dormant, with no process; the first prompt to one
	 * starts it in the session it ran, with session/load, and so does a resume of one soma stopped. Kept nowhere when
	 * unset, so a resume finds only the agents this port ran.
	 */
	readonly sessionsFile?: string;
	/** How long the agent may take to answer initialize, and a restarted one session/load, before it is given up. */
	readonly startMs?: number;
	/** How long stop waits for session/close before it ends the process anyway. */
	readonly closeMs?: number;
	/** How long readResult waits for claude to write the reply to a turn the agent reported over. */
	readonly replyMs?: number;
	/**
	 * How long after a read that replyMs cut short the turn's end is reported again, so the core reads it once more; and
	 * how often an agent's first idle is reported again until its first prompt, so a core that lists the job only after
	 * that idle still sends the brief.
	 */
	readonly recheckMs?: number;
	readonly now?: () => number;
	readonly onError?: (error: Error) => void;
}

/** A permission request the agent waits on, with the status that shows it and the answer that ends it. */
type Asked = {
	readonly fingerprint: string;
	readonly options: readonly PermissionOption[];
	readonly status: AgentState;
	/** Answers the request with the option of that id, or cancelled with none. */
	readonly answer: (optionId?: string) => void;
};

/** One agent: an ACP agent process soma holds, running one session in the card's worktree. */
type Agent = {
	readonly name: string;
	readonly card: string;
	/** The one its StartRequest carried; the ACP session id is the agent's own. */
	readonly sessionId: string;
	/** The worktree's realpath, which claude names the transcript's directory after. */
	readonly cwd: string;
	readonly child: ChildProcess;
	readonly connection: ClientConnection;
	/** The id session/new answered with; undefined until it did. */
	session?: string;
	/** What the adapter last emitted, and under which seq. */
	seen?: { readonly status: AgentState; readonly seq: number };
	/** A prompt is out whose response has not come. */
	turning: boolean;
	/** The last end emitted closed a turn, so readResult waits for the turn to be written. */
	ended: boolean;
	/** The transcript's last record when the turn was prompted: the turn is written once it ends on another. */
	before?: string;
	/** The permission requests the agent waits on, in the order it asked; the status shows the first. */
	asked: Asked[];
	/** How many permission requests it made, so a request asked again has its own fingerprint. */
	requests: number;
	exited: boolean;
	stopped: boolean;
	/** The tail of what the process wrote to stderr, for the error of an exit. */
	stderr: string;
	recheck?: NodeJS.Timeout;
};

type Session = {
	readonly card: string;
	readonly sessionId: string;
	readonly acpSessionId: string;
	readonly cwd: string;
	/** soma stopped the agent, so a restart lists it no more; a resume starts it again and takes this off. */
	readonly stopped?: true;
};

/**
 * An agent soma did not stop, found in the sessions file as the port was made: listed, with no process and no status,
 * until a prompt wakes it in its session.
 */
type Dormant = {
	readonly name: string;
	readonly session: Session;
	/** What the adapter last emitted for it: the error of a wake that failed. */
	seen?: { readonly status: AgentState; readonly seq: number };
	/** The wake under way, which the hangar cap counts as a process. */
	waking?: Promise<Agent>;
};

/** The ACP AgentPort, and the agents it found dormant as it was made. */
export type AcpAgentPort = AgentPort & {
	/** The names of the agents the port listed dormant as it was made, from the soma before it; empty when none. */
	dormant(): Promise<readonly string[]>;
};

const AUTH_REQUIRED = RequestError.authRequired().code;
const STDERR_BYTES = 4096;
// As many lines as the screen tool shows at most, and the tail window that is read for them, which grows until it
// holds them or the whole transcript, up to its cap.
const SCREEN_LINES = 400;
const SCREEN_BYTES = 256 * 1024;
const SCREEN_MAX_BYTES = 16 * 1024 * 1024;

export const defaultAcpCommand = () => ({
	command: process.execPath,
	args: [fileURLToPath(import.meta.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js"))],
});

/**
 * What the human reads for a call the agent refused for want of a login, `session/prompt` or `session/new`. It names
 * what soma started the agent with, which is the human's configuration and not the job, and what each refusal leaves
 * (ARCHITECTURE.md "The ACP implementation"): the agent keeps the environment it started with, and nothing retries a
 * refused session/new.
 */
export function authMessage(env: Readonly<Record<string, string>>, method: "session/prompt" | "session/new"): string {
	const named = (key: string) => `${key}=${env[key] === undefined || env[key] === "" ? "unset" : env[key]}`;
	const head =
		method === "session/new"
			? "configuration error: claude-agent-acp refused session/new with -32000 Authentication required, so this " +
				"job has no session: it takes no reply, and nothing opens one again."
			: "configuration error: claude-agent-acp refused the prompt with -32000 Authentication required.";
	const after =
		method === "session/new"
			? ""
			: " If claude is not logged in, log it in, then reply to the job: the session is open and takes the reply.";
	const restart =
		method === "session/new"
			? "this job has no session to load again, so after the restart it is reported gone."
			: "after the restart, a reply starts this job's agent again in its session, unless no prompt of it ever ran, " +
				"which leaves no session to load and the job reported gone.";
	return (
		`${head} It finds the machine's Claude Code login through HOME and USER, and soma started it with ` +
		`${named("HOME")} and ${named("USER")}.${after} A changed HOME or USER reaches an agent only when soma starts ` +
		`it, after soma restarts with it (under launchd, the LaunchAgent's EnvironmentVariables): ${restart}`
	);
}

/** A permission request as the human reads it: what it approves, then its options by number. */
function askedMsg(toolCall: ToolCallUpdate, options: readonly PermissionOption[]): string {
	const title = toolCall.title ?? toolCall.toolCallId;
	const input = toolCall.rawInput as Record<string, unknown> | undefined;
	const detail = [input?.command, input?.file_path, input?.description].find(
		(value): value is string => typeof value === "string" && value !== "" && !title.includes(value),
	);
	return [`approve ${title}`, ...(detail ? [detail] : []), ...options.map((o, i) => `${i + 1}. ${o.name}`)].join("\n");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The tail of the transcript at `path`, drawn, from a window that grows until it draws SCREEN_LINES lines. */
async function drawTail(path: string): Promise<string> {
	for (let bytes = SCREEN_BYTES; ; bytes *= 2) {
		const { records, whole } = await readConversationTail(path, bytes);
		const drawn = drawTranscript(records);
		if (whole || bytes >= SCREEN_MAX_BYTES || drawn.split("\n").length >= SCREEN_LINES) return drawn;
	}
}

/**
 * Runs each card's agent over the Agent Client Protocol: one claude-agent-acp process per job, a child of soma, with
 * one session in the card's `fleet/<card>` worktree. Its permission requests are structured, so `respond` reads no
 * screen; it has no pane, so `readScreen` draws its claude transcript. The agents end with soma; the next soma's port
 * lists each one soma did not stop as dormant, and its first prompt starts it again with session/load; one soma stopped
 * is started again the same way by `resume` (ARCHITECTURE.md "The ACP implementation").
 */
export function createAcpAgentPort(options: AcpAgentPortOptions): AcpAgentPort {
	const { command, args } =
		options.command === undefined ? defaultAcpCommand() : { command: options.command, args: options.args ?? [] };
	const git = options.git ?? runGit;
	const startMs = options.startMs ?? 30_000;
	const closeMs = options.closeMs ?? 3_000;
	const replyMs = options.replyMs ?? 2_000;
	const recheckMs = options.recheckMs ?? 10_000;
	const now = options.now ?? Date.now;
	const onError = options.onError ?? ((error: Error) => console.warn(`[acp] ${error.message}`));
	const cap = options.cap ?? resolveHangarCapWithSource(undefined, readPerfCoresViaSysctl).cap;

	const agents = new Map<string, Agent>();
	const dormant = new Map<string, Dormant>();
	// The session each agent ran, kept past its stop, so its transcript is still read and a resume finds it.
	const sessions = new Map<string, Session>();
	// The names a resume is starting: not listed until the session is loaded, so a load that fails leaves none.
	const resuming = new Set<string>();
	const listeners = new Set<(event: AgentStatusEvent) => void>();
	let lastSeq = 0;
	// Microseconds of the adapter's clock, never repeated: the agents live no longer than this process does.
	const nextSeq = () => {
		lastSeq = Math.max(now() * 1000, lastSeq + 1);
		return lastSeq;
	};

	function emit(agent: Pick<Agent, "name" | "seen" | "recheck">, status: AgentState): void {
		const seq = nextSeq();
		agent.seen = { status, seq };
		if (status.state === "working" || status.state === "blocked") clearTimeout(agent.recheck);
		for (const listener of listeners) listener({ agent: agent.name, status, seq });
	}

	/** The end of the agent's turn, whatever ended it: no permission request outlives the turn that made it. */
	function settle(agent: Agent, status: AgentState): void {
		agent.ended = agent.turning && (status.state === "done" || status.state === "idle");
		agent.turning = false;
		for (const asked of agent.asked.splice(0)) asked.answer();
		emit(agent, status);
	}

	const readSessions = async (file: string) =>
		JSON.parse(
			await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return "{}";
				throw error;
			}),
		) as Record<string, Session>;

	// Each write reads the file anew, one at a time, so two sessions opening at once both land.
	let recording = Promise.resolve();
	function record(name: string, session: Session): Promise<void> {
		const file = options.sessionsFile;
		if (file === undefined) return Promise.resolve();
		recording = recording
			.then(async () => {
				const kept = await readSessions(file);
				await writeFile(`${file}.tmp`, `${JSON.stringify({ ...kept, [name]: session }, null, "\t")}\n`, {
					mode: 0o600,
				});
				await rename(`${file}.tmp`, file);
			})
			.catch((error: Error) => onError(new Error(`acp sessions file ${file}: ${error.message}`)));
		return recording;
	}

	function launch(request: StartRequest, cwd: string): Agent {
		const env: Record<string, string> = { ...agentEnv(options.env), ...options.vars, SOMA_AGENT: request.card };
		if (options.path !== undefined) env.PATH = `${options.path}:${env.PATH ?? ""}`;
		const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		// Filled in below: the handlers of the agent's requests need the agent, which needs the connection.
		const holder: { agent?: Agent } = {};
		const app = client({ name: "soma" })
			.onRequest(methods.client.session.requestPermission, ({ params, signal }) => {
				const agent = holder.agent as Agent;
				const number = ++agent.requests;
				const fingerprint = createHash("sha256")
					.update(`${params.sessionId}\n${number}\n${params.toolCall.toolCallId}\n${JSON.stringify(params.options)}`)
					.digest("hex")
					.slice(0, 16);
				const status: AgentState = {
					state: "blocked",
					kind: "permission",
					msg: askedMsg(params.toolCall, params.options),
					fingerprint,
					options: params.options.map((option, index) => ({ id: String(index + 1), label: option.name })),
				};
				return new Promise((resolve) => {
					const asked: Asked = {
						fingerprint,
						options: params.options,
						status,
						answer: (optionId) =>
							resolve({
								outcome: optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId },
							}),
					};
					agent.asked.push(asked);
					if (agent.asked[0] === asked) emit(agent, status);
					// The agent withdrew it, as when its turn was cancelled.
					signal.addEventListener("abort", () => withdraw(agent, asked), { once: true });
				});
			})
			// The turn's progress comes as updates; its state is read off the prompt's response and the requests above.
			.onNotification(methods.client.session.update, () => {});
		const connection = app.connect(
			ndJsonStream(
				Writable.toWeb(child.stdin as Writable) as WritableStream<Uint8Array>,
				Readable.toWeb(child.stdout as Readable) as ReadableStream<Uint8Array>,
			),
		);
		const agent: Agent = {
			name: request.name,
			card: request.card,
			sessionId: request.sessionId,
			cwd,
			child,
			connection,
			turning: false,
			ended: false,
			asked: [],
			requests: 0,
			exited: false,
			stopped: false,
			stderr: "",
		};
		holder.agent = agent;
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (data: string) => {
			agent.stderr = (agent.stderr + data).slice(-STDERR_BYTES);
		});
		child.on("error", (error) => connection.close(error));
		child.on("exit", (code, signal) => {
			agent.exited = true;
			clearTimeout(agent.recheck);
			connection.close();
			for (const asked of agent.asked.splice(0)) asked.answer();
			if (agents.get(agent.name) !== agent || agent.stopped) return;
			const last = agent.stderr.trimEnd().split("\n").at(-1);
			emit(agent, {
				state: "error",
				msg: `claude-agent-acp exited with ${signal ?? `code ${code}`}${last ? `: ${last}` : ""}`,
			});
		});
		return agent;
	}

	function withdraw(agent: Agent, asked: Asked): void {
		const index = agent.asked.indexOf(asked);
		if (index < 0) return;
		agent.asked.splice(index, 1);
		asked.answer();
		if (index > 0 || agent.exited) return;
		const next = agent.asked[0];
		if (next !== undefined) emit(agent, next.status);
		else if (agent.turning) emit(agent, { state: "working" });
	}

	/** Opens the agent's session; its idle tells the core the session takes the brief. */
	async function open(agent: Agent): Promise<void> {
		try {
			const { sessionId } = await agent.connection.agent.request(methods.agent.session.new, {
				cwd: agent.cwd,
				mcpServers: [],
			});
			agent.session = sessionId;
			const session = { card: agent.card, sessionId: agent.sessionId, acpSessionId: sessionId, cwd: agent.cwd };
			sessions.set(agent.name, session);
			// A stop that came while the session opened found none to mark.
			await record(agent.name, agent.stopped ? { ...session, stopped: true } : session);
			if (!agent.exited && !agent.stopped) announce(agent);
		} catch (error) {
			// A closed connection is the process's exit, which reports itself.
			if (agent.connection.signal.aborted || agent.stopped) return;
			emit(agent, failure(agent, "session/new", error as Error));
		}
	}

	function failure(agent: Agent, method: "session/prompt" | "session/new", error: Error): AgentState {
		if (error instanceof RequestError && error.code === AUTH_REQUIRED) {
			const msg = authMessage({ ...agentEnv(options.env), ...options.vars }, method);
			onError(new Error(`agent ${agent.name}: ${msg}`));
			return { state: "blocked", kind: "auth", msg };
		}
		return { state: "error", msg: `${method} failed: ${error.message}` };
	}

	function only(name: string): Agent {
		const agent = agents.get(name);
		if (agent === undefined) throw new Error(`acp has no agent named ${name}`);
		return agent;
	}

	/** Why the agent cannot take a prompt now; undefined when it can. */
	function busy(agent: Agent): string | undefined {
		if (agent.exited) return "has exited: a prompt would go nowhere";
		if (agent.session === undefined) return "has no session yet: a prompt goes once it reports idle";
		if (agent.turning) return `is ${agent.seen?.status.state ?? "working"}: a prompt goes only between turns`;
		return undefined;
	}

	const transcriptOf = (session: Session) =>
		resolveTranscriptPath(session.acpSessionId, session.cwd, options.projectsDir);

	/**
	 * Reports the open session idle, then resends that same observation, under its seq, every recheckMs until the agent
	 * reports anything else or is stopped. The core lists a job only once `start` returned, and the bridge drops a status
	 * of a job it does not list, so the first idle may come too early to send the brief; a resend then sends it, and to a
	 * job that saw it already, a resend is the observation it recorded.
	 */
	function announce(agent: Agent): void {
		emit(agent, { state: "idle" });
		const first = agent.seen;
		const resend = () => {
			if (agent.exited || agent.stopped || agent.seen !== first || first === undefined) return;
			for (const listener of listeners) listener({ agent: agent.name, ...first });
			agent.recheck = setTimeout(resend, recheckMs);
			agent.recheck.unref();
		};
		agent.recheck = setTimeout(resend, recheckMs);
		agent.recheck.unref();
	}

	/** Reports the agent's status again under a new seq, unless it went on to work or to a prompt since. */
	function scheduleRecheck(agent: Agent): void {
		clearTimeout(agent.recheck);
		agent.recheck = setTimeout(() => {
			const status = agent.seen?.status;
			if (agent.exited || agent.turning || status === undefined || status.state === "blocked") return;
			agent.ended = false;
			emit(agent, status);
		}, recheckMs);
		agent.recheck.unref();
	}

	const lastStderr = (agent: Agent) => {
		const last = agent.stderr.trimEnd().split("\n").at(-1);
		return last ? `: ${last}` : "";
	};

	/** The agents that hold a process, or are getting one: what the hangar cap counts. */
	const running = () =>
		[...agents.values()].filter((agent) => !agent.exited).length +
		[...dormant.values()].filter((asleep) => asleep.waking !== undefined).length +
		resuming.size;

	/** Spawned in a cwd that is gone, the process fails with an ENOENT that names node, not the cwd. */
	const worktreeGone = (session: Session) =>
		access(session.cwd).then(
			() => false,
			() => true,
		);

	/**
	 * A new claude-agent-acp in the agent's session: session/load of its ACP session in its cwd, which claude answers from
	 * the session's transcript. Throws naming why, its process ended, when the session does not load.
	 */
	async function load(name: string, session: Session): Promise<Agent> {
		const agent = launch({ name, card: session.card, cwd: session.cwd, sessionId: session.sessionId }, session.cwd);
		// Each request has startMs of its own.
		const cancel = () => ({ cancellationSignal: AbortSignal.timeout(startMs), stopWaitingOnCancel: true });
		try {
			const { agentCapabilities } = await agent.connection.agent.request(
				methods.agent.initialize,
				{ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "soma", version: "0" } },
				cancel(),
			);
			if (agentCapabilities?.loadSession !== true) throw new Error("the agent does not offer session/load");
			await agent.connection.agent.request(
				methods.agent.session.load,
				{ sessionId: session.acpSessionId, cwd: session.cwd, mcpServers: [] },
				cancel(),
			);
		} catch (error) {
			agent.stopped = true;
			// A process that died closed the connection first: its exit names how it died.
			if (agent.connection.signal.aborted && !agent.exited)
				await Promise.race([once(agent.child, "exit"), sleep(1000)]);
			agent.child.kill();
			const code = error instanceof RequestError ? `${error.code} ` : "";
			const exit = agent.exited
				? `; the process exited with ${agent.child.signalCode ?? `code ${agent.child.exitCode}`}`
				: "";
			throw new Error(
				`session/load of ACP session ${session.acpSessionId} in ${session.cwd} failed: ` +
					`${code}${(error as Error).message}${exit}${lastStderr(agent)}`,
			);
		}
		agent.session = session.acpSessionId;
		return agent;
	}

	/**
	 * Gives a dormant agent its process, with session/load. Held to the hangar cap, as start is. A wake that fails ends the
	 * job error with the reason and leaves the agent dormant, so a later prompt tries again. A stop that came while no
	 * wake was under way to wait for took the agent off the dormant ones: the wake then refuses the prompt, and its
	 * process, if it has one yet, ends.
	 */
	async function wake(name: string, asleep: Dormant): Promise<Agent> {
		const count = running();
		if (count >= cap)
			throw new PromptRefused(`acp agent ${name} is dormant: hangar is full: ${count} of ${cap} agents running`);
		const { session } = asleep;
		const stopped = () => dormant.get(name) !== asleep;
		const refusal = () => new PromptRefused(`acp agent ${name} was stopped as it woke`);
		const failed = (why: string): never => {
			onError(new Error(`agent ${name} is not woken: ${why}`));
			emit(asleep, { state: "error", msg: why });
			throw new PromptRefused(`acp agent ${name} is not woken: ${why}`);
		};
		const gone = await worktreeGone(session);
		// A stop that looked before this wake began has taken the agent off the dormant ones by now, so none is spawned.
		if (stopped()) throw refusal();
		if (gone) return failed(`its worktree ${session.cwd} is gone`);
		let agent: Agent;
		try {
			agent = await load(name, session);
		} catch (error) {
			return failed((error as Error).message);
		}
		// A stop that saw the wake waits for it, so this holds unless that changes: only the dormant agent goes live.
		if (stopped()) {
			agent.stopped = true;
			agent.child.kill();
			throw refusal();
		}
		// Between the load's answer and here, an exit would have reported to no one.
		if (agent.exited) return failed(`it exited once its session was loaded${lastStderr(agent)}`);
		dormant.delete(name);
		agents.set(name, agent);
		return agent;
	}

	/** The agent's process, woken first when it is dormant; a second prompt while it wakes waits for the same wake. */
	function awake(name: string): Promise<Agent> {
		const target = agents.get(name);
		if (target !== undefined) return Promise.resolve(target);
		const asleep = dormant.get(name);
		if (asleep === undefined) return Promise.reject(new PromptRefused(`acp has no agent named ${name}`));
		if (asleep.waking === undefined) {
			asleep.waking = wake(name, asleep);
			asleep.waking.catch(() => {}).finally(() => (asleep.waking = undefined));
		}
		return asleep.waking;
	}

	/**
	 * Every session the file holds that soma did not stop and that ran a prompt, made dormant: listed, with no process.
	 * One with no transcript never ran its brief, and claude refuses to load it, so it is left out and the
	 * reconciliation takes its job for gone. One soma stopped is not listed: only a resume starts it again.
	 */
	async function findDormant(file: string): Promise<readonly string[]> {
		try {
			const all = Object.entries(await readSessions(file));
			for (const [name, session] of all) sessions.set(name, session);
			const kept = all.filter(([, s]) => s.stopped !== true);
			const ran = await Promise.all(kept.map(async ([, session]) => (await transcriptOf(session)) !== undefined));
			const found: string[] = [];
			for (const [index, [name, session]] of kept.entries()) {
				if (!ran[index]) {
					onError(
						new Error(
							`agent ${name} is not listed after the restart: ACP session ${session.acpSessionId} in ` +
								`${session.cwd} has no transcript, so it never ran a prompt`,
						),
					);
					continue;
				}
				dormant.set(name, { name, session });
				found.push(name);
			}
			return found;
		} catch (error) {
			onError(new Error(`acp sessions file ${file}: ${(error as Error).message}; no agent is listed from it`));
			return [];
		}
	}

	const loading = options.sessionsFile === undefined ? Promise.resolve([]) : findDormant(options.sessionsFile);

	return {
		dormant: () => loading,

		async start(request: StartRequest): Promise<void> {
			await loading;
			const existing = agents.get(request.name);
			if (existing !== undefined && !existing.exited) {
				throw new Error(`acp already runs an agent named ${request.name}`);
			}
			// Its session goes on with a reply; a new one would take its place in the sessions file.
			if (dormant.has(request.name)) throw new Error(`acp holds a dormant agent named ${request.name}`);
			if (resuming.has(request.name)) throw new Error(`acp is starting an agent named ${request.name} again`);
			const count = running();
			if (count >= cap) throw new Error(`hangar is full: ${count} of ${cap} agents running`);
			const path = await openWorktree(git, request.cwd, request.card);
			// obw finds its vault through this untracked file, which a fresh worktree lacks.
			await copyFile(join(request.cwd, ".obsidian.yaml"), join(path, ".obsidian.yaml"), constants.COPYFILE_EXCL).catch(
				(error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT" && error.code !== "EEXIST") throw error;
				},
			);
			// claude names the transcript's directory after the cwd's realpath, which a later session/load must match.
			const cwd = await realpath(path);
			// Checked again: another start of the same name may have got here while git ran.
			if (agents.get(request.name)?.exited === false || dormant.has(request.name) || resuming.has(request.name)) {
				throw new Error(`acp already runs an agent named ${request.name}`);
			}
			const agent = launch(request, cwd);
			agents.set(request.name, agent);
			try {
				await agent.connection.agent.request(
					methods.agent.initialize,
					{ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "soma", version: "0" } },
					{ cancellationSignal: AbortSignal.timeout(startMs), stopWaitingOnCancel: true },
				);
			} catch (error) {
				agents.delete(request.name);
				agent.stopped = true;
				agent.child.kill();
				throw new Error(
					`the ACP agent for ${request.name} did not initialize: ${(error as Error).message}${lastStderr(agent)}`,
				);
			}
			// The CLI starts while the session opens, which takes seconds: the job is in the dispatch list by its idle.
			void open(agent);
		},

		/**
		 * Starts an agent soma stopped again in its recorded session, with session/load, and takes the stopped mark off.
		 * Not held to the cap: a due deferred instruction outranks it (ARCHITECTURE.md "Agent-deferred instructions"). It
		 * is listed idle, with no status reported: the deferral's listing is what looks, and an idle reported to the core
		 * could send a brief it still holds or record a turn. Refuses a name already listed, or a resume already under way.
		 * An agent with no session of this id recorded, or no transcript of it, cannot be resumed: claude refuses to load
		 * such a session, so NotImplemented ends the deferral `gone`. One whose worktree is gone or whose session does not
		 * load throws what happened, and stays stopped.
		 */
		async resume(request: ResumeRequest): Promise<void> {
			await loading;
			const { name, sessionId } = request;
			if (agents.has(name) || dormant.has(name) || resuming.has(name)) {
				throw new Error(`acp already lists an agent named ${name}`);
			}
			const found = sessions.get(name);
			if (found === undefined || found.sessionId !== sessionId) {
				throw new NotImplemented(`acp holds no session ${sessionId} of agent ${name} to start again`);
			}
			const { stopped: _resumed, ...session } = found;
			resuming.add(name);
			try {
				if ((await transcriptOf(session)) === undefined) {
					throw new NotImplemented(
						`ACP session ${session.acpSessionId} of agent ${name} has no transcript, so it never ran a prompt`,
					);
				}
				if (await worktreeGone(session)) throw new Error(`the worktree ${session.cwd} of agent ${name} is gone`);
				const agent = await load(name, session);
				// Between the load's answer and here, an exit would have reported to no one.
				if (agent.exited) throw new Error(`agent ${name} exited once its session was loaded${lastStderr(agent)}`);
				agent.seen = { status: { state: "idle" }, seq: nextSeq() };
				sessions.set(name, session);
				agents.set(name, agent);
				await record(name, session);
			} finally {
				resuming.delete(name);
			}
		},

		/** Every agent, a dormant one with no status: no turn of its runs, and what ran last is the core's to know. */
		async list(): Promise<readonly AgentListing[]> {
			await loading;
			return [
				...[...agents.values()].map((agent) => ({ name: agent.name, sessionId: agent.sessionId, ...agent.seen })),
				...[...dormant.values()].map((asleep) => ({
					name: asleep.name,
					sessionId: asleep.session.sessionId,
					...asleep.seen,
				})),
			];
		},

		/**
		 * Sends the prompt as the session's next turn; it returns once sent, and the turn's end comes as its status. A
		 * dormant agent is woken first, which a full hangar or a failed session/load refuses.
		 */
		async prompt(agent: string, text: string): Promise<void> {
			await loading;
			const target = await awake(agent);
			const refused = busy(target);
			if (refused !== undefined) throw new PromptRefused(`acp agent ${agent} ${refused}`);
			const session = sessions.get(agent);
			const path = session && (await transcriptOf(session));
			const before = path === undefined ? undefined : (await readLastRecord(path))?.id;
			// Checked again: another prompt may have gone while the transcript was read.
			const again = busy(target);
			if (again !== undefined) throw new PromptRefused(`acp agent ${agent} ${again}`);
			target.turning = true;
			target.ended = false;
			target.before = before;
			emit(target, { state: "working" });
			target.connection.agent
				.request(methods.agent.session.prompt, {
					sessionId: target.session as string,
					prompt: [{ type: "text", text }],
				})
				.then(
					({ stopReason }: PromptResponse) => {
						if (target.exited || target.stopped) return;
						if (stopReason === "cancelled") settle(target, { state: "idle" });
						else if (stopReason === "end_turn") settle(target, { state: "done" });
						else settle(target, { state: "done", msg: `the turn stopped: ${stopReason}` });
					},
					(error: Error) => {
						if (target.connection.signal.aborted || target.stopped) return;
						settle(target, failure(target, "session/prompt", error));
					},
				);
		},

		onStatus(listener: (event: AgentStatusEvent) => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		/**
		 * What the session's claude transcript ends on. After a turn the agent reported over, it is read once the
		 * transcript ends on a record other than the one it ended on when the turn was prompted and does not end awaiting
		 * the reply, or as it is when replyMs passes first, with the end reported again recheckMs later. Without such an
		 * end, as for a re-stamp, it is read at once. A stopped agent's is read off the session it ran.
		 */
		async readResult(agent: string): Promise<AgentResult | undefined> {
			await loading;
			const session = sessions.get(agent);
			if (session === undefined) return undefined;
			const target = agents.get(agent);
			if (target === undefined || !target.ended) {
				const path = await transcriptOf(session);
				return path === undefined ? undefined : readLastRecord(path);
			}
			for (const deadline = now() + replyMs; ; await sleep(100)) {
				const path = await transcriptOf(session);
				const last = path === undefined ? undefined : await readLastRecord(path);
				if (path !== undefined && last !== undefined && last.id !== target.before && !(await awaitingReply(path))) {
					return last;
				}
				if (now() >= deadline) {
					scheduleRecheck(target);
					return last;
				}
			}
		},

		/**
		 * An ACP agent has no pane: this is the tail of its claude transcript, drawn as claude draws a conversation, with
		 * the permission request it waits on below it, read at every call. Empty before its first turn is written.
		 */
		async readScreen(agent: string): Promise<string> {
			await loading;
			const target = dormant.has(agent) ? undefined : only(agent);
			const session = sessions.get(agent);
			const path = session && (await transcriptOf(session));
			const drawn = path === undefined ? "" : await drawTail(path);
			const asked = target?.asked[0]?.status.msg;
			return asked === undefined ? drawn : `${drawn}${drawn === "" ? "" : "\n\n"}● ${asked.replaceAll("\n", "\n  ")}`;
		},

		/** Answers the permission request the agent waits on, the one its blocked status shows, by option number. */
		async respond(agent: string, answer: Answer): Promise<AnswerOutcome> {
			await loading;
			const target = agents.get(agent);
			if (target === undefined || target.exited) return { sent: false, refusal: "not_blocked" };
			const asked = target.asked[0];
			if (asked === undefined) {
				const status = target.seen?.status;
				const auth = status?.state === "blocked" && status.kind === "auth";
				return { sent: false, refusal: auth ? "auth" : "not_blocked" };
			}
			if (asked.fingerprint !== answer.fingerprint) return { sent: false, refusal: "stale" };
			const option = /^[1-9]\d*$/.test(answer.option) ? asked.options[Number(answer.option) - 1] : undefined;
			if (option === undefined) return { sent: false, refusal: "unknown_option" };
			target.asked.shift();
			asked.answer(option.optionId);
			const next = target.asked[0];
			emit(target, next === undefined ? { state: "working" } : next.status);
			return { sent: true };
		},

		/**
		 * Records that soma stopped the agent, so no restart lists it again, then closes the session and ends the process,
		 * which a dormant agent has none of; what session/load needs stays recorded, for a resume.
		 */
		async stop(agent: string): Promise<void> {
			await loading;
			const asleep = dormant.get(agent);
			// A wake under way ends first; one that begins after this finds the agent stopped.
			await asleep?.waking?.catch(() => {});
			if (asleep !== undefined && dormant.get(agent) === asleep) {
				dormant.delete(agent);
				await record(agent, { ...asleep.session, stopped: true });
				return;
			}
			const target = only(agent);
			agents.delete(agent);
			target.stopped = true;
			clearTimeout(target.recheck);
			const session = sessions.get(agent);
			if (session !== undefined) await record(agent, { ...session, stopped: true });
			if (target.exited) return;
			if (target.session !== undefined) {
				await target.connection.agent
					.request(
						methods.agent.session.close,
						{ sessionId: target.session },
						{ cancellationSignal: AbortSignal.timeout(closeMs), stopWaitingOnCancel: true },
					)
					.catch((error: Error) => onError(new Error(`acp agent ${agent}: session/close: ${error.message}`)));
			}
			target.child.kill();
		},

		// Every agent is a process soma holds; there is no pane of anyone else's.
		listForeign: async () => [],
		readForeignResult: (id: string) => Promise.reject(new Error(`no foreign agent ${id}: acp runs none`)),
		readForeignScreen: (id: string) => Promise.reject(new Error(`no foreign agent ${id}: acp runs none`)),
		onForeignStatus: () => () => {},
		respondForeign: (id: string) => Promise.reject(new Error(`no foreign agent ${id}: acp runs none`)),
		promptForeign: (id: string) => Promise.reject(new PromptRefused(`no foreign agent ${id}: acp runs none`)),
	};
}
