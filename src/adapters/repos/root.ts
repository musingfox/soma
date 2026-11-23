import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The git repo root `cwd` is in: the nearest directory from `cwd` upwards that holds a `.git` entry, a file as a linked
 * worktree or a submodule has counting too; undefined when there is none. Reads the file system only, so a hand-off is
 * named without running git.
 */
export async function repoRootOf(cwd: string): Promise<string | undefined> {
	for (let directory = cwd; ; directory = dirname(directory)) {
		const found = await lstat(join(directory, ".git")).then(
			() => true,
			() => false,
		);
		if (found) return directory;
		if (dirname(directory) === directory) return undefined;
	}
}
