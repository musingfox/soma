import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { type Extension, type Harness, InboxDoc, type TaskId } from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { run } from "../smoke/driver.ts";
import { askExtension } from "../src/core/extensions/ask/index.ts";
import { inspectExtension } from "../src/core/extensions/inspect/index.ts";
import { interfaces } from "../src/core/extensions/interfaces/index.ts";
import { memory } from "../src/core/extensions/memory/index.ts";
import { schedule } from "../src/core/extensions/schedule/index.ts";
import { RESULT, recurring } from "../src/core/extensions/schedule/recurring.ts";
import { tools } from "../src/core/extensions/tools/index.ts";
import { openHarness, openStorage } from "../src/core/harness.ts";
import { type Core, context, openCore, textOf } from "./recurring-core.ts";
import { steppedModel } from "./stepped-model.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const each of cleanup.splice(0).reverse()) await each();
	vi.restoreAllMocks();
});

async function directory() {
	const path = await mkdtemp(join(tmpdir(), "soma-recurring-"));
	cleanup.push(() => rm(path, { recursive: true, force: true }));
	return path;
}

async function core(options: Omit<Parameters<typeof openCore>[0], "db"> = {}): Promise<Core> {
	const soma = await openCore({ db: join(await directory(), "soma.sqlite"), ...options });
	cleanup.push(() => soma.close());
	return soma;
}

const CHILD = fileURLToPath(new URL("./recurring-child.ts", import.meta.url));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CRON = "*/2 * * * *";
const every = (ms: number) => (_cron: string, after: number) => after + ms;
const idOf = (result: string) => /Scheduled (\d+): /.exec(result)?.[1] ?? "";

test("a rule the model creates fires in a new conversation each time, told as an outcome, and wakes no root round", {
	timeout: 15_000,
}, async () => {
	const fired = vi.spyOn(console, "error");
	const soma = await core({ nextFire: every(300) });
	const result = await soma.say(`每 ${CRON} 做 說現在幾點`);
	const id = idOf(result);
	expect(result).toMatch(
		new RegExp(`^好。Scheduled ${id}: \\*/2 \\* \\* \\* \\*, next \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z\\.$`),
	);
	const rootCalls = soma.requests.filter((request) => !request.fire).length;

	await vi.waitFor(() => expect(soma.notices().length).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
	const [first, second] = soma.notices();
	expect(first).toEqual({ class: "outcome", content: `[schedule ${id} · ${CRON}]\nfire 1: 說現在幾點` });
	expect(second).toEqual({ class: "outcome", content: `[schedule ${id} · ${CRON}]\nfire 2: 說現在幾點` });

	const owned = await soma.owned(Number(id) as TaskId);
	expect(owned.length).toBeGreaterThanOrEqual(2);
	const [one, two] = owned;
	expect(one?.id).not.toBe(two?.id);
	for (const conversation of [one, two]) {
		const [input] = (await soma.submissions(conversation?.id ?? (0 as never))).filter((s) => s.type === "input");
		expect(input?.requestId).toMatch(new RegExp(`^recurring:${id}:\\d+$`));
		const fireLine = `[soma] schedule ${id} (${CRON}) fired in conversation ${conversation?.id}`;
		expect(fired.mock.calls.map((call) => call.join(" "))).toContain(fireLine);
	}
	// The fire's request carries the input alone: no tool, no section, nothing of the root's transcript.
	const fire = soma.requests.find((request) => request.fire);
	const system = (request: typeof fire) =>
		JSON.stringify(request?.context.messages.filter((message) => message.role === "system") ?? []);
	expect(system(soma.requests.find((request) => !request.fire))).toContain('"name":"schedule_recurring"');
	expect(system(fire)).not.toMatch(/"toolsAdded"|"sections"/);
	expect(fire?.context.messages.filter((message) => message.role !== "system")).toHaveLength(1);
	expect(textOf(fire?.context.messages.at(-1)?.content)).toMatch(
		new RegExp(
			`^Scheduled run of rule ${id} \\(\\*/2 \\* \\* \\* \\*\\) for \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\\.\\n` +
				"Nobody is in this conversation: your final answer is sent to the human as a notice, and an answer of exactly NO_REPLY sends nothing.\\n\\n說現在幾點$",
		),
	);

	const inputs = (await soma.submissions(soma.root.id)).filter((submission) => submission.type === "input");
	expect(inputs.map((submission) => submission.requestId)).toEqual(["terminal:1"]);
	expect(soma.requests.filter((request) => !request.fire)).toHaveLength(rootCalls);
	expect(rootCalls).toBe(2);
});

test("a fire's result is in the root's context, quoted, at the human's next request, which is the only one", {
	timeout: 15_000,
}, async () => {
	let slots = 0;
	// One fire, then none for an hour.
	const soma = await core({ nextFire: (_cron, after) => after + (++slots === 1 ? 300 : 3_600_000) });
	const id = idOf(await soma.say(`每 ${CRON} 做 說一行字\n第二行`));
	await vi.waitFor(() => expect(soma.notices()).toHaveLength(1), { timeout: 5_000 });
	await vi.waitFor(async () => expect(await soma.results()).toHaveLength(1));
	const before = soma.requests.filter((request) => !request.fire).length;
	await delay(300);
	expect(soma.requests.filter((request) => !request.fire)).toHaveLength(before);

	expect(await soma.say("剛剛排程說了什麼")).toBe("好。");
	const after = soma.requests.filter((request) => !request.fire);
	expect(after).toHaveLength(before + 1);
	const messages = after.at(-1)?.context.messages.filter((message) => message.role === "user") ?? [];
	const said = messages.map((message) => textOf(message.content));
	const result = said.findIndex((text) => text.startsWith("This message is not from the human"));
	expect(result).toBeGreaterThan(-1);
	expect(result).toBeLessThan(said.indexOf("剛剛排程說了什麼"));
	expect(said[result]).toContain(`Rule ${id} (${CRON})`);
	expect(said[result]).toContain(`> [schedule ${id} · ${CRON}]\n> fire 1: 說一行字\n> 第二行`);
	const [entry] = await soma.results();
	expect(entry?.data).toEqual({ rule: Number(id), slot: expect.any(Number) });
});

test("schedule_list shows a rule's next slot beside a one-shot, and schedule_cancel ends the rule alone", {
	timeout: 20_000,
}, async () => {
	const soma = await core({ nextFire: every(400) });
	const id = idOf(await soma.say(`每 ${CRON} 做 報時`));
	await vi.waitFor(() => expect(soma.notices()).toHaveLength(1), { timeout: 5_000 });
	await soma.say("提醒我 喝水");
	const listed = await soma.say("列出排程");
	const [, next = ""] =
		new RegExp(`^好。\\d+: \\S+ 喝水\n${id}: \\*/2 \\* \\* \\* \\* next (\\S+) 報時$`).exec(listed) ?? [];
	// The rule's slot then, which moves on with every fire.
	expect(Math.abs(Date.parse(next) - Date.now())).toBeLessThan(2_000);

	expect(await soma.say(`取消排程 ${id}`)).toBe(`好。Cancelled ${id}.`);
	const told = soma.notices().length;
	expect(await soma.rules()).toEqual({});
	const task = await soma.harness.getTask(Number(id) as TaskId, context);
	expect(task?.state).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
	// The one-shot is due two seconds after it was set, well past several of the rule's slots.
	await vi.waitFor(
		async () => expect((await soma.entries()).filter((entry) => entry.kind === "schedule")).toHaveLength(1),
		{ timeout: 5_000 },
	);
	await soma.root.waitForIdle(context);
	await delay(800);
	expect(soma.notices()).toHaveLength(told);
	expect(await soma.say("列出排程")).toBe("好。Nothing scheduled.");
});

test("a fire whose model call fails is told as unfinished, with the reason, and the rule fires at its next slot", {
	timeout: 15_000,
}, async () => {
	let fires = 0;
	const soma = await core({ nextFire: every(300), failing: () => ++fires === 1 });
	const id = idOf(await soma.say(`每 ${CRON} 做 報時`));
	await vi.waitFor(() => expect(soma.notices().length).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
	const [failed, next] = soma.notices();
	expect(failed?.class).toBe("outcome");
	expect(failed?.content).toMatch(
		new RegExp(
			`^\\[schedule ${id} · \\*/2 \\* \\* \\* \\*\\] did not finish: model_error: .*401 invalid x-api-key.*\\. The instruction was: 報時$`,
		),
	);
	expect(next).toEqual({ class: "outcome", content: `[schedule ${id} · ${CRON}]\nfire 1: 報時` });
	// The failure enters the root's context as the answer does.
	const [result] = await soma.results();
	expect(textOf(result?.model?.[0]?.content)).toContain(`> ${failed?.content}`);
});

test("a fire answered only NO_REPLY, bare or padded, tells nothing on the root or the HumanPort, and the rule fires again", {
	timeout: 15_000,
}, async () => {
	const fired = vi.spyOn(console, "error");
	const silences = ["NO_REPLY", "  NO_REPLY  ", "\nNO_REPLY\n", " \n NO_REPLY \n "];
	const soma = await core({ nextFire: every(300), answer: (_instruction, fire) => silences[fire - 1] });
	const id = idOf(await soma.say(`每 ${CRON} 做 有事才說`));
	const before = (await soma.entries()).length;
	const events = soma.events.length;

	await vi.waitFor(() => expect(soma.notices()).toHaveLength(1), { timeout: 5_000 });
	expect(soma.notices()).toEqual([{ class: "outcome", content: `[schedule ${id} · ${CRON}]\nfire 5: 有事才說` }]);
	// Only the fifth fire's notice and result, and its answer's event, are new.
	const added = (await soma.entries()).slice(before);
	expect(added.map((entry) => entry.kind)).toEqual([RESULT, "notice"]);
	expect(soma.events.slice(events)).toEqual([expect.objectContaining({ type: "notice", class: "outcome" })]);
	const owned = await soma.owned(Number(id) as TaskId);
	expect(owned.length).toBeGreaterThanOrEqual(5);
	const lines = fired.mock.calls.map((call) => call.join(" "));
	for (const conversation of owned.slice(0, 4))
		expect(lines).toContain(`[soma] schedule ${id} (${CRON}) fired in conversation ${conversation.id}, silent`);
	expect(lines).toContain(`[soma] schedule ${id} (${CRON}) fired in conversation ${owned[4]?.id}`);
});

test("an answer with NO_REPLY among other words is told as written", { timeout: 15_000 }, async () => {
	const answers = ["NO_REPLY, except that the disk is 95% full.", "NO_REPLY.", "no_reply"];
	const soma = await core({ nextFire: every(300), answer: (_instruction, fire) => answers[fire - 1] });
	const id = idOf(await soma.say(`每 ${CRON} 做 看磁碟`));
	await vi.waitFor(() => expect(soma.notices().length).toBeGreaterThanOrEqual(3), { timeout: 5_000 });
	expect(soma.notices().slice(0, 3)).toEqual(
		answers.map((answer) => ({ class: "outcome", content: `[schedule ${id} · ${CRON}]\n${answer}` })),
	);
	await vi.waitFor(async () => expect((await soma.results()).length).toBeGreaterThanOrEqual(3));
	expect(textOf((await soma.results())[0]?.model?.[0]?.content)).toContain(`> ${answers[0]}`);
});

test("an empty answer, and a model that wrote NO_REPLY before it failed, are told as unfinished outcomes", {
	timeout: 15_000,
}, async () => {
	const answers = [
		"",
		"  \n ",
		fauxAssistantMessage("NO_REPLY", { stopReason: "error", errorMessage: "401 invalid x-api-key" }),
		"NO_REPLY",
	];
	const soma = await core({ nextFire: every(300), answer: (_instruction, fire) => answers[fire - 1] });
	const id = idOf(await soma.say(`每 ${CRON} 做 報時`));
	await vi.waitFor(() => expect(soma.notices().length).toBeGreaterThanOrEqual(3), { timeout: 5_000 });
	const head = `[schedule ${id} · ${CRON}] did not finish: `;
	const [empty, blank, failed] = soma.notices();
	expect(empty).toEqual({ class: "outcome", content: `${head}the answer had no text. The instruction was: 報時` });
	expect(blank).toEqual(empty);
	expect(failed?.class).toBe("outcome");
	expect(failed?.content).toMatch(
		/^\[schedule \d+ · [^\]]+\] did not finish: .*401 invalid x-api-key.*\. The instruction was: 報時$/,
	);
	await vi.waitFor(async () => expect((await soma.results()).length).toBeGreaterThanOrEqual(3));
	const results = (await soma.results()).slice(0, 3).map((entry) => textOf(entry.model?.[0]?.content));
	for (const [index, notice] of [empty, blank, failed].entries())
		expect(results[index]).toContain(`> ${notice?.content}`);
});

test("a root that ran under the old extension list gets schedule_recurring added alone, and nothing removed", async () => {
	const db = join(await directory(), "soma.sqlite");
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("好。")));
	const models = createModels();
	models.setProvider(faux.provider);
	type System = { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] };
	// The tools' extensions in main.ts's order, the new one right after `ask`.
	const round = async (added: Extension[]) => {
		const storage = await openStorage(db);
		const harness: Harness = await openHarness(
			storage,
			[
				memory,
				schedule((id, c) => harness.abortTask(id, c)),
				inspectExtension(storage),
				askExtension({ storage, interfaces: ["chat.terminal"] }),
				...added,
				interfaces(storage, { texts: { "chat.terminal": "終端機" }, on: () => new Set(["chat.terminal"]) }),
				tools,
			],
			context,
			{ models },
		);
		try {
			const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);
			const { items } = await root.entries({ order: "ascending" }, 1000, undefined, context);
			return items
				.flatMap((entry) => (entry.model ?? []) as readonly System[])
				.filter((message) => message.role === "system");
		} finally {
			await harness.close(context);
		}
	};
	const before = await round([]);
	const names = (tools?: { name: string }[]) => tools?.map((tool) => tool.name);
	expect(names(before.at(-1)?.toolsAdded)).toEqual(expect.arrayContaining(["schedule", "schedule_list", "ask"]));

	const after = await round([recurring()]);
	expect(after).toHaveLength(before.length + 1);
	expect(names(after.at(-1)?.toolsAdded)).toEqual(["schedule_recurring"]);
	expect(after.at(-1)?.toolsRemoved).toBeUndefined();
});

test("a fire that ends during a root round is told at once, and its result joins that round at its next boundary", {
	timeout: 15_000,
}, async () => {
	const stepped = steppedModel();
	let slots = 0;
	const soma = await core({ models: stepped, nextFire: (_cron, after) => after + (++slots === 1 ? 1_000 : 3_600_000) });
	const [set, ok] = [stepped.reply(), stepped.reply()];
	const created = soma.say(`每 ${CRON} 做 報時`);
	await set.end({
		type: "toolCall",
		id: "call-1",
		name: "schedule_recurring",
		arguments: { cron: CRON, instruction: "報時" },
	});
	await ok.write("好。");
	await ok.end();
	await created;

	const held = stepped.reply();
	await soma.human.submit({ content: "慢慢想", entry: { kind: "chat.terminal" }, requestId: "terminal:held" });
	await vi.waitFor(() => expect(held.messages).toBeDefined());
	const fire = stepped.reply();
	await vi.waitFor(() => expect(fire.messages).toBeDefined(), { timeout: 5_000 });
	await fire.write("三點了。");
	await fire.end();
	await vi.waitFor(() => expect(soma.notices()).toHaveLength(1));
	expect(soma.notices()[0]?.content).toMatch(/^\[schedule \d+ · \*\/2 \* \* \* \*\]\n三點了。$/);
	expect(await soma.results()).toEqual([]);
	const inbox = await soma.harness.snapshot(InboxDoc, soma.root.id, context);
	expect(inbox?.items).toEqual([
		expect.objectContaining({ mode: "write", entry: expect.objectContaining({ kind: RESULT }) }),
	]);

	// The round's tool round ends at a boundary, where the result is placed before the round's next request.
	const next = stepped.reply();
	await held.end({ type: "toolCall", id: "call-2", name: "schedule_list", arguments: {} });
	await vi.waitFor(() => expect(next.messages).toBeDefined());
	const users = (next.messages ?? []).filter((message) => message.role === "user").map((m) => textOf(m.content));
	expect(users.at(-1)).toMatch(
		/^This message is not from the human[\s\S]*\n> \[schedule \d+ · \*\/2 \* \* \* \*\]\n> 三點了。$/,
	);
	await next.write("想好了。");
	await next.end();
	await vi.waitFor(() =>
		expect(soma.events).toContainEqual(expect.objectContaining({ type: "answer", requestId: "terminal:held" })),
	);
	await soma.root.waitForIdle(context);
	await delay(200);

	const kinds = (await soma.entries()).map((entry) => entry.kind);
	const result = kinds.indexOf(RESULT);
	expect(kinds.slice(result - 1, result + 2)).toEqual(["pi.tool-result", RESULT, "pi.assistant"]);
	// No round of its own: the root ran one round for each of the human's inputs, and nothing failed.
	const inputs = (await soma.submissions(soma.root.id)).filter((submission) => submission.type === "input");
	expect(inputs.map((input) => input.requestId)).toEqual(["terminal:1", "terminal:held"]);
	expect(kinds.filter((kind) => kind === "pi.assistant")).toHaveLength(4);
	expect(soma.events.filter((event) => event.type === "failure")).toEqual([]);
});

type Done = {
	taskId: number;
	pinned: { next: number; slot?: number; conversationId?: number };
	notices: { content: string; class: string }[];
	fireCalls: number;
	results: { rule: number; slot: number }[];
	owned: { id: number; requests: string[] }[];
};

test("a slot missed while soma was down past lateMs is skipped without a model call, and the next one fires", {
	timeout: 30_000,
}, async () => {
	const db = join(await directory(), "soma.sqlite");
	const [period, late] = [1_500, 200];
	const first = run(["wait", db, String(period), String(late)], CHILD);
	const armed = await first.next("armed");
	first.process.kill("SIGKILL");
	await first.exited;
	const missed = Number(armed.next);
	expect(first.process.signalCode).toBe("SIGKILL");
	expect(Date.now()).toBeLessThan(missed);
	await delay(missed + late + 300 - Date.now());

	const second = run(["resume", db, String(period), String(late)], CHILD);
	const done = (await second.next("done")) as unknown as Done;
	expect(await second.exited).toBe(0);
	expect(done.pinned).toEqual({ phase: "wait", next: missed });
	expect(done.notices).toEqual([{ class: "outcome", content: `[schedule ${done.taskId} · ${CRON}]\nfire 1: 報時` }]);
	expect(done.fireCalls).toBe(1);
	expect(done.results).toHaveLength(1);
	expect(done.results[0]?.slot).toBeGreaterThan(missed + late);
	expect(done.owned).toEqual([
		{ id: expect.any(Number), requests: [`recurring:${done.taskId}:${done.results[0]?.slot}`] },
	]);
});

test("a fire killed after its answer is stored and before the notice tells it once, with no second model call", {
	timeout: 30_000,
}, async () => {
	const db = join(await directory(), "soma.sqlite");
	const first = run(["answer", db], CHILD);
	await first.exited;
	expect(first.process.signalCode).toBe("SIGKILL");

	const second = run(["resume", db], CHILD);
	const done = (await second.next("done")) as unknown as Done;
	expect(await second.exited).toBe(0);
	// The crash left the fire pinned, its answer stored and nothing told.
	expect(done.pinned).toEqual({
		phase: "wait",
		next: expect.any(Number),
		slot: expect.any(Number),
		conversationId: expect.any(Number),
	});
	expect(done.notices).toEqual([{ class: "outcome", content: `[schedule ${done.taskId} · ${CRON}]\nfire 1: 報時` }]);
	expect(done.fireCalls).toBe(0);
	expect(done.results).toEqual([{ rule: done.taskId, slot: done.pinned.slot }]);
	expect(done.owned).toEqual([
		{ id: done.pinned.conversationId, requests: [`recurring:${done.taskId}:${done.pinned.slot}`] },
	]);
});
