// `soma defer --at <when> "<instruction>"`: run from the shell of an agent soma dispatched, it asks soma to send the
// instruction back to this agent at <when>. bin/soma runs it; the agent's identity and soma's socket come from the
// SOMA_AGENT and SOMA_SOCKET soma put in the agent's environment when it started it.
import { fileURLToPath } from "node:url";
import { requestDefer } from "./adapters/defer-socket/index.ts";
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

/** Runs one `soma defer`; returns the exit status: 0 accepted, 1 refused or unreachable, 2 a usage error. */
export async function runDefer(
	args: readonly string[],
	env: Env,
	io: Io,
	send: (path: string, request: DeferRequest) => Promise<DeferReply> = requestDefer,
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
	const socket = env.SOMA_SOCKET?.trim();
	if (!agent || !socket) {
		io.err(
			`soma defer: ${agent ? "SOMA_SOCKET" : "SOMA_AGENT"} is not set: soma defer works only in the shell of an agent soma dispatched`,
		);
		return 1;
	}
	let reply: DeferReply;
	try {
		reply = await send(socket, { agent, ...parsed });
	} catch (error) {
		io.err(`soma defer: soma is not answering on ${socket} (${(error as Error).message}); nothing was deferred`);
		return 1;
	}
	if (!reply.accepted) {
		io.err(`soma defer: refused: ${reply.reason}`);
		return 1;
	}
	io.out(
		`soma defer: accepted as ${reply.id}; soma will send this instruction to agent ${agent} as a new prompt at ${reply.at}. You can end your turn now.`,
	);
	return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	process.exitCode = await runDefer(process.argv.slice(2), process.env, {
		out: (line) => console.log(line),
		err: (line) => console.error(line),
	});
}
