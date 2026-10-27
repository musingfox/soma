// rex and the native tty have no worktree methods, so their adapters run git themselves (ARCHITECTURE.md「rex 的實作」).
import { execFile } from "node:child_process";
import { join } from "node:path";

export type Git = (repo: string, args: readonly string[]) => Promise<string>;

export const runGit: Git = (repo, args) =>
	new Promise((resolve, reject) => {
		execFile("git", ["-C", repo, ...args], { encoding: "utf8" }, (error, stdout, stderr) => {
			if (error) reject(new Error(`git ${args.join(" ")} in ${repo}: ${stderr.trim() || error.message}`));
			else resolve(stdout);
		});
	});

/** The path of every worktree of the repo, by the branch it has checked out. */
function worktreesByBranch(porcelain: string): Map<string, string> {
	const byBranch = new Map<string, string>();
	for (const stanza of porcelain.split("\n\n")) {
		const path = /^worktree (.+)$/m.exec(stanza)?.[1];
		const branch = /^branch refs\/heads\/(.+)$/m.exec(stanza)?.[1];
		if (path !== undefined && branch !== undefined) byBranch.set(branch, path);
	}
	return byBranch;
}

/** The main checkout of the repo `path` is a worktree of, which git lists first; undefined for a bare repo. */
export async function mainCheckout(git: Git, path: string): Promise<string | undefined> {
	const [first = ""] = (await git(path, ["worktree", "list", "--porcelain"])).split("\n\n");
	return /^bare$/m.test(first) ? undefined : /^worktree (.+)$/m.exec(first)?.[1];
}

/**
 * The card's worktree at `<repo>/.claude/worktrees/<card>` on branch `fleet/<card>`, where claude inherits the main
 * checkout's folder trust. A rerun after a crash finds the branch already there and reopens the same worktree.
 */
export async function openWorktree(git: Git, repo: string, card: string): Promise<string> {
	const branch = `fleet/${card}`;
	const open = worktreesByBranch(await git(repo, ["worktree", "list", "--porcelain"])).get(branch);
	if (open !== undefined) return open;
	const path = join(repo, ".claude", "worktrees", card);
	const exists = (await git(repo, ["branch", "--list", branch])).trim() !== "";
	await git(repo, exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path]);
	return path;
}
