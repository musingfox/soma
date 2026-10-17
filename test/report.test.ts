import { expect, test } from "vitest";
import { digestPrompt, outcomeOf } from "../src/core/domain/report.ts";

test.each([
	["結果：完成\n\n三個驗收項目都通過。", "完成"],
	["結果：需要你\n要用哪個 MCP server？", "需要你"],
	["結果：失敗\nnpm test 有兩個失敗。", "失敗"],
] as const)("the result line classifies %j", (reply, outcome) => {
	expect(outcomeOf(reply)).toBe(outcome);
});

test.each([
	["ok", "a reply with no result line"],
	["做完了。\n結果：完成", "a result line that is not the first line"],
	["結果：大概完成", "a result line outside the three"],
	["", "an empty reply"],
])("%j is unknown, not failure (%s)", (reply) => {
	expect(outcomeOf(reply)).toBe("未知");
});

test("no reply at all is unknown, not failure", () => {
	expect(outcomeOf(undefined)).toBe("未知");
});

test("blank lines and surrounding spaces before the result line are tolerated", () => {
	expect(outcomeOf("\n  結果：完成  \r\n細節")).toBe("完成");
});

test("the digest prompt names its source and lists every job, unknown outcomes and judgments included", () => {
	const prompt = digestPrompt({
		since: "2026-10-18T00:00:00.000Z",
		until: "2026-10-18T00:10:00.000Z",
		jobs: [
			{ card: "a", agent: "a", outcome: "完成", result: "結果：完成\n三項都過。", decisions: [] },
			{
				card: "b",
				agent: "b",
				outcome: "未知",
				result: "x".repeat(700),
				decisions: [{ at: "2026-10-18T00:05:00.000Z", kind: "permission", action: "answered", reason: "只讀" }],
			},
		],
	});
	expect(prompt.startsWith("[digest 2026-10-18T00:00:00.000Z ~ 2026-10-18T00:10:00.000Z]")).toBe(true);
	expect(prompt).toContain("- 卡片 a（agent a）結果：完成\n  回覆：結果：完成\n三項都過。");
	expect(prompt).toContain(
		`- 卡片 b（agent b）結果：未知\n  回覆：${"x".repeat(600)}…\n  判斷（permission，answered）：只讀`,
	);
});
