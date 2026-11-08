import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { fixedSmokeRepo } from "../smoke/smoke-repo.ts";

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
