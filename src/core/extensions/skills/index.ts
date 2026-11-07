import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";

export const SKILL_MAX_CHARS = 20_000;

export interface Skill {
	readonly name: string;
	readonly description: string;
}

/** Reads a file of a skill by its path relative to the skill's directory. A rejection's message is shown to the model. */
export type ReadSkill = (name: string, path: string | undefined) => Promise<string>;

const escapeXml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The list the model routes by, as pi's `formatSkillsForPrompt` gives it; the same skills always render the same text. */
export function renderSkills(skills: readonly Skill[]): string {
	const listed = skills.map(
		(skill) =>
			`  <skill>\n    <name>${escapeXml(skill.name)}</name>\n    <description>${escapeXml(skill.description)}</description>\n  </skill>`,
	);
	return (
		"The skills below are the human's instructions for particular kinds of work. When a request matches a skill's " +
		"description, read the skill with skill_read before you act, and follow it. A path the skill names is relative " +
		"to the skill; read it with skill_read's path.\n" +
		`<available_skills>\n${listed.join("\n")}\n</available_skills>`
	);
}

/**
 * Skills in the Agent Skills format (card soma-skills): the prompt lists each skill's name and description, and
 * skill_read loads one when a request matches it. A skill is the human's own instructions, so unlike a note it is not
 * fenced as untrusted text.
 */
export function skillsExtension(skills: readonly Skill[], read: ReadSkill) {
	const names = new Set(skills.map((skill) => skill.name));
	const skillRead = defineTool({
		name: "skill_read",
		description: `Read a skill listed in available_skills: its SKILL.md, or a file in its directory by a path relative to it. Long files are cut at ${SKILL_MAX_CHARS} characters.`,
		parameters: obj({
			name: str({ description: "The skill's name, as available_skills lists it" }),
			path: opt(
				str({ description: "A file in the skill's directory, such as references/formats.md; SKILL.md unless set" }),
			),
		}),
		replay: "safe",
		execute: async ({ name, path }) => {
			if (!names.has(name)) {
				return { output: [{ type: "text" as const, text: `no skill is named ${name}` }], isError: true };
			}
			try {
				const chars = [...(await read(name, path))];
				const text =
					chars.length > SKILL_MAX_CHARS
						? `${chars.slice(0, SKILL_MAX_CHARS).join("")}\n[cut at ${SKILL_MAX_CHARS} characters]`
						: chars.join("");
				return { output: [{ type: "text" as const, text }], isError: false };
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				return { output: [{ type: "text" as const, text }], isError: true };
			}
		},
	});
	return defineExtension({
		name: "soma.skills",
		sections: [section("skills", () => renderSkills(skills))],
		tools: [skillRead],
	});
}
