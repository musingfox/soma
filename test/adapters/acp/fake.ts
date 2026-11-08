import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AcpAgentPortOptions, createAcpAgentPort } from "../../../src/adapters/acp/agent-port.ts";
import type { Git } from "../../../src/agent-cli/worktree.ts";
import type { AgentStatusEvent } from "../../../src/ports/agent.ts";

const FAKE = join(import.meta.dirname, "fake-agent.ts");
export const SESSION = "0e9d6c1f-4a3b-4a52-9c85-2f6d3f6f2f10";
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real git, run without the GIT_* variables of the process: a git hook exports GIT_INDEX_FILE and the like, which would
 * point the temp repos' git at the repo the hook runs in.
 */
export const git: Git = (repo, args) =>
	new Promise((resolve, reject) => {
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		execFile("git", ["-C", repo, ...args], { encoding: "utf8", env }, (error, stdout, stderr) => {
			if (error) reject(new Error(`git ${args.join(" ")} in ${repo}: ${stderr.trim() || error.message}`));
			else resolve(stdout);
		});
	});

// What each test made, undone by cleanUp, which every test file runs after each test.
const cleanups: (() => Promise<unknown>)[] = [];
export async function cleanUp(): Promise<void> {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

/** A git repo with one commit under a fresh temp directory, which macOS reaches through a symlink. */
export async function repo(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "soma-acp-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "repo");
	await git(directory, ["init", "-q", "-b", "main", path]);
	await git(path, [
		"-c",
		"user.name=soma",
		"-c",
		"user.email=soma@example.com",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-q",
		"--no-verify",
		"--allow-empty",
		"-m",
		"init",
	]);
	return path;
}

/** An ACP port that runs the fake agent, with every status it emitted and every error it logged. */
export async function harness(options: Partial<AcpAgentPortOptions> & { fake?: Record<string, string> } = {}) {
	const cwd = await repo();
	const projects = join(cwd, "..", "projects");
	const errors: Error[] = [];
	const port = createAcpAgentPort({
		command: process.execPath,
		args: [FAKE],
		env: {
			PATH: process.env.PATH,
			HOME: "/home/someone",
			USER: "someone",
			FAKE_ACP_PROJECTS: projects,
			...options.fake,
		},
		projectsDir: projects,
		sessionsFile: join(cwd, "..", "acp-sessions.json"),
		cap: 4,
		git,
		replyMs: 400,
		recheckMs: 50,
		closeMs: 500,
		onError: (error) => errors.push(error),
		...options,
	});
	const events: AgentStatusEvent[] = [];
	port.onStatus((event) => events.push(event));
	const started: string[] = [];
	cleanups.push(async () => {
		for (const name of started) await port.stop(name).catch(() => {});
	});
	return {
		port,
		cwd,
		events,
		errors,
		sessionsFile: join(cwd, "..", "acp-sessions.json"),
		start: async (name = "card-a") => {
			started.push(name);
			await port.start({ name, card: name, cwd, sessionId: SESSION });
		},
		/** The first status of `name`, from the index `from` on, in `state`. */
		until: async (state: string, from = 0, name = "card-a", ms = 5_000) => {
			for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(10)) {
				const found = events.slice(from).find((event) => event.agent === name && event.status.state === state);
				if (found !== undefined) return found;
			}
			throw new Error(`no ${state} of ${name} within ${ms} ms: ${JSON.stringify(events.slice(from))}`);
		},
	};
}
