import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The vault and the card path the repo's `.obsidian.yaml` names (`vault:` and `pm.project:`). */
async function locate(repo: string, card: string) {
	const config = await readFile(join(repo, ".obsidian.yaml"), "utf8");
	const vault = /^vault:\s*(\S+)/m.exec(config)?.[1];
	const project = /^pm:\s*\n(?:[ \t]+.*\n)*?[ \t]+project:\s*(\S+)/m.exec(config)?.[1];
	if (vault === undefined || project === undefined)
		throw new Error(`${repo}/.obsidian.yaml names no vault or pm.project`);
	const obsidian = async (...args: string[]) => (await run("obsidian", [`vault=${vault}`, ...args])).stdout;
	return { obsidian, project, path: `pm/${project}/tasks/${card}.md` };
}

// The CLI exits 0 on a failure and says so on stdout.
const checked = (stdout: string) => {
	if (stdout.startsWith("Error:")) throw new Error(stdout.trim());
	return stdout;
};

/** Reads an obw task card through the obsidian CLI. */
export async function readCard(repo: string, card: string): Promise<string> {
	const { obsidian, path } = await locate(repo, card);
	return checked(await obsidian("read", `path=${path}`));
}

/**
 * Creates an obw task card the way obw pm does: from the vault's `task` template, then one property per call. `body`
 * goes under the template's Description. Returns false, touching nothing, when a card of that name already exists.
 */
export async function createCard(
	repo: string,
	card: string,
	{ title, body }: { title: string; body: string },
): Promise<boolean> {
	const { obsidian, project, path } = await locate(repo, card);
	if (!(await obsidian("read", `path=${path}`)).startsWith("Error:")) return false;
	const created = checked(await obsidian("create", `path=${path}`, "template=task"));
	// A create on a taken path writes "<card> 1.md" instead of failing, so the path it reports is checked.
	if (created.trim() !== `Created: ${path}`) throw new Error(`obsidian create: ${created.trim()}`);
	for (const [name, value] of [
		["title", title],
		["project", project],
	] as const)
		checked(await obsidian("property:set", `path=${path}`, `name=${name}`, `value=${value}`));
	// The template ignores create's content, so the body is written over the filled template.
	const filled = checked(await obsidian("read", `path=${path}`)).replace(
		/^## Description\n+/m,
		`## Description\n\n${body.trim()}\n\n`,
	);
	checked(await obsidian("create", `path=${path}`, `content=${filled}`, "overwrite"));
	return true;
}
