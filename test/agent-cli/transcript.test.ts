import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readFinalAnswer, resolveTranscriptPath } from "../../src/agent-cli/transcript.ts";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function projects() {
	const directory = await mkdtemp(join(tmpdir(), "soma-transcript-"));
	directories.push(directory);
	return directory;
}

const SESSION = "0b6f6c1e-8a1c-4d5e-9f00-1234567890ab";

test("the session's file is found under the encoded cwd", async () => {
	const dir = await projects();
	const path = join(dir, "-Users-me--herdr-worktrees-soma-fleet-x", `${SESSION}.jsonl`);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, "");
	expect(await resolveTranscriptPath(SESSION, "/Users/me/.herdr/worktrees/soma/fleet-x", dir)).toBe(path);
});

test("a cwd the encoding misses falls back to scanning every project directory", async () => {
	const dir = await projects();
	const path = join(dir, "-somewhere-else", `${SESSION}.jsonl`);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, "");
	expect(await resolveTranscriptPath(SESSION, "/Users/me/工作", dir)).toBe(path);
	expect(await resolveTranscriptPath(SESSION, undefined, dir)).toBe(path);
});

test("a session with no file anywhere, or no projects directory, has no path", async () => {
	const dir = await projects();
	await mkdir(join(dir, "-a"));
	expect(await resolveTranscriptPath(SESSION, "/a", dir)).toBeUndefined();
	expect(await resolveTranscriptPath(SESSION, "/a", join(dir, "missing"))).toBeUndefined();
});

const line = (record: object) => `${JSON.stringify(record)}\n`;
const user = (text: string) => line({ type: "user", uuid: `u-${text}`, message: { role: "user", content: text } });
const assistant = (id: string, block: object, extra: object = {}) =>
	line({
		type: "assistant",
		uuid: `a-${id}-${Math.random()}`,
		message: { id, role: "assistant", content: [block] },
		...extra,
	});
const text = (value: string) => ({ type: "text", text: value });

async function transcript(content: string) {
	const path = join(await projects(), `${SESSION}.jsonl`);
	await writeFile(path, content);
	return path;
}

test("the final answer is every text block of the last assistant message, which spans several records", async () => {
	const path = await transcript(
		user("開始") +
			assistant("msg_1", text("先看檔案。")) +
			assistant("msg_1", { type: "tool_use", id: "t1", name: "Read", input: {} }) +
			line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] } }) +
			assistant("msg_2", { type: "thinking", thinking: "…" }) +
			assistant("msg_2", text("結果：完成")) +
			assistant("msg_2", text("三個驗收項目都通過。")) +
			line({ type: "system", subtype: "turn_duration" }) +
			line({ type: "last-prompt" }),
	);
	expect(await readFinalAnswer(path)).toBe("結果：完成\n三個驗收項目都通過。");
});

test("sub-agent, injected and compaction records are not the agent's answer", async () => {
	const path = await transcript(
		assistant("msg_1", text("結果：需要你")) +
			assistant("msg_side", text("sub-agent 的話"), { isSidechain: true }) +
			assistant("msg_meta", text("injected"), { isMeta: true }) +
			assistant("msg_sum", text("summary"), { isCompactSummary: true }),
	);
	expect(await readFinalAnswer(path)).toBe("結果：需要你");
});

test("a half-written last line is skipped", async () => {
	const path = await transcript(
		`${assistant("msg_1", text("結果：失敗"))}{"type":"assistant","message":{"id":"msg_2",`,
	);
	expect(await readFinalAnswer(path)).toBe("結果：失敗");
});

test("a message larger than the first window is read whole by growing the window", async () => {
	const long = "長".repeat(500);
	const path = await transcript(
		user("開始") +
			assistant("msg_0", text("earlier")) +
			assistant("msg_1", text("結果：完成")) +
			assistant("msg_1", text(long)) +
			assistant("msg_1", text("end")),
	);
	expect(await readFinalAnswer(path, 64)).toBe(`結果：完成\n${long}\nend`);
});

test("a transcript with no assistant message, or whose last one has no text, has no answer", async () => {
	expect(await readFinalAnswer(await transcript(user("開始")))).toBeUndefined();
	expect(await readFinalAnswer(await transcript(""))).toBeUndefined();
	const toolOnly = await transcript(
		assistant("msg_1", text("earlier")) + assistant("msg_2", { type: "tool_use", id: "t", name: "Bash", input: {} }),
	);
	expect(await readFinalAnswer(toolOnly)).toBeUndefined();
});
