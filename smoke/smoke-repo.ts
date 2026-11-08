// The repo a smoke starts an interactive claude in, unless it is given one.
//
// claude keys folder trust on the git repository root and a muster worker's directory is its own clone, at a new path
// each run. So the current directory is trusted in the main checkout but not in a worker's, where the dialog stops the
// smoke and a yes leaves one more entry in ~/.claude.json. One fixed repo, trusted once by the human, needs neither.
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
