import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { obsidianVault } from "../../../src/adapters/obsidian/vault.ts";

const dir = mkdtempSync(join(tmpdir(), "soma-obsidian-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A stand-in for the obsidian CLI that answers each command with a canned stdout and exits 0, as the real one does.
 * Each call's arguments, one per line, go to `<bin>.log`.
 */
function fakeCli(answers: Record<string, string>): string {
	const bin = join(
		dir,
		`obsidian-${Object.keys(answers)
			.join("-")
			.replace(/[^a-z-]/g, "")}-${Math.random()}`,
	);
	const cases = Object.entries(answers)
		.map(([command, stdout]) => `  ${command}) printf '%b' ${JSON.stringify(stdout)} ;;`)
		.join("\n");
	writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" >> "$0.log"\ncase "$2" in\n${cases}\nesac\n`);
	chmodSync(bin, 0o755);
	return bin;
}

test("a note that begins with Error: is read as a note", async () => {
	const bin = fakeCli({ file: "path\tnotes/log.md\nname\tlog\n", read: "Error: the build failed\nmore" });
	expect(await obsidianVault("v", bin).read("notes/log.md")).toBe("Error: the build failed\nmore");
});

test.each([
	["a missing note", 'Error: File "notes/x.md" not found.'],
	["an unknown vault", "Vault not found."],
])("%s is an error, not a note", async (_name, stdout) => {
	const bin = fakeCli({ file: stdout, read: "should not be read" });
	await expect(obsidianVault("v", bin).read("notes/x.md")).rejects.toThrow(stdout);
});

test("a search answer that is not a match list is an error", async () => {
	const vault = obsidianVault("v", fakeCli({ "search:context": "Vault not found." }));
	await expect(vault.search("fox", 10)).rejects.toThrow("Vault not found.");
	expect(await obsidianVault("v", fakeCli({ "search:context": "No matches found.\n" })).search("fox", 10)).toEqual([]);
});

const calls = (bin: string) => (existsSync(`${bin}.log`) ? readFileSync(`${bin}.log`, "utf8").split("\n") : []);
const missing = 'Error: File "notes/fox.md" not found.';

test("a new note is created without overwrite, and an existing path is refused before create runs", async () => {
	const made = fakeCli({ file: missing, create: "Created: notes/fox.md\n" });
	await obsidianVault("v", made).create("notes/fox.md", "# Fox");
	expect(calls(made)).toContain("content=# Fox");
	expect(calls(made)).not.toContain("overwrite");
	const exists = fakeCli({ file: "path\tnotes/fox.md\nname\tfox\n", create: "Created: notes/fox.md\n" });
	await expect(obsidianVault("v", exists).create("notes/fox.md", "x")).rejects.toThrow("exists");
	expect(calls(exists)).not.toContain("create");
});

test("a create that made another file than asked is an error", async () => {
	const bin = fakeCli({ file: missing, create: "Created: notes/fox 1.md\n" });
	await expect(obsidianVault("v", bin).create("notes/fox.md", "x")).rejects.toThrow("Created: notes/fox 1.md");
});

test("an append the CLI answers with an error, such as a missing heading, is an error", async () => {
	const bin = fakeCli({ append: "Error: Heading “Nope” not found in file.\n" });
	await expect(obsidianVault("v", bin).append("notes/fox.md", "x", "Nope")).rejects.toThrow("Heading");
	await obsidianVault("v", fakeCli({ append: "Appended to: notes/fox.md\n" })).append("notes/fox.md", "x");
});

test("text holding a backslash-n or backslash-t is refused before the CLI runs", async () => {
	const bin = fakeCli({ file: missing, create: "Created: notes/fox.md\n", append: "Appended to: notes/fox.md\n" });
	const vault = obsidianVault("v", bin);
	await expect(vault.create("notes/fox.md", "printf('a\\n')")).rejects.toThrow("backslash");
	await expect(vault.append("notes/fox.md", "a\\tb")).rejects.toThrow("backslash");
	await expect(vault.journalAppend("- a\\n")).rejects.toThrow("backslash");
	expect(calls(bin)).toEqual([]);
});

test("a journal append the CLI confirms succeeds, and any other answer is an error", async () => {
	await obsidianVault("v", fakeCli({ "daily:append": "Added to: journals/2026-11-04.md\n" })).journalAppend("- x");
	await expect(
		obsidianVault("v", fakeCli({ "daily:append": "Error: Missing required parameter: content\n" })).journalAppend(
			"- x",
		),
	).rejects.toThrow("Missing required parameter");
});

test("today's journal path is the CLI's, and a non-path answer is an error", async () => {
	expect(await obsidianVault("v", fakeCli({ "daily:path": "journals/2026-11-04.md\n" })).journalPath()).toBe(
		"journals/2026-11-04.md",
	);
	await expect(obsidianVault("v", fakeCli({ "daily:path": "Vault not found." })).journalPath()).rejects.toThrow(
		"Vault not found.",
	);
});
