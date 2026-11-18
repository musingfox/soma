// `soma dispatch --repo <path> <card>`: asks the running soma to start a job on <card> in the git repo at <path>, as
// its dispatch tool would, with no turn of its model. bin/soma runs it. The repo must be directly under the config's
// reposDir; soma checks that, not this CLI. soma is found on the socket its config names, as `soma defer` finds it, or
// on SOMA_SOCKET in the shell of an agent it dispatched.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DeferUnreachable, requestDispatch } from "./adapters/defer-socket/index.ts";
import { configPath, loadConfig } from "./config.ts";
import type { DispatchReply, DispatchRequest } from "./ports/dispatch.ts";

const USAGE = "usage: soma dispatch --repo <git repo directly under reposDir> <card>";

type Env = Readonly<Record<string, string | undefined>>;
export type Io = { readonly out: (line: string) => void; readonly err: (line: string) => void };

/** The `--repo` value and the card, or why the arguments are not a dispatch. */
export function parseDispatchArgs(args: readonly string[]): { repo: string; card: string } | { error: string } {
	let repo: string | undefined;
	const cards: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		if (arg === "--repo") {
			repo = args[++index];
			if (repo === undefined) return { error: "--repo needs a value" };
		} else if (arg.startsWith("--repo=")) repo = arg.slice("--repo=".length);
		else if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
		else cards.push(arg);
	}
	if (repo === undefined || repo === "") return { error: "--repo is missing" };
	const [card, ...more] = cards;
	if (card === undefined) return { error: "the card is missing" };
	if (more.length > 0) return { error: "one card at a time" };
	return { repo, card };
}

const said = (reply: DispatchReply & { dispatched: true }) => {
	const { card, agent, sessionId, state } = reply;
	const repo = reply.repo ?? "a repo soma did not record";
	if (reply.how === "started") {
		return `started agent ${agent} for card ${card} in ${repo}, session ${sessionId}; soma sends it the card's launch prompt once it is ready.`;
	}
	if (reply.how === "found") {
		return `agent ${agent} was already running, so none was started; soma recorded it as the job of card ${card} in ${repo}, session ${sessionId}.`;
	}
	return `card ${card} already has a job: agent ${agent}, ${state}, in ${repo}, session ${sessionId}; nothing was started.`;
};

/** Runs one `soma dispatch`; returns the exit status: 0 dispatched or already, 1 refused, unreachable or unknown, 2 a usage error. */
export async function runDispatch(
	args: readonly string[],
	env: Env,
	io: Io,
	{
		cwd = process.cwd(),
		home = homedir(),
		send = requestDispatch,
	}: {
		cwd?: string;
		home?: string;
		send?: (path: string, request: DispatchRequest) => Promise<DispatchReply>;
	} = {},
): Promise<number> {
	const parsed = parseDispatchArgs(args);
	if ("error" in parsed) {
		io.err(`soma dispatch: ${parsed.error}\n${USAGE}`);
		return 2;
	}
	let socket = env.SOMA_SOCKET?.trim();
	if (!socket) {
		try {
			socket = loadConfig(configPath(env, home), env, home, io.err).deferSocket;
		} catch (error) {
			io.err(`soma dispatch: ${(error as Error).message}`);
			return 1;
		}
	}
	let reply: DispatchReply;
	try {
		reply = await send(socket, { repo: resolve(cwd, parsed.repo), card: parsed.card });
	} catch (error) {
		const message = (error as Error).message;
		if (error instanceof DeferUnreachable) {
			io.err(`soma dispatch: soma is not answering on ${socket} (${message}); nothing was dispatched`);
		} else {
			// The request went out: soma may have started the agent. A rerun is safe, unlike a second defer.
			io.err(
				`soma dispatch: the request went out to ${socket} but no reply came back (${message}); whether the agent started is unknown. Run the same command again once soma answers: it starts no second agent, and records one that started.`,
			);
		}
		return 1;
	}
	if (!reply.dispatched) {
		io.err(`soma dispatch: not dispatched: ${reply.reason}`);
		return 1;
	}
	io.out(`soma dispatch: ${said(reply)}`);
	return 0;
}

// Node names this module by its real path, while argv[1] keeps the path it was run by, which goes through the release's
// `current` symlink; both are resolved, so a run through a symlink is still the CLI's own.
const script = process.argv[1];
if (script !== undefined && realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))) {
	process.exitCode = await runDispatch(process.argv.slice(2), process.env, {
		out: (line) => console.log(line),
		err: (line) => console.error(line),
	});
}
