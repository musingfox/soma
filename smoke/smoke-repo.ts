// The repo a smoke starts an interactive claude in, unless it is given one.
//
// claude keys folder trust on the git repository root and a muster worker's directory is its own clone, at a new path
// each run. So the current directory is trusted in the main checkout but not in a worker's, where the dialog stops the
// smoke and a yes leaves one more entry in ~/.claude.json. One fixed repo, trusted once by the human, needs neither.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

/** Claude Code's trust for each project path, read and never written: claude rewrites this file as it runs. */
async function hasTrust(home: string, path: string): Promise<boolean> {
	const text = await readFile(join(home, ".claude.json"), "utf8").catch(() => "{}");
	const projects = (JSON.parse(text) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }).projects;
	return projects?.[path]?.hasTrustDialogAccepted === true;
}

/** The fixed smoke repo's path; throws with the setup steps, before the smoke creates anything, if it cannot be used. */
export async function fixedSmokeRepo(home: string): Promise<string> {
	const repo = join(home, ".cache", "soma-smoke", "repo");
	const setUp = (problem: string) =>
		new Error(
			`${problem}\n` +
				"A human sets it up once, in their own terminal; a worker must not, and must not answer a trust dialog:\n" +
				`  git init ${repo}\n` +
				`  git -C ${repo} commit --allow-empty -m "chore: empty repo for soma smokes"\n` +
				`  cd ${repo} && claude\n` +
				'In claude, choose "Yes, I trust this folder", then /exit.',
		);
	if (!existsSync(join(repo, ".git"))) throw setUp(`The fixed smoke repo ${repo} is missing.`);
	// claude keys its trust by the real path.
	if (!(await hasTrust(home, await realpath(repo)))) throw setUp(`claude does not trust the fixed smoke repo ${repo}.`);
	return repo;
}

/**
 * The card's branch `fleet/<card>`, one commit past HEAD that adds these settings as .claude/settings.json, which the
 * card's worktree then checks out (`openWorktree`). A job needs settings of its own to be asked what the human's mode
 * would allow, and the fixed repo is shared, so they go on no branch but this one and touch neither its main nor its
 * checkout. The index is a scratch one, under `scratch`; the commit is unsigned, as commit-tree's are without -S.
 */
export function branchWithSettings(repo: string, card: string, settings: object, scratch: string): void {
	const git = (args: string[], input?: string) => {
		const identity = ["-c", "user.name=soma smoke", "-c", "user.email=smoke@example.com"];
		const { status, stdout, stderr } = spawnSync("git", ["-C", repo, ...identity, ...args], {
			encoding: "utf8",
			input,
			env: { ...process.env, GIT_INDEX_FILE: join(scratch, `${card}.index`) },
		});
		if (status !== 0) throw new Error(`git ${args.join(" ")} in ${repo}: ${stderr.trim()}`);
		return stdout.trim();
	};
	git(["read-tree", "HEAD"]);
	const blob = git(["hash-object", "-w", "--stdin"], `${JSON.stringify(settings)}\n`);
	git(["update-index", "--add", "--cacheinfo", `100644,${blob},.claude/settings.json`]);
	const commit = git(["commit-tree", git(["write-tree"]), "-p", "HEAD", "-m", "chore: settings for one smoke"]);
	git(["branch", `fleet/${card}`, commit]);
}
