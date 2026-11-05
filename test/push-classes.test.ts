import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const repo = resolve(import.meta.dirname, "..");

// noticeEntry takes the class as a required argument, so tsc refuses a site that leaves it out; this catches a
// notice written around it. The escalation in human-port re-appends the data noticeEntry made.
test("every notice in src is written through noticeEntry, which requires a class", () => {
	const run = spawnSync("git", ["grep", "-n", "--untracked", "-E", 'kind: (NOTICE|"notice")', "--", "src"], {
		cwd: repo,
		encoding: "utf8",
	});
	const files = run.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split(":")[0]);
	expect([...new Set(files)].sort()).toEqual(["src/core/human-port.ts", "src/core/notice.ts"]);
});
