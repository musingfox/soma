import { expect, test } from "vitest";
import { HUMAN_CHOSEN } from "../src/core/domain/dispatch.ts";
import { digestPrompt, outcomeOf, resultNotice, TOUCHED_MS, urgent } from "../src/core/domain/report.ts";

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

const NOW = Date.parse("2026-10-23T01:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test.each(["需要你", "失敗"] as const)("%s is told at once, touched or not", (outcome) => {
	expect(urgent(outcome, [], NOW)).toBe(true);
});

test("完成 and 未知 wait for the report when nobody touched the job", () => {
	expect(urgent("完成", [], NOW)).toBe(false);
	expect(urgent("未知", [], NOW)).toBe(false);
});

test.each([
	["an option the human pressed", { action: "answered", reason: HUMAN_CHOSEN }],
	["a reply the human sent", { action: "replied", reason: "人回答了" }],
] as const)("完成 is told at once after %s within the window", (_label, decision) => {
	const touched = { kind: "question", ...decision } as const;
	expect(urgent("完成", [{ ...touched, at: ago(TOUCHED_MS) }], NOW)).toBe(true);
	expect(urgent("完成", [{ ...touched, at: ago(TOUCHED_MS + 1) }], NOW)).toBe(false);
});

test("an option the model chose does not count as the human touching the job", () => {
	const decision = { at: ago(1_000), kind: "permission", action: "answered", reason: "只讀" } as const;
	expect(urgent("完成", [decision], NOW)).toBe(false);
});

test("the notice carries the worker's reply, clipped like the report's", () => {
	const notice = resultNotice({ card: "c", agent: "c" }, `結果：需要你\n${"x".repeat(700)}`);
	expect(notice).toMatch(/^agent c（卡片 c）這一輪結束了：\n結果：需要你\nx+…$/);
	expect(notice.length).toBeLessThan(700);
});
