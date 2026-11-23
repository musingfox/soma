import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { loadSkills } from "../src/adapters/skills/index.ts";
import { deferAt } from "../src/core/domain/defer.ts";

// The variable Claude Code substitutes, spelled out: it is no template placeholder here.
const SKILL_DIR = ["$", "{CLAUDE_SKILL_DIR}"].join("");
const DIR = resolve(import.meta.dirname, "../agent-skills");
const TEXT = readFileSync(resolve(DIR, "soma-defer/SKILL.md"), "utf8");
// Claude Code reads the frontmatter only when the opening `---` is the file's first line.
const [, FRONT = "", BODY = ""] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(TEXT) ?? [];

test("the skill's frontmatter opens the file, parses, and has a name, a description and the one allowed command", async () => {
	const front = parse(FRONT) as Record<string, unknown>;

	expect(front.name).toBe("soma-defer");
	expect(typeof front.description).toBe("string");
	// Truncated in the skill listing past this.
	expect((front.description as string).length).toBeLessThanOrEqual(1536);
	expect(front["allowed-tools"]).toBe(`Bash(sh ${SKILL_DIR}/register.sh *)`);
	const loaded = await loadSkills(DIR, () => {});
	expect(loaded.map((skill) => [skill.name, skill.description])).toEqual([["soma-defer", front.description]]);
});

test("the body runs the script through CLAUDE_SKILL_DIR, and every --at value it shows is one soma takes", () => {
	expect(BODY).toContain(`sh "${SKILL_DIR}/register.sh" --at `);
	const flagged = [...BODY.matchAll(/--at[ =]([^\s`]+)/g)].map((match) => match[1] ?? "");
	// The values `--at` is said to take, shown on their own in backticks.
	const shown = [...BODY.matchAll(/`(P[^`\s]*|\d{4}-[^`\s]*)`/g)].map((match) => match[1] ?? "");
	const values = [...flagged, ...shown].filter((value) => !value.startsWith("<"));

	expect(flagged.filter((value) => !value.startsWith("<")).length).toBeGreaterThan(0);
	expect(shown.length).toBeGreaterThan(0);
	// A date-time the skill shows is in the future of this fixed clock, so only the form is checked.
	const now = Date.parse("2026-01-01T00:00:00Z");
	for (const value of values) expect(() => deferAt(value, now), value).not.toThrow();
});

test("the skill says nothing of how the script reaches soma", () => {
	for (const seam of [".req", ".reply", "SOMA_HANDOFF_DIR", "soma.sqlite", "soma defer", "releases/current"]) {
		expect(TEXT, seam).not.toContain(seam);
	}
});
