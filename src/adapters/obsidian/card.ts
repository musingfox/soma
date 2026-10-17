import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Reads an obw task card through the obsidian CLI, from the vault and project the repo's
 * `.obsidian.yaml` names (`vault:` and `pm.project:`).
 */
export async function readCard(repo: string, card: string): Promise<string> {
	const config = await readFile(join(repo, ".obsidian.yaml"), "utf8");
	const vault = /^vault:\s*(\S+)/m.exec(config)?.[1];
	const project = /^pm:\s*\n(?:[ \t]+.*\n)*?[ \t]+project:\s*(\S+)/m.exec(config)?.[1];
	if (vault === undefined || project === undefined)
		throw new Error(`${repo}/.obsidian.yaml names no vault or pm.project`);
	const { stdout } = await run("obsidian", [`vault=${vault}`, "read", `path=pm/${project}/tasks/${card}.md`]);
	// The CLI exits 0 on a missing file and says so on stdout.
	if (stdout.startsWith("Error:")) throw new Error(stdout.trim());
	return stdout;
}
