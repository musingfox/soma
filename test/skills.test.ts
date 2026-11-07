import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { afterAll, expect, test } from "vitest";
import { loadSkills, readSkillFile } from "../src/adapters/skills/index.ts";
import { resolveConfig } from "../src/config.ts";
import { language } from "../src/core/extensions/language/index.ts";
import { openHarness } from "../src/core/harness.ts";
import { skillsExtensions } from "../src/skills.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "soma-skills-"));
const harnesses: Harness[] = [];
afterAll(async () => {
	for (const harness of harnesses) await harness.close(context);
	chmodSync(join(skillsDir, "unreadable/SKILL.md"), 0o644);
	rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

const skillsDir = join(dir, "skills");
write(
	join(skillsDir, "dispatch-check/SKILL.md"),
	"---\nname: dispatch-check\ndescription: >\n  Check a card before dispatching it.\n  Use before every dispatch.\n---\n\n# Check\n\nRead references/list.md.\n",
);
write(join(skillsDir, "dispatch-check/references/list.md"), "1. The card has acceptance criteria.\n");
write(
	join(skillsDir, "group/report-style/SKILL.md"),
	"---\ndescription: Write reports <short> & plain.\n---\nBe short.\n",
);
write(join(skillsDir, "broken/SKILL.md"), "---\nname: broken\n---\nNo description.\n");
write(join(skillsDir, "hidden/SKILL.md"), "---\ndescription: Only by command.\ndisable-model-invocation: true\n---\n");
write(join(dir, "secret.txt"), "outside");
symlinkSync(join(dir, "secret.txt"), join(skillsDir, "dispatch-check/leak.md"));
// Found first by directory, listed last by name.
write(join(skillsDir, "aaa-dir/SKILL.md"), "---\nname: zz-last\ndescription: Sorted by name.\n---\n");
write(join(dir, "repo/linked-skill/SKILL.md"), "---\ndescription: Linked in from a repository.\n---\n");
symlinkSync(join(dir, "repo/linked-skill"), join(skillsDir, "linked-skill"));
symlinkSync(skillsDir, join(skillsDir, "group/loop"));
write(join(skillsDir, "unreadable/SKILL.md"), "---\ndescription: Cannot be read.\n---\n");
chmodSync(join(skillsDir, "unreadable/SKILL.md"), 0o000);

async function promptOf(extensions: Awaited<ReturnType<typeof skillsExtensions>>, calls: unknown[] = []) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await openHarness(
		join(mkdtempSync(join(dir, "db-")), "soma.sqlite"),
		[language("en"), ...extensions],
		context,
		{ models },
	);
	harnesses.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	const seen: TranscriptContext[] = [];
	faux.setResponses([
		...calls.map((call) => (request: TranscriptContext) => {
			seen.push(request);
			return fauxAssistantMessage(call as Parameters<typeof fauxAssistantMessage>[0], { stopReason: "toolUse" });
		}),
		(request: TranscriptContext) => {
			seen.push(request);
			return fauxAssistantMessage("ok");
		},
	]);
	expect((await (await root.submit({ type: "input", content: "hi" }, context)).wait(context)).status).toBe("done");
	return seen;
}

const systemOf = (request: TranscriptContext | undefined) =>
	JSON.stringify(request?.messages.filter((m) => m.role === "system"));

test("the prompt lists each loadable skill by name and description, and the log names the one skipped", async () => {
	const logged: string[] = [];
	const extensions = await skillsExtensions(skillsDir, (path) => loadSkills(path, (line) => logged.push(line)));
	const system = systemOf((await promptOf(extensions))[0]);

	expect(system).toContain("<name>dispatch-check</name>");
	expect(system).toContain("<description>Check a card before dispatching it. Use before every dispatch.</description>");
	expect(system).toContain("<name>report-style</name>");
	expect(system).toContain("Write reports &lt;short&gt; &amp; plain.");
	expect(system).not.toContain("broken");
	expect(system).not.toContain("hidden");
	expect(system).toContain("<name>linked-skill</name>");
	expect(system.indexOf("dispatch-check")).toBeLessThan(system.indexOf("report-style"));
	expect(system.indexOf("report-style")).toBeLessThan(system.indexOf("zz-last"));
	expect(system).not.toContain("Cannot be read.");
	expect(logged).toHaveLength(2);
	expect(logged[0]).toBe(`[soma] skill ${join(skillsDir, "broken/SKILL.md")} skipped (no description)`);
	expect(logged[1]).toMatch(/^\[soma\] skill .*unreadable\/SKILL\.md skipped \(cannot be read: EACCES/);
});

test("skill_read reads a skill and a file in its directory, through the harness", async () => {
	const extensions = await skillsExtensions(skillsDir, (path) => loadSkills(path, () => {}));
	const seen = await promptOf(extensions, [
		fauxToolCall("skill_read", { name: "dispatch-check" }),
		fauxToolCall("skill_read", { name: "dispatch-check", path: "references/list.md" }),
		fauxToolCall("skill_read", { name: "nobody" }),
	]);
	const results = seen.at(-1)?.messages.filter((m) => m.role === "toolResult") ?? [];
	expect(results.map((result) => result.role === "toolResult" && result.isError)).toEqual([false, false, true]);
	expect(JSON.stringify(results[0]?.content)).toContain("Read references/list.md.");
	expect(JSON.stringify(results[1]?.content)).toContain("The card has acceptance criteria.");
	expect(JSON.stringify(results[2]?.content)).toContain("no skill is named nobody");
});

test("a skill's file is read only inside its directory", async () => {
	const [skill] = (await loadSkills(skillsDir, () => {})).filter((each) => each.name === "dispatch-check");
	if (skill === undefined) throw new Error("dispatch-check not loaded");
	expect(await readSkillFile(skill)).toContain("# Check");
	await expect(readSkillFile(skill, "../group/report-style/SKILL.md")).rejects.toThrow("outside the skill");
	await expect(readSkillFile(skill, join(dir, "secret.txt"))).rejects.toThrow("is absolute");
	await expect(readSkillFile(skill, "leak.md")).rejects.toThrow("outside the skill");
	await expect(readSkillFile(skill, "missing.md")).rejects.toThrow("has no file missing.md");
});

test("with no skill, no extension is installed and the prompt is as before", async () => {
	write(join(dir, "empty/notes.md"), "not a skill");
	expect(await skillsExtensions(join(dir, "empty"))).toEqual([]);
	expect(await skillsExtensions(join(dir, "absent"))).toEqual([]);
	const before = systemOf((await promptOf([]))[0]);
	expect(before).not.toContain("available_skills");
});

test("skillsDir defaults under ~/.config/soma and can be set", () => {
	expect(resolveConfig({}, {}, "/home/me").skillsDir).toBe("/home/me/.config/soma/skills");
	expect(resolveConfig({ skillsDir: "/srv/skills" }, {}, "/home/me").skillsDir).toBe("/srv/skills");
	expect(resolveConfig({}, { SOMA_SKILLS_DIR: "/env/skills" }, "/home/me").skillsDir).toBe("/env/skills");
});
