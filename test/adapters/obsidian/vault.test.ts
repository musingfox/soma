import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { obsidianVault } from "../../../src/adapters/obsidian/vault.ts";

const dir = mkdtempSync(join(tmpdir(), "soma-obsidian-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in for the obsidian CLI that answers each command with a canned stdout and exits 0, as the real one does. */
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
	writeFileSync(bin, `#!/bin/sh\ncase "$2" in\n${cases}\nesac\n`);
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
