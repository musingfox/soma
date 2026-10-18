import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, expect, test } from "vitest";

const repo = resolve(import.meta.dirname, "..");

// [file, import specifier, must be rejected]
const cases: readonly (readonly [string, string, boolean])[] = [
	["src/core/a.ts", "../adapters/fake-agent/index.ts", true],
	["src/core/extensions/x/a.ts", "../../../adapters/fake-agent/index.ts", true],
	["src/core/b.ts", "@earendil-works/pi-durable", false],
	["src/core/c.ts", "../ports/agent.ts", false],
	["src/core/domain/a.ts", "../../adapters/fake-agent/index.ts", true],
	["src/core/domain/b.ts", "@earendil-works/pi-durable", true],
	["src/core/domain/c.ts", "@earendil-works/chord/context", true],
	["src/core/domain/d.ts", "../extensions/sleeper/index.ts", true],
	["src/core/domain/e.ts", "../../ports/agent.ts", false],
	["src/ports/a.ts", "../core/domain/report.ts", true],
	["src/ports/b.ts", "@earendil-works/pi-ai", true],
	["src/ports/c.ts", "../adapters/fake-agent/index.ts", true],
	["src/adapters/x/a.ts", "@earendil-works/pi-durable", true],
	["src/adapters/x/b.ts", "@earendil-works/pi-durable/storage/sqlite/node", true],
	["src/adapters/x/c.ts", "../../core/harness.ts", true],
	["src/adapters/x/d.ts", "../fake-human/index.ts", true],
	["src/adapters/x/e.ts", "../../ports/agent.ts", false],
	["src/adapters/x/f.ts", "./local.ts", false],
	["src/adapters/terminal/a.ts", "@earendil-works/pi-durable", true],
	["src/adapters/terminal/b.ts", "../herdr/client.ts", true],
];

const root = mkdtempSync(join(tmpdir(), "soma-layering-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("biome rejects exactly the cross-layer imports", () => {
	copyFileSync(join(repo, "biome.json"), join(root, "biome.json"));
	for (const [file, specifier] of cases) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), `import { x } from "${specifier}";\n\nexport const y = x;\n`);
	}
	const run = spawnSync(
		join(repo, "node_modules/.bin/biome"),
		["lint", "--vcs-enabled=false", "--reporter=json", "."],
		{
			cwd: root,
			encoding: "utf8",
		},
	);
	const report = JSON.parse(run.stdout) as { diagnostics: { category: string; location: { path: string } }[] };
	const rejected = report.diagnostics
		.filter((d) => d.category === "lint/style/noRestrictedImports")
		.map((d) => d.location.path)
		.sort();
	expect(rejected).toEqual(
		cases
			.filter(([, , bad]) => bad)
			.map(([file]) => file)
			.sort(),
	);
});

test("no source file calls Bun", () => {
	const run = spawnSync("git", ["grep", "-n", "--untracked", "Bun\\.", "--", "src"], { cwd: repo, encoding: "utf8" });
	// git grep exits 1 when nothing matches.
	expect(run.stdout).toBe("");
	expect(run.status).toBe(1);
});

test("biome rejects process.env in adapters only", () => {
	const dir = mkdtempSync(join(root, "env-"));
	copyFileSync(join(repo, "biome.json"), join(dir, "biome.json"));
	for (const file of ["src/adapters/x/a.ts", "src/main.ts"]) {
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		writeFileSync(join(dir, file), "export const y = process.env.SOMA_X;\n");
	}
	const run = spawnSync(
		join(repo, "node_modules/.bin/biome"),
		["lint", "--vcs-enabled=false", "--reporter=json", "."],
		{
			cwd: dir,
			encoding: "utf8",
		},
	);
	const report = JSON.parse(run.stdout) as { diagnostics: { category: string; location: { path: string } }[] };
	const rejected = report.diagnostics
		.filter((d) => d.category === "lint/style/noProcessEnv")
		.map((d) => d.location.path);
	expect(rejected).toEqual(["src/adapters/x/a.ts"]);
});
