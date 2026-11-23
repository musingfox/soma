// `soma defer --at <when> "<instruction>"`: run from the shell of an agent soma dispatched, it asks soma to send the
// instruction back to this agent at <when>. bin/soma runs it; the agent's identity and soma's socket come from the
// SOMA_AGENT and SOMA_SOCKET soma put in the agent's environment when it started it. Run in any other Claude Code
// session, it hands that session to soma, which resumes it at <when> in this directory and gives it the instruction:
// the session is CLAUDE_CODE_SESSION_ID, and soma is found on SOMA_SOCKET or else the socket of the config `soma
// dispatch` would load.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { DeferUnreachable, requestDefer } from "./adapters/defer-socket/index.ts";
import { configPath, loadConfig } from "./config.ts";
import { deferAt } from "./core/domain/defer.ts";
import type { DeferReply, DeferRequest } from "./ports/defer.ts";

const USAGE = 'usage: soma defer --at <ISO 8601 date-time with offset, or duration such as PT2M> "<instruction>"';

type Env = Readonly<Record<string, string | undefined>>;
export type Io = { readonly out: (line: string) => void; readonly err: (line: string) => void };

/** The `--at` value and the instruction, or why the arguments are not a defer; the words after `--at` are joined. */
export function parseDeferArgs(args: readonly string[]): { at: string; instruction: string } | { error: string } {
	let at: string | undefined;
	const words: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		if (arg === "--at") {
			at = args[++index];
			if (at === undefined) return { error: "--at needs a value" };
		} else if (arg.startsWith("--at=")) at = arg.slice("--at=".length);
		else if (arg === "--") {
			words.push(...args.slice(index + 1));
			break;
		} else if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
		else words.push(arg);
	}
	if (at === undefined) return { error: "--at is missing" };
	const instruction = words.join(" ").trim();
	if (instruction === "") return { error: "the instruction is missing" };
	return { at, instruction };
}

/** Runs one `soma defer`; returns the exit status: 0 accepted, 1 refused, unreachable or unknown, 2 a usage error. */
export async function runDefer(
	args: readonly string[],
	env: Env,
	io: Io,
	send: (path: string, request: DeferRequest) => Promise<DeferReply> = requestDefer,
	{ cwd = process.cwd(), home = homedir() }: { cwd?: string; home?: string } = {},
): Promise<number> {
	const parsed = parseDeferArgs(args);
	if ("error" in parsed) {
		io.err(`soma defer: ${parsed.error}\n${USAGE}`);
		return 2;
	}
	try {
		deferAt(parsed.at, Date.now());
	} catch (error) {
		io.err(`soma defer: ${(error as Error).message}\n${USAGE}`);
		return 2;
	}
	const agent = env.SOMA_AGENT?.trim();
	const session = env.CLAUDE_CODE_SESSION_ID?.trim();
	let socket = env.SOMA_SOCKET?.trim();
	if (!agent && !session) {
		io.err(
			"soma defer: neither SOMA_AGENT nor CLAUDE_CODE_SESSION_ID is set: soma defer works only in a Claude Code session or in the shell of an agent soma dispatched",
		);
		return 1;
	}
	if (agent && !socket) {
		io.err("soma defer: SOMA_SOCKET is not set: soma defer works only in the shell of an agent soma dispatched");
		return 1;
	}
	if (!socket) {
		try {
			socket = loadConfig(configPath(env, home), env, home, io.err).deferSocket;
		} catch (error) {
			io.err(`soma defer: ${(error as Error).message}; nothing was deferred`);
			return 1;
		}
	}
	// A dispatched agent's shell carries both, and SOMA_AGENT names its job.
	const request: DeferRequest = agent ? { agent, ...parsed } : { session: session as string, cwd, ...parsed };
	let reply: DeferReply;
	try {
		reply = await send(socket, request);
	} catch (error) {
		const message = (error as Error).message;
		if (error instanceof DeferUnreachable) {
			io.err(`soma defer: soma is not answering on ${socket} (${message}); nothing was deferred`);
		} else {
			// The request went out: soma may have accepted it, and a second defer would then prompt the agent twice.
			io.err(
				`soma defer: the request went out to ${socket} but no reply came back (${message}); whether it was deferred is unknown. Do not run soma defer again for it: if soma accepted it, a second one sends the instruction twice. Tell the human instead.`,
			);
		}
		return 1;
	}
	if (!reply.accepted) {
		io.err(`soma defer: refused: ${reply.reason}`);
		return 1;
	}
	io.out(
		agent
			? `soma defer: accepted as ${reply.id}; soma will send this instruction to agent ${agent} as a new prompt at ${reply.at}. You can end your turn now.`
			: `soma defer: accepted as ${reply.id}; at ${reply.at} soma types this instruction into session ${session}'s window as a new prompt if it is still open in rex, and otherwise resumes the session in ${cwd} and gives it the instruction as a new prompt. This session may be closed now.`,
	);
	return 0;
}

// Node names this module by its real path, while argv[1] keeps the path it was run by, which goes through the release's
// `current` symlink; both are resolved, so a run through a symlink is still the CLI's own.
const script = process.argv[1];
if (script !== undefined && realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))) {
	process.exitCode = await runDefer(process.argv.slice(2), process.env, {
		out: (line) => console.log(line),
		err: (line) => console.error(line),
	});
}
