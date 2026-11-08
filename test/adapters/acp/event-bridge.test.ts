import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import type { Job } from "../../../src/core/domain/dispatch.ts";
import { AGENT_BLOCKED, eventBridge, JOB_DONE } from "../../../src/core/extensions/dispatch/bridge.ts";
import { Dispatches, dispatchExtension } from "../../../src/core/extensions/dispatch/index.ts";
import { openHarness } from "../../../src/core/harness.ts";
import { NOTICE } from "../../../src/core/notice.ts";
import type { AgentPort } from "../../../src/ports/agent.ts";
import { harness as acpHarness, cleanUp, sleep } from "./fake.ts";

const context = BACKGROUND_CONTEXT;
const open: Harness[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
	await cleanUp();
});

/**
 * The real core over the ACP adapter running the fake agent, with a faux model that dispatches on 「派 <card>」, sends
 * 「回覆 <card> <text>」 with reply, reads 「看 <card>」 with screen, and answers a wake that offers a fingerprint with
 * option 1. `brief` is the card the agent is given; `results` holds every tool result the model was handed. With
 * `startLate`, the core's `start` returns that many ms after the adapter's did, so it lists the job that much later.
 */
async function core(brief: string, fake: Record<string, string> = {}, startLate = 0) {
	// session/new takes a while, as claude's CLI start does, so the job is listed before its first idle.
	const acp = await acpHarness({ fake: { FAKE_ACP_NEW_MS: "200", ...fake } });
	const port: AgentPort = {
		...acp.port,
		start: async (request) => {
			await acp.port.start(request);
			await sleep(startLate);
		},
	};
	const results: string[] = [];
	const faux = fauxProvider();
	faux.setResponses(
		Array.from({ length: 30 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
			const last = request.messages.at(-1);
			const text = JSON.stringify(last?.content ?? "");
			if (last?.role === "toolResult") {
				results.push(text);
				return fauxAssistantMessage("好。");
			}
			const fingerprint = /fingerprint=([0-9a-f]{16})/.exec(text)?.[1];
			const [, verb, card = "", rest = ""] = /(派|回覆|看) ([a-z0-9-]+) ?([^"]*)/.exec(text) ?? [];
			const call = (name: string, args: Record<string, string>) =>
				fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
			if (fingerprint !== undefined) {
				return call("respond", { card: "card-a", option: "1", fingerprint, reason: "the test approves it" });
			}
			if (verb === "派") return call("dispatch", { card, repo: acp.cwd });
			if (verb === "回覆") return call("reply", { card, text: rest, reason: "the human answered" });
			if (verb === "看") return call("screen", { card });
			return fauxAssistantMessage("好。");
		}),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await openHarness(
		join(acp.cwd, "..", "soma.sqlite"),
		[dispatchExtension(port, async (_repo, card) => `# ${card}\n\n${brief}`)],
		context,
		{ models },
	);
	open.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const off = eventBridge(root, acp.port, context).listen((error) => {
		throw error;
	});
	const job = async () =>
		(await harness.snapshot(Dispatches, root.id, context))?.jobs.find((each) => each.agent === "card-a");
	const entries = async (kind: string) =>
		(await root.entries({ order: "ascending" }, 1000, undefined, context)).items.filter((entry) => entry.kind === kind);
	const say = async (content: string) => {
		const submission = await root.submit({ type: "input", content, requestId: `t:${content}` }, context);
		expect((await submission.wait(context)).status).toBe("done");
	};
	/** Waits until the job matches `ok`, and then until the model is idle. */
	const until = async (ok: (found: Job | undefined) => boolean | Promise<boolean>, ms = 10_000) => {
		for (const deadline = Date.now() + ms; ; await sleep(20)) {
			const found = await job();
			if (await ok(found)) {
				await root.waitForIdle(context);
				return found;
			}
			if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(found)}`);
		}
	};
	const transcript = async () => {
		const projects = join(acp.cwd, "..", "projects");
		const [directory] = await readdir(projects);
		const [file] = await readdir(join(projects, directory as string));
		const text = await readFile(join(projects, directory as string, file as string), "utf8");
		return text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; message: { content: unknown } });
	};
	return { acp, job, entries, say, until, transcript, results, calls: () => faux.state.callCount, off };
}

test("dispatch starts a job over ACP, the bridge sends the brief, the model answers its permission request, and the turn is recorded", async () => {
	const soma = await core("ASK");
	await soma.say("派 card-a");
	const job = await soma.until((found) => found?.outcome !== undefined);

	const [first] = await soma.transcript();
	expect(first).toMatchObject({
		type: "user",
		message: { content: expect.stringMatching(/以下是任務卡：\n\n# card-a\n\nASK$/) },
	});
	expect(job).toMatchObject({
		status: { state: "done" },
		outcome: "完成",
		decisions: [{ kind: "permission", action: "answered", option: "1", reason: "the test approves it" }],
	});
	expect(job?.launch).toBeUndefined();
	const [wake] = await soma.entries(AGENT_BLOCKED);
	expect(wake).toBeDefined();
	expect(await soma.entries(JOB_DONE)).toMatchObject([
		{ data: { agent: "card-a", card: "card-a", state: "done", outcome: "完成" } },
	]);
	expect((await soma.acp.port.readResult("card-a"))?.text).toBe("結果：完成\npermission allow-once");
	soma.off();
});

test("a job the core lists only after the session's first idle still gets its brief", async () => {
	// start returns after initialize; the session opens 200 ms later, before the core lists the job.
	const soma = await core("hello", {}, 300);
	await soma.say("派 card-a");
	const job = await soma.until((found) => found?.outcome !== undefined);
	expect(job?.launch).toBeUndefined();
	const [first] = await soma.transcript();
	expect(first).toMatchObject({
		type: "user",
		message: { content: expect.stringMatching(/以下是任務卡：\n\n# card-a\n\nhello$/) },
	});
	// The idle resent is the observation the job took the brief at, so it records no turn.
	expect(await soma.entries(JOB_DONE)).toMatchObject([{ data: { state: "done" } }]);
	soma.off();
});

test("reply sends a done job its next prompt, and screen reads its transcript", async () => {
	const soma = await core("hello");
	await soma.say("派 card-a");
	await soma.until((found) => found?.outcome !== undefined);
	await soma.say("回覆 card-a 結果：完成 please");
	await soma.until((found) => found?.status.state === "done" && found.decisions.length === 1);
	await soma.until(async () => (await soma.entries(JOB_DONE)).length === 2);
	const [launched, replied] = await soma.entries(JOB_DONE);
	expect(launched).toMatchObject({ data: { state: "done", outcome: "未知" } });
	expect(replied).toMatchObject({ data: { state: "done", outcome: "未知" } });
	const seqOf = (entry: typeof launched) => (entry?.data as { seq?: number } | undefined)?.seq ?? 0;
	expect(seqOf(replied)).toBeGreaterThan(seqOf(launched));
	expect((await soma.acp.port.readResult("card-a"))?.text).toBe("echo: 結果：完成 please");
	expect((await soma.job())?.decisions).toMatchObject([{ action: "replied", text: "結果：完成 please" }]);

	await soma.say("看 card-a");
	expect(soma.results.at(-1)).toContain("> 結果：完成 please");
	expect(soma.results.at(-1)).toContain("● echo: 結果：完成 please");
	soma.off();
});

test("a prompt refused for want of a login reaches the human as a configuration error, not as a failed job", async () => {
	const soma = await core("AUTH", { USER: "" });
	await soma.say("派 card-a");
	const job = await soma.until((found) => found?.status.state === "blocked");
	expect(job?.status).toMatchObject({ state: "blocked", kind: "auth" });
	expect(job?.decisions).toMatchObject([{ kind: "auth", action: "escalated" }]);
	const questions = (await soma.entries(NOTICE)).filter(
		(entry) => (entry.data as { kind?: string } | undefined)?.kind === "question",
	);
	expect(questions).toHaveLength(1);
	expect(JSON.stringify(questions[0]?.data)).toMatch(/configuration error.*HOME=\/home\/someone and USER=unset/);
	expect(await soma.entries(JOB_DONE)).toEqual([]);
	// The dispatch only: the model was not woken for it.
	expect(soma.calls()).toBe(2);
	soma.off();
});
