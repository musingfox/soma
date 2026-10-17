import { expect, test } from "vitest";
import { FakeAgentPort } from "../src/adapters/fake-agent/index.ts";
import { FakeHumanPort } from "../src/adapters/fake-human/index.ts";
import type { AgentStatusEvent, BlockedKind } from "../src/ports/agent.ts";
import type { SomaEvent } from "../src/ports/human.ts";

test("fake AgentPort delivers blocked and done to subscribers", async () => {
	const agents = new FakeAgentPort();
	const seen: AgentStatusEvent[] = [];
	const unsubscribe = agents.onStatus((event) => seen.push(event));

	await agents.start({ name: "job-a", card: "pm/a.md", cwd: "/tmp", sessionId: "s-a" });
	await agents.prompt("job-a", "go");
	for (const kind of ["permission", "question", "auth"] satisfies BlockedKind[]) {
		agents.emit("job-a", { state: "blocked", kind });
		await agents.respond("job-a", `answer ${kind}`);
	}
	agents.finish("job-a", "結果：完成");

	expect(await agents.list()).toEqual([{ name: "job-a", status: { state: "done" } }]);
	expect(seen.map((e) => e.status)).toEqual([
		{ state: "idle" },
		{ state: "working" },
		{ state: "blocked", kind: "permission" },
		{ state: "working" },
		{ state: "blocked", kind: "question" },
		{ state: "working" },
		{ state: "blocked", kind: "auth" },
		{ state: "working" },
		{ state: "done" },
	]);
	expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
	expect(await agents.readResult("job-a")).toBe("結果：完成");

	unsubscribe();
	agents.emit("job-a", { state: "idle" });
	expect(seen).toHaveLength(9);
});

test("fake HumanPort delivers notices to subscribers", async () => {
	const human = new FakeHumanPort();
	const seen: SomaEvent[] = [];
	human.subscribe((event) => seen.push(event));

	await human.notify("job-a is blocked on auth", "question");

	expect(seen).toEqual([{ type: "notice", kind: "question", content: "job-a is blocked on auth" }]);
});

test("fake HumanPort processes a requestId once", async () => {
	const human = new FakeHumanPort();
	const input = { content: "hi", entry: { kind: "chat.telegram" }, requestId: "telegram:1" };

	await human.submit(input);
	await human.submit(input);

	expect(human.inputs).toEqual([input]);
});
