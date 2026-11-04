import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
	awaitingReply,
	readFinalAnswer,
	readLastRecord,
	readSessionCwd,
	resolveTranscriptPath,
} from "../../src/agent-cli/transcript.ts";

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

test("an assistant message without an id still has an answer", async () => {
	const idless = await transcript(line({ type: "assistant", message: { role: "assistant", content: [text("x")] } }));
	expect(await readFinalAnswer(idless)).toBe("x");
});

const toolResult = (uuid: string) =>
	line({ type: "user", uuid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t" }] } });

test("a transcript that ends on the assistant names the last record, with the whole message's text", async () => {
	const path = await transcript(
		user("開始") +
			assistant("msg_1", text("earlier")) +
			assistant("msg_2", { type: "thinking", thinking: "…" }) +
			assistant("msg_2", text("結果：完成")) +
			assistant("msg_2", text("done"), { uuid: "a-last" }),
	);
	expect(await readLastRecord(path)).toEqual({ id: "a-last", text: "結果：完成\ndone" });
	expect(await readLastRecord(path, 64)).toEqual({ id: "a-last", text: "結果：完成\ndone" });
});

test("a transcript that ends on the user, as an interrupted turn does, names the user's record and has no text", async () => {
	const path = await transcript(
		user("一") +
			assistant("msg_1", text("結果：需要你")) +
			user("二") +
			line({
				type: "user",
				uuid: "u-stop",
				message: { role: "user", content: [text("[Request interrupted by user]")] },
			}),
	);
	expect(await readLastRecord(path)).toEqual({ id: "u-stop" });
	expect(await readLastRecord(await transcript(user("開始")))).toEqual({ id: "u-開始" });
});

test("a transcript that ends on a tool result, as a denied permission does, names it and has no text", async () => {
	const path = await transcript(
		user("開始") +
			assistant("msg_1", text("結果：完成")) +
			assistant("msg_2", { type: "tool_use", id: "t", name: "Bash", input: {} }) +
			toolResult("u-denied"),
	);
	expect(await readLastRecord(path)).toEqual({ id: "u-denied" });
});

test("records claude writes around a turn, and records that are not the conversation, name no turn", async () => {
	const path = await transcript(
		user("開始") +
			assistant("msg_1", text("結果：完成"), { uuid: "a-reply" }) +
			assistant("msg_side", text("sub-agent"), { isSidechain: true }) +
			line({ type: "user", uuid: "u-meta", isMeta: true, message: { role: "user", content: "caveat" } }) +
			line({ type: "system", uuid: "s-1", subtype: "turn_duration" }) +
			line({ type: "system", uuid: "s-2", subtype: "stop_hook_summary" }) +
			line({ type: "attachment", uuid: "at-1", attachment: { type: "date" } }) +
			line({ type: "last-prompt" }),
	);
	expect(await readLastRecord(path)).toEqual({ id: "a-reply", text: "結果：完成" });
});

test("a last message without text names its record without text; no record with an id names nothing", async () => {
	const toolUse = await transcript(
		assistant("msg_1", text("earlier")) +
			assistant("msg_2", { type: "tool_use", id: "t", name: "Bash", input: {} }, { uuid: "a-tool" }),
	);
	expect(await readLastRecord(toolUse)).toEqual({ id: "a-tool" });
	expect(await readFinalAnswer(toolUse)).toBeUndefined();
	const idless = await transcript(line({ type: "assistant", message: { role: "assistant", content: [text("x")] } }));
	expect(await readLastRecord(idless)).toBeUndefined();
	expect(await readLastRecord(await transcript(""))).toBeUndefined();
	expect(await readLastRecord(await transcript(line({ type: "system", uuid: "s-1" })))).toBeUndefined();
});

test("a reply is awaited while the assistant's last record holds only thinking", async () => {
	const thinking = assistant("msg_2", { type: "thinking", thinking: "…" });
	expect(await awaitingReply(await transcript(user("一") + thinking))).toBe(true);
	expect(await awaitingReply(await transcript(user("一") + thinking + assistant("msg_2", text("結果：完成"))))).toBe(
		false,
	);
});

test("a reply is awaited while the conversation's last record is the user's, or there is none", async () => {
	const meta = line({ type: "user", isMeta: true, message: { role: "user", content: "caveat" } });
	const system = line({ type: "system", content: "turn duration" });
	expect(await awaitingReply(await transcript(user("開始")))).toBe(true);
	expect(await awaitingReply(await transcript(user("一") + assistant("msg_1", text("ok")) + user("二") + system))).toBe(
		true,
	);
	expect(await awaitingReply(await transcript(user("開始") + assistant("msg_1", text("ok")) + system + meta))).toBe(
		false,
	);
	expect(await awaitingReply(await transcript(""))).toBe(true);
	expect(await awaitingReply(await transcript(line({ type: "mode", mode: "default" })))).toBe(true);
	// An attachment larger than the first window, written after the reply.
	const attachment = line({ type: "attachment", attachment: { content: "x".repeat(200) } });
	expect(await awaitingReply(await transcript(user("一") + assistant("msg_1", text("ok")) + attachment), 64)).toBe(
		false,
	);
});

test("the directory a session ran in is the first absolute cwd on its records, read past a first record the window cuts", async () => {
	const owner = line({ type: "session-owner", sessionId: SESSION, note: "x".repeat(200) });
	const at = (cwd: unknown) => line({ type: "user", uuid: "u-1", cwd, message: { role: "user", content: "go" } });
	expect(await readSessionCwd(await transcript(owner + at("/wt/card-a") + at("/wt/elsewhere")), 64)).toBe("/wt/card-a");
	expect(await readSessionCwd(await transcript(at("") + at("relative") + at(7) + at("/wt/card-a")))).toBe("/wt/card-a");
	expect(await readSessionCwd(await transcript(owner + user("go")), 64)).toBeUndefined();
	expect(await readSessionCwd(await transcript(""))).toBeUndefined();
});
