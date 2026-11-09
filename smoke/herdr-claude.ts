// A herdr smoke's claude in a config of its own, so it answers a real trust dialog and ~/.claude.json gains nothing.
//
// A pane sees its herdr server's environment, not the smoke's, and agent.start takes none, so the claude starts in a new
// tab of the worktree's workspace, as tab.create does take one. The variables are never typed at the shell.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HerdrClient } from "../src/adapters/herdr/client.ts";
import { waitForAvailableShell } from "../src/adapters/herdr/readiness.ts";
import { PaneProcessInfoResultSchema } from "../src/adapters/herdr/schema.ts";
import { delay } from "./driver.ts";

const claudeEnv = (config: string) => ({
	CLAUDE_CONFIG_DIR: config,
	// claude names its login's Keychain item after a CLAUDE_CONFIG_DIR, which would leave this config with no login.
	// Empty, this keeps the usual name; the smoke handles no credential.
	CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
});

/** Creates the config: past the first-run screens, and with herdr's hook, which is how herdr learns the session id. */
export async function seedClaudeConfig(config: string): Promise<void> {
	await mkdir(config);
	await writeFile(join(config, ".claude.json"), `${JSON.stringify({ hasCompletedOnboarding: true })}\n`);
	const { status, stderr } = spawnSync("herdr", ["integration", "install", "claude"], {
		encoding: "utf8",
		env: { ...process.env, CLAUDE_CONFIG_DIR: config },
	});
	if (status !== 0) throw new Error(`herdr integration install claude: ${stderr.trim()}`);
}

const processInfo = (client: HerdrClient) => async (pane: string) =>
	(await client.call("pane.process_info", { pane_id: pane }, PaneProcessInfoResultSchema)).process_info;

/** A new tab at the shell prompt, beside `pane` and in its directory, whose shell has claude's config and `env`. */
export async function paneInConfig(
	client: HerdrClient,
	pane: string,
	config: string,
	env: Record<string, string> = {},
): Promise<string> {
	const beside = (await client.sessionSnapshot()).panes.find((each) => each.pane_id === pane);
	if (beside === undefined) throw new Error(`herdr has no pane ${pane}`);
	const { root_pane } = await client.call<{ root_pane: { pane_id: string } }>("tab.create", {
		workspace_id: beside.workspace_id,
		cwd: beside.cwd,
		env: { ...claudeEnv(config), ...env },
		focus: false,
	});
	await waitForAvailableShell({ paneId: root_pane.pane_id, processInfo: processInfo(client) });
	return root_pane.pane_id;
}

/** The client for a herdr AgentPort whose agents all start with their claude in `config`. */
export function startingInConfig(client: HerdrClient, config: string): HerdrClient {
	const call: HerdrClient["call"] = async (method, params, schema, options) => {
		if (method !== "agent.start") return client.call(method, params, schema, options);
		const start = params as { pane_id: string };
		const pane_id = await paneInConfig(client, start.pane_id, config);
		return client.call(method, { ...start, pane_id }, schema, options);
	};
	return { ...client, call };
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function ended(pids: number[], ms: number): Promise<boolean> {
	for (const deadline = Date.now() + ms; pids.some(alive) && Date.now() < deadline; ) await delay(200);
	return !pids.some(alive);
}

/**
 * Removes the worktrees of these agents and waits for their claudes: one that outlives its core by a moment writes its
 * config back, after a removal of the directory that came too soon. Resolves to the pids it waited for.
 */
export async function removeAgents(client: HerdrClient, names: string[]): Promise<number[]> {
	const agents = (await client.agentList()).filter((agent) => names.includes(agent.name ?? ""));
	const infos = await Promise.all(agents.map((agent) => processInfo(client)(agent.pane_id)));
	const claudes = infos.flatMap(({ foreground_processes }) =>
		(foreground_processes ?? []).flatMap(({ pid, argv }) => (argv?.[0] === "claude" && pid !== undefined ? [pid] : [])),
	);
	for (const workspace_id of new Set(agents.map((agent) => agent.workspace_id))) {
		await client.call("worktree.remove", { workspace_id, force: true });
	}
	if (!(await ended(claudes, 10_000))) {
		console.error(`the pane's claude outlived its worktree, and is killed: ${claudes.filter(alive)}`);
		for (const pid of claudes.filter(alive)) process.kill(pid, "SIGTERM");
		await ended(claudes, 5_000);
	}
	return claudes;
}

/** The project paths the `.claude.json` in `directory` marks as trusted; nothing else is read out of it. */
export async function trusted(directory: string): Promise<Set<string>> {
	const text = await readFile(join(directory, ".claude.json"), "utf8");
	const { projects } = JSON.parse(text) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
	return new Set(
		Object.entries(projects ?? {}).flatMap(([path, entry]) => (entry.hasTrustDialogAccepted ? [path] : [])),
	);
}

/**
 * Throws unless the answer to the dialog landed for `repo` in `config`, and `home`'s `.claude.json` gained nothing at or
 * under the `own` paths. Other claudes of the human's may gain theirs meanwhile. claude may not have written the answer
 * when it first reports itself up, so call this after a turn.
 */
export async function checkTrust(
	config: string,
	repo: string,
	home: string,
	before: Set<string>,
	own: string[],
): Promise<{ gained: string[]; ours: string[]; inOwnConfig: string[] }> {
	let inOwnConfig = await trusted(config);
	for (const deadline = Date.now() + 30_000; !inOwnConfig.has(repo) && Date.now() < deadline; await delay(250)) {
		inOwnConfig = await trusted(config);
	}
	const gained = [...(await trusted(home))].filter((path) => !before.has(path));
	const ours = gained.filter((path) => own.some((each) => path === each || path.startsWith(`${each}/`)));
	const result = { gained, ours, inOwnConfig: [...inOwnConfig] };
	if (!inOwnConfig.has(repo)) throw new Error(`the answer did not land in the smoke's own config: ${[...inOwnConfig]}`);
	if (ours.length > 0) throw new Error(`~/.claude.json gained trust for ${JSON.stringify(ours)}`);
	return result;
}
