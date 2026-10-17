import { expect, test } from "vitest";
import { outcomeOf } from "../src/core/domain/report.ts";

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
