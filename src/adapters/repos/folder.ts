import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { RepoCheck } from "../../ports/dispatch.ts";

const reason = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === "ENOENT" ? "it does not exist" : (error as Error).message;

/**
 * The repos `soma dispatch` may start a job in: a git repository whose real path is a direct child of `folder`'s, with
 * every link resolved, so neither a link under the folder nor `..` reaches past it. A `.git` file counts, as a linked
 * worktree or a submodule has. With no folder, every repo is refused.
 */
export function repoUnder(folder: string | undefined): RepoCheck {
	return async (path) => {
		if (folder === undefined) return { refused: "soma's config names no reposDir, so soma dispatch starts no job" };
		if (!isAbsolute(path)) return { refused: `the repo must be an absolute path, got "${path}"` };
		let root: string;
		try {
			root = await realpath(folder);
		} catch (error) {
			return { refused: `reposDir ${folder} cannot be resolved: ${reason(error)}` };
		}
		let repo: string;
		try {
			repo = await realpath(path);
		} catch (error) {
			const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
			return { refused: missing ? `${path} does not exist` : `${path} cannot be resolved: ${reason(error)}` };
		}
		if (dirname(repo) !== root) {
			const resolved = repo === path ? path : `${path} resolves to ${repo}, which`;
			return { refused: `${resolved} is not directly under ${root}` };
		}
		if (!(await stat(repo)).isDirectory()) return { refused: `${repo} is not a directory` };
		try {
			await stat(join(repo, ".git"));
		} catch {
			return { refused: `${repo} is not a git repository: it has no .git` };
		}
		return { repo };
	};
}
