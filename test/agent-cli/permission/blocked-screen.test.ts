// The *-2.1.302.txt fixtures are pane.read source:detection captures of Claude Code 2.1.302 under herdr 0.9.5,
// taken 2026-10-18 in a throwaway herdr session. The login method screen was reported idle, the others blocked.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { answerKeys, readBlockedScreen } from "../../../src/agent-cli/permission/blocked-screen.ts";
import { parseBlockedPrompt } from "../../../src/agent-cli/permission/prompt-parse.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

describe("readBlockedScreen", () => {
	test("a 2.1.302 Bash prompt is a permission with its command, summary and four numbered options", () => {
		const screen = readBlockedScreen(fixture("claude-bash-prompt-2.1.302.txt"));
		expect(screen.kind).toBe("permission");
		expect(screen.prompt?.toolLabel).toBe("Bash command");
		expect(screen.prompt?.argumentText).toBe("touch canary.txt");
		expect(screen.prompt?.description).toBe("Create empty canary file");
		expect(screen.prompt?.options.map((option) => [option.id, option.keystroke])).toEqual([
			["1", "1"],
			["2", "2"],
			["3", "3"],
			["4", "4"],
		]);
		expect(screen.msg).toContain("touch canary.txt");
		expect(screen.msg).toContain("4. No");
	});

	test("the pre-2.1.302 Bash prompt still parses as before", () => {
		const parsed = parseBlockedPrompt({ text: fixture("blocked-bash-prompt.txt") });
		expect(parsed?.argumentText).toBe("touch /private/tmp/cf-0802-JmBO/probe/cwd/canary2.txt");
		expect(parsed?.description).toBe("Create empty canary2.txt file");
	});

	test("an AskUserQuestion screen is a question", () => {
		const screen = readBlockedScreen(fixture("claude-ask-user-question-2.1.302.txt"));
		expect(screen.kind).toBe("question");
		expect(screen.prompt?.options.map((option) => option.label)).toEqual(["A", "B"]);
	});

	test("the 2.1.302 folder trust dialog is a permission answered by travelling from the cursor", () => {
		const screen = readBlockedScreen(fixture("claude-trust-dialog-2.1.302.txt"));
		expect(screen.kind).toBe("permission");
		const prompt = screen.prompt;
		if (prompt === undefined) throw new Error("trust dialog did not parse");
		expect(prompt.options).toEqual([
			{ id: "1", label: "No, exit" },
			{ id: "2", label: "Yes, I trust this folder" },
		]);
		expect(prompt.selectedIndex).toBe(0);
		expect(answerKeys(prompt, "2")).toEqual(["Down", "Enter"]);
		expect(answerKeys(prompt, "1")).toEqual(["Enter"]);
	});

	test("the older numbered trust dialog is answered by its digit", () => {
		const prompt = readBlockedScreen(fixture("trust-dialog.txt")).prompt;
		if (prompt === undefined) throw new Error("trust dialog did not parse");
		expect(prompt.promptKind).toBe("permission");
		expect(answerKeys(prompt, "1")).toEqual(["1"]);
	});

	test("the custom API key dialog is auth", () => {
		const screen = readBlockedScreen(fixture("claude-custom-api-key-2.1.302.txt"));
		expect(screen.kind).toBe("auth");
		expect(screen.prompt?.options.map((option) => option.label)).toEqual(["Yes", "No (recommended)"]);
	});

	test("an unparsed screen with login wording is auth, and offers nothing to answer", () => {
		const screen = readBlockedScreen(fixture("claude-login-method-2.1.302.txt"));
		expect(screen.kind).toBe("auth");
		expect(screen.prompt).toBeUndefined();
		expect(screen.msg).toContain("Select login method:");
	});

	test("an unparsed screen without such wording stays a permission with no prompt", () => {
		const screen = readBlockedScreen(fixture("claude-idle-composer.txt"));
		expect(screen.kind).toBe("permission");
		expect(screen.prompt).toBeUndefined();
	});

	test("an option the prompt does not offer has no keys", () => {
		const prompt = readBlockedScreen(fixture("claude-bash-prompt-2.1.302.txt")).prompt;
		if (prompt === undefined) throw new Error("bash prompt did not parse");
		expect(answerKeys(prompt, "9")).toBeUndefined();
		expect(answerKeys(prompt, "2")).toEqual(["2"]);
	});
});
