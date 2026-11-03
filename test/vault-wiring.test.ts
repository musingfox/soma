import { expect, test } from "vitest";
import type { VaultAccess } from "../src/core/extensions/vault/index.ts";
import { vaultExtensions } from "../src/vault.ts";

const unused: VaultAccess = {
	search: async () => [],
	read: async () => "",
	create: async () => {},
	append: async () => {},
	journalAppend: async () => {},
	journalPath: async () => "journals/2026-11-04.md",
};

test("with no vault in the config, no vault tools are installed and no vault is opened", () => {
	const opened: string[] = [];
	expect(
		vaultExtensions(undefined, (name) => {
			opened.push(name);
			return unused;
		}),
	).toEqual([]);
	expect(opened).toEqual([]);
});

test("a vault in the config installs the note tools on the vault it names", () => {
	const opened: string[] = [];
	const extensions = vaultExtensions({ name: "obsidian", deny: ["Clippings"] }, (name) => {
		opened.push(name);
		return unused;
	});
	expect(extensions.flatMap((each) => (each.tools ?? []).map((tool) => tool.name))).toEqual([
		"note_search",
		"note_read",
		"note_create",
		"note_append",
		"journal_append",
	]);
	expect(opened).toEqual(["obsidian"]);
});
