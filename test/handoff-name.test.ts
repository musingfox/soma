import { expect, test } from "vitest";
import { handoffName, handoffRefusal, promptOf } from "../src/core/domain/defer.ts";

const SESSION = "7E33597b-e33d-4c6d-a700-e21b2f54223e";
const free = () => false;

test("a hand-off's job is named soma-<repo>-<first 4 hex digits>, the repo put in lower case and dashes", () => {
	expect(handoffName("/Users/me/workspace/soma", SESSION, free)).toBe("soma-soma-7e33");
	expect(handoffName("/Users/me/My Repo_v2.0/", SESSION, free)).toBe("soma-my-repo-v2-0-7e33");
	expect(handoffName("/tmp/--Ünï--", SESSION, free)).toBe("soma-n-7e33");
	expect(handoffName("/tmp/日本", SESSION, free)).toBe("soma-session-7e33");
	expect(handoffName("/", SESSION, free)).toBe("soma-session-7e33");
});

test("a name another session holds takes one more digit of the session id at a time", () => {
	const held = new Set(["soma-soma-7e33", "soma-soma-7e335"]);
	expect(handoffName("/w/soma", SESSION, (name) => held.has(name))).toBe("soma-soma-7e3359");
});

test("a hand-off's session must be a UUID and its directory absolute", () => {
	expect(handoffRefusal(SESSION, "/w/soma")).toBeUndefined();
	expect(handoffRefusal("card-a", "/w/soma")).toMatch(/is not a UUID/);
	expect(handoffRefusal(SESSION, "w/soma")).toMatch(/is not an absolute path/);
});

test("a hand-off's prompt is the launch rules, a blank line, then the deferred instruction", () => {
	const item = { agent: "a", card: "a", instruction: "run the tests", at: 0, setAt: 0 };
	const sentence =
		"[soma deferred instruction 7] You asked soma with `soma defer` at 1970-01-01T00:00:00.000Z to send you this instruction now: run the tests";

	expect(promptOf("7", item)).toBe(sentence);
	const text = promptOf("7", { ...item, session: SESSION, cwd: "/w" });
	expect(text).toMatch(/^你正在被無人值守地派工/);
	expect(text).toContain("結果：失敗\n\n[soma deferred instruction 7]");
	expect(text.endsWith(sentence)).toBe(true);
});
