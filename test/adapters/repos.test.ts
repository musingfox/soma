import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { repoUnder } from "../../src/adapters/repos/folder.ts";

// The temporary directory may itself be behind a link, as /var is on macOS, so expected paths are real ones.
const dir = realpathSync(mkdtempSync(join(tmpdir(), "soma-repos-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const folder = join(dir, "workspace");
mkdirSync(join(folder, "soma", ".git"), { recursive: true });
// A linked worktree or a submodule has a .git file, not a directory.
mkdirSync(join(folder, "linked"));
writeFileSync(join(folder, "linked", ".git"), "gitdir: /elsewhere/.git/worktrees/linked\n");
mkdirSync(join(folder, "plain"));
mkdirSync(join(folder, "soma", "nested", ".git"), { recursive: true });
mkdirSync(join(dir, "outside", ".git"), { recursive: true });
symlinkSync(join(dir, "outside"), join(folder, "out-link"));
symlinkSync(join(folder, "soma"), join(dir, "in-link"));
writeFileSync(join(folder, "file"), "");

const check = repoUnder(folder);

test("a git repo directly under the folder is taken, at its real path", async () => {
	expect(await check(join(folder, "soma"))).toEqual({ repo: join(folder, "soma") });
	expect(await check(join(folder, "linked"))).toEqual({ repo: join(folder, "linked") });
	expect(await check(join(folder, "soma", "..", "soma"))).toEqual({ repo: join(folder, "soma") });
	// A link elsewhere that resolves to a repo under the folder is that repo.
	expect(await check(join(dir, "in-link"))).toEqual({ repo: join(folder, "soma") });
});

test("a link under the folder that resolves outside it is refused", async () => {
	expect(await check(join(folder, "out-link"))).toEqual({
		refused: `${join(folder, "out-link")} resolves to ${join(dir, "outside")}, which is not directly under ${folder}`,
	});
});

test("anything that is not a git repo directly under the folder is refused", async () => {
	expect(await check(join(dir, "outside"))).toEqual({
		refused: `${join(dir, "outside")} is not directly under ${folder}`,
	});
	expect(await check(join(folder, "soma", "nested"))).toEqual({
		refused: `${join(folder, "soma", "nested")} is not directly under ${folder}`,
	});
	expect(await check(folder)).toEqual({ refused: `${folder} is not directly under ${folder}` });
	expect(await check(join(folder, "plain"))).toEqual({
		refused: `${join(folder, "plain")} is not a git repository: it has no .git`,
	});
	expect(await check(join(folder, "file"))).toEqual({ refused: `${join(folder, "file")} is not a directory` });
	expect(await check(join(folder, "absent"))).toEqual({
		refused: `${join(folder, "absent")} does not exist`,
	});
	expect(await check("soma")).toEqual({ refused: `the repo must be an absolute path, got "soma"` });
});

test("with no folder configured, or one that does not exist, every repo is refused", async () => {
	expect(await repoUnder(undefined)(join(folder, "soma"))).toEqual({
		refused: "soma's config names no reposDir, so soma dispatch starts no job",
	});
	expect(await repoUnder(join(dir, "gone"))(join(dir, "gone", "soma"))).toEqual({
		refused: `reposDir ${join(dir, "gone")} cannot be resolved: it does not exist`,
	});
});
