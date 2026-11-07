import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { parse } from "yaml";

/** A skill as the Agent Skills specification has it (https://agentskills.io/specification): its directory's SKILL.md. */
export interface LoadedSkill {
	readonly name: string;
	readonly description: string;
	/** The real path of the directory holding its SKILL.md. */
	readonly dir: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** What a SKILL.md says of itself, or why it is not loaded. */
function frontmatterOf(text: string): { name?: string; description: string; hidden: boolean } | string {
	const block = FRONTMATTER.exec(text)?.[1];
	if (block === undefined) return "no frontmatter";
	let data: unknown;
	try {
		data = parse(block);
	} catch (error) {
		return `frontmatter does not parse: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (typeof data !== "object" || data === null) return "frontmatter is not a mapping";
	const { name, description } = data as Record<string, unknown>;
	if (typeof description !== "string" || description.trim() === "") return "no description";
	return {
		...(typeof name === "string" && name.trim() !== "" && { name: name.trim() }),
		description: description.trim(),
		hidden: (data as Record<string, unknown>)["disable-model-invocation"] === true,
	};
}

/** Each SKILL.md under `dir`, following symbolic links (a skill is often linked in from a repository) but no directory twice. */
async function skillFiles(dir: string, seen = new Set<string>()): Promise<string[]> {
	let entries: Dirent[];
	try {
		const real = await realpath(dir);
		if (seen.has(real)) return [];
		seen.add(real);
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const kind = async (entry: Dirent) => {
		if (!entry.isSymbolicLink()) return entry.isFile() ? "file" : entry.isDirectory() ? "dir" : undefined;
		const target = await stat(join(dir, entry.name)).catch(() => undefined);
		return target?.isFile() ? "file" : target?.isDirectory() ? "dir" : undefined;
	};
	const found: string[] = [];
	const skill = entries.find((entry) => entry.name === "SKILL.md");
	if (skill !== undefined && (await kind(skill)) === "file") found.push(join(dir, "SKILL.md"));
	for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
		if (entry.name.startsWith(".") || (await kind(entry)) !== "dir") continue;
		found.push(...(await skillFiles(join(dir, entry.name), seen)));
	}
	return found;
}

/**
 * The skills under `root`, sorted by name. A missing root holds none. A skill that cannot be loaded is skipped and
 * logged; of two with one name the first found is kept. One the model may not invoke is left out, since soma has no
 * command to invoke it by.
 */
export async function loadSkills(root: string, log: (line: string) => void = console.error): Promise<LoadedSkill[]> {
	const skills = new Map<string, LoadedSkill>();
	for (const file of await skillFiles(root)) {
		const dir = dirname(file);
		let read: ReturnType<typeof frontmatterOf>;
		try {
			read = frontmatterOf(await readFile(file, "utf8"));
		} catch (error) {
			read = `cannot be read: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (typeof read === "string") {
			log(`[soma] skill ${file} skipped (${read})`);
			continue;
		}
		if (read.hidden) continue;
		const name = read.name ?? basename(dir);
		if (skills.has(name)) {
			log(`[soma] skill ${file} skipped (another skill is named ${name})`);
			continue;
		}
		skills.set(name, { name, description: read.description, dir: await realpath(dir) });
	}
	return [...skills.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * A file of a skill, by its path relative to the skill's directory; SKILL.md when none is given. Rejects a path that
 * leaves the directory, through `..`, an absolute path or a symbolic link.
 */
export async function readSkillFile(skill: LoadedSkill, path = "SKILL.md"): Promise<string> {
	if (isAbsolute(path)) throw new Error(`${path} is absolute; give a path relative to the skill ${skill.name}`);
	let real: string;
	try {
		real = await realpath(join(skill.dir, path));
	} catch {
		throw new Error(`skill ${skill.name} has no file ${path}`);
	}
	const inside = relative(skill.dir, real);
	if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
		throw new Error(`${path} is outside the skill ${skill.name}`);
	}
	return readFile(real, "utf8");
}
