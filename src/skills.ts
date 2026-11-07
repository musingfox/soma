import { type LoadedSkill, loadSkills, readSkillFile } from "./adapters/skills/index.ts";
import { skillsExtension } from "./core/extensions/skills/index.ts";

/** The skills extension over the skills in `dir`; none when it holds no skill, so the prompt stays as it was. */
export async function skillsExtensions(dir: string, load: (dir: string) => Promise<LoadedSkill[]> = loadSkills) {
	const skills = await load(dir);
	if (skills.length === 0) return [];
	const byName = new Map(skills.map((skill) => [skill.name, skill]));
	return [
		skillsExtension(skills, async (name, path) => {
			const skill = byName.get(name);
			if (skill === undefined) throw new Error(`no skill is named ${name}`);
			return readSkillFile(skill, path);
		}),
	];
}
