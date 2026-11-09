import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// A worktree copy under .claude/worktrees/ holds its own test files; a stale one would fail an unrelated commit.
		// Setting exclude replaces vitest's defaults, so they are spread back in.
		exclude: [...configDefaults.exclude, "**/.claude/worktrees/**"],
	},
});
