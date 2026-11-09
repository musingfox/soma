import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { branchWithSettings, fixedSmokeRepo } from "../smoke/smoke-repo.ts";
import { openWorktree, runGit } from "../src/agent-cli/worktree.ts";

let home: string;
let repo: string;

beforeEach(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "soma-smoke-repo-")));
	repo = join(home, ".cache", "soma-smoke", "repo");
});

afterEach(() => rm(home, { recursive: true, force: true }));

const makeRepo = () => mkdir(join(repo, ".git"), { recursive: true });
const writeProjects = (projects: object) => writeFile(join(home, ".claude.json"), JSON.stringify({ projects }));

test("a trusted repo is the smoke's default", async () => {
	await makeRepo();
	await writeProjects({ [repo]: { hasTrustDialogAccepted: true } });
	await expect(fixedSmokeRepo(home)).resolves.toBe(repo);
});

test("a missing repo fails with the setup steps", async () => {
	await writeProjects({ [repo]: { hasTrustDialogAccepted: true } });
	await expect(fixedSmokeRepo(home)).rejects.toThrow(/is missing[\s\S]*git init[\s\S]*Yes, I trust this folder/);
});

test("the setup steps' last command can be pasted as it is printed", async () => {
	await expect(fixedSmokeRepo(home)).rejects.toThrow(/^ {2}cd \S+ && claude$/m);
});

test("the trust is looked up by the repo's real path, as claude keys it", async () => {
	const real = join(home, "real-cache");
	await mkdir(join(real, "soma-smoke", "repo", ".git"), { recursive: true });
	await symlink(real, join(home, ".cache"));
	await writeProjects({ [repo]: { hasTrustDialogAccepted: true } });
	await expect(fixedSmokeRepo(home)).rejects.toThrow(/does not trust/);
	await writeProjects({ [join(real, "soma-smoke", "repo")]: { hasTrustDialogAccepted: true } });
	await expect(fixedSmokeRepo(home)).resolves.toBe(repo);
});

test("a repo with no entry fails with the setup steps", async () => {
	await makeRepo();
	await writeProjects({ "/some/other/repo": { hasTrustDialogAccepted: true } });
	await expect(fixedSmokeRepo(home)).rejects.toThrow(/does not trust[\s\S]*git init[\s\S]*Yes, I trust this folder/);
});

test("a repo whose entry says false is untrusted", async () => {
	await makeRepo();
	await writeProjects({ [repo]: { hasTrustDialogAccepted: false } });
	await expect(fixedSmokeRepo(home)).rejects.toThrow(/does not trust/);
});

test("no ~/.claude.json at all is untrusted", async () => {
	await makeRepo();
	await expect(fixedSmokeRepo(home)).rejects.toThrow(/does not trust/);
});

test("a card's settings reach its worktree alone, and leave the repo's main and checkout as they were", async () => {
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
	await mkdir(repo, { recursive: true });
	git("init", "-q", "-b", "main");
	await writeFile(join(repo, "README.md"), "kept\n");
	git("add", "README.md");
	git(
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@example.com",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-q",
		"--no-verify",
		"-m",
		"chore: init",
	);
	const main = git("rev-parse", "main");

	branchWithSettings(repo, "card-a", { permissions: { defaultMode: "default" } }, home);

	const worktree = await openWorktree(runGit, repo, "card-a");
	const show = (name: string) => execFileSync("git", ["-C", worktree, "show", `HEAD:${name}`], { encoding: "utf8" });
	expect(JSON.parse(show(".claude/settings.json"))).toEqual({ permissions: { defaultMode: "default" } });
	expect(show("README.md")).toBe("kept\n");
	expect(git("rev-parse", "fleet/card-a^")).toBe(main);
	expect(git("rev-parse", "main")).toBe(main);
	expect(git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
	expect(git("diff", "--cached", "--name-only")).toBe("");
	expect(git("ls-files")).toBe("README.md");
});
