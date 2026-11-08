// A stand-in for claude-agent-acp: an ACP agent over stdio that writes a claude transcript for each session under
// $FAKE_ACP_PROJECTS, as claude does, and whose turns a word in the prompt scripts:
//   ASK    asks permission for a Bash call and replies with the option it was given
//   TWICE  asks twice at once, with the same tool call id and options, and replies with both options it was given
//   WITHDRAW asks, withdraws the request 100 ms later, and replies 300 ms after that
//   ABANDON asks and ends the turn 50 ms later without waiting for the answer
//   AUTH   refuses the prompt with -32000 Authentication required, as claude-agent-acp does without a login
//   ENV    replies with SOMA_AGENT, its parent's pid, its cwd and the session's
//   EXIT   exits with code 3 mid-turn
//   LATE   answers the prompt first and writes the reply 150 ms later
//   CANCEL ends the turn as cancelled, with no reply written
//   LONG   stops at max_tokens
//   BULKY  writes a 600 KiB record that is no part of the conversation, as claude's API request records are
//   RECALL replies with every earlier prompt of the session, the ones session/load read back included
//   HANG   never ends the turn
//   SLOW   echoes 500 ms later, a turn long enough for a test to act while it runs
//   SPIN   writes a partial reply and runs until session/cancel, ending cancelled $FAKE_ACP_STOP_MS later (50 by default)
//   FINISH runs until session/cancel, then ends by itself with a reply, as a turn the cancel came too late for
//   LATEASK runs until session/cancel, then asks permission, and ends cancelled once answered
//   ASKHANG asks permission, and once answered never ends the turn
//   anything else is echoed.
// An ASK or TWICE answered cancelled with session/cancel out ends cancelled, leaving what claude leaves for an interrupted
// tool call. session/cancel appends the session's id to $FAKE_ACP_PROJECTS/cancelled. session/close appends the session's
// id to $FAKE_ACP_PROJECTS/closed. session/load reads the session's transcript
// back, as claude-agent-acp does, replaying its prompts, and appends "<session id> <cwd>" to $FAKE_ACP_PROJECTS/loaded;
// a session with no transcript is refused with -32002, as one that never ran a prompt is.
// $FAKE_ACP_NEW_MS delays session/new, as claude's CLI start does; $FAKE_ACP_NEW_AUTH refuses it with -32000.
// $FAKE_ACP_LOAD_AUTH and $FAKE_ACP_LOAD_EXIT, comma-separated agent names, have the agent whose SOMA_AGENT is named
// refuse session/load with -32000 or exit with code 4 during it. Each agent appends "<SOMA_AGENT> <pid>" to $FAKE_ACP_PIDS.
// $FAKE_ACP_LOAD_MS delays session/load. $FAKE_ACP_IGNORE_TERM has the agent live through SIGTERM.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
	agent,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
	RequestError,
	type RequestPermissionRequest,
} from "@agentclientprotocol/sdk";

const projects = process.env.FAKE_ACP_PROJECTS ?? "/nonexistent";
const sessions = new Map<string, { cwd: string; last?: string; prompts: string[] }>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const named = (variable: string | undefined) => (variable ?? "").split(",").includes(process.env.SOMA_AGENT ?? "");
const transcriptOf = (sessionId: string, cwd: string) =>
	join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
if (process.env.FAKE_ACP_IGNORE_TERM) process.on("SIGTERM", () => {});
if (process.env.FAKE_ACP_PIDS) appendFileSync(process.env.FAKE_ACP_PIDS, `${process.env.SOMA_AGENT} ${process.pid}\n`);

/** Appends one record to the session's transcript, chained to the one before, as claude writes them. */
function write(sessionId: string, type: "user" | "assistant", content: unknown): void {
	const session = sessions.get(sessionId);
	if (session === undefined) throw new Error(`no session ${sessionId}`);
	const path = transcriptOf(sessionId, session.cwd);
	mkdirSync(join(path, ".."), { recursive: true });
	const uuid = randomUUID();
	const message =
		type === "user"
			? { role: "user", content }
			: { id: `msg-${uuid}`, role: "assistant", model: "claude-fake-1", content };
	const record = { type, uuid, parentUuid: session.last ?? null, sessionId, cwd: session.cwd, message };
	appendFileSync(path, `${JSON.stringify(record)}\n`);
	session.last = uuid;
}

const reply = (sessionId: string, text: string) => write(sessionId, "assistant", [{ type: "text", text }]);

const cancelled = new Set<string>();
const cancelling = new Map<string, () => void>();
const untilCancelled = (sessionId: string) =>
	new Promise<void>((resolve) => {
		if (cancelled.has(sessionId)) resolve();
		else cancelling.set(sessionId, resolve);
	});
/** Whether the turn is over by session/cancel, which may reach this agent just after its answer. */
async function wasCancelled(sessionId: string): Promise<boolean> {
	await sleep(10);
	if (!cancelled.has(sessionId)) return false;
	write(sessionId, "user", [{ type: "text", text: "[Request interrupted by user for tool use]" }]);
	return true;
}

const app = agent({ name: "fake-acp" })
	.onRequest(methods.agent.initialize, () => ({
		protocolVersion: PROTOCOL_VERSION,
		agentCapabilities: { loadSession: true },
		authMethods: [],
	}))
	.onRequest(methods.agent.session.new, async ({ params }) => {
		await sleep(Number(process.env.FAKE_ACP_NEW_MS ?? 0));
		if (process.env.FAKE_ACP_NEW_AUTH) throw RequestError.authRequired();
		const sessionId = randomUUID();
		sessions.set(sessionId, { cwd: params.cwd, prompts: [] });
		return { sessionId };
	})
	.onRequest(methods.agent.session.load, async ({ params, client }) => {
		await sleep(Number(process.env.FAKE_ACP_LOAD_MS ?? 0));
		if (named(process.env.FAKE_ACP_LOAD_EXIT)) process.exit(4);
		if (named(process.env.FAKE_ACP_LOAD_AUTH)) throw RequestError.authRequired();
		const { sessionId, cwd } = params;
		const path = transcriptOf(sessionId, cwd);
		if (!existsSync(path)) throw RequestError.resourceNotFound();
		const records = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; uuid: string; message?: { content: unknown } });
		const prompts = records.flatMap((record) =>
			record.type === "user" && typeof record.message?.content === "string" ? [record.message.content] : [],
		);
		for (const text of prompts) {
			await client.notify(methods.client.session.update, {
				sessionId,
				update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
			});
		}
		sessions.set(sessionId, { cwd, last: records.at(-1)?.uuid, prompts });
		mkdirSync(projects, { recursive: true });
		appendFileSync(join(projects, "loaded"), `${sessionId} ${cwd}\n`);
		return {};
	})
	.onRequest(methods.agent.session.close, ({ params }) => {
		mkdirSync(projects, { recursive: true });
		appendFileSync(join(projects, "closed"), `${params.sessionId}\n`);
		return {};
	})
	.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
		const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
		const { sessionId } = params;
		cancelled.delete(sessionId);
		if (text.includes("AUTH")) throw RequestError.authRequired();
		const earlier = [...(sessions.get(sessionId)?.prompts ?? [])];
		sessions.get(sessionId)?.prompts.push(text);
		write(sessionId, "user", text);
		if (text.includes("SPIN")) {
			reply(sessionId, "結果：失敗\npartial, read as nothing");
			await untilCancelled(sessionId);
			await sleep(Number(process.env.FAKE_ACP_STOP_MS ?? 50));
			return { stopReason: "cancelled" };
		}
		if (text.includes("FINISH")) {
			await untilCancelled(sessionId);
			reply(sessionId, "結果：完成\nfinished by itself");
			return { stopReason: "end_turn" };
		}
		if (text.includes("HANG") && !text.includes("ASK")) await new Promise(() => {});
		if (text.includes("SLOW")) await sleep(500);
		if (text.includes("RECALL")) {
			reply(sessionId, `recall: ${earlier.join(" | ")}`);
			return { stopReason: "end_turn" };
		}
		if (text.includes("EXIT")) process.exit(3);
		if (text.includes("CANCEL")) return { stopReason: "cancelled" };
		const touch = (file: string, toolCallId: string): RequestPermissionRequest => ({
			sessionId,
			toolCall: { toolCallId, title: `touch ${file}`, kind: "execute", rawInput: { command: `touch ${file}` } },
			options: [
				{ optionId: "allow-once", name: "Yes", kind: "allow_once" },
				{ optionId: "reject", name: "No", kind: "reject_once" },
			],
		});
		if (text.includes("TWICE")) {
			const asked = ["one.txt", "two.txt"].map((file) =>
				client.request(methods.client.session.requestPermission, touch(file, "toolu_twice")),
			);
			const chosen = (await Promise.all(asked)).map(({ outcome }) =>
				outcome.outcome === "selected" ? outcome.optionId : "cancelled",
			);
			if (await wasCancelled(sessionId)) return { stopReason: "cancelled" };
			reply(sessionId, `permission ${chosen.join(" ")}`);
			return { stopReason: "end_turn" };
		}
		if (text.includes("WITHDRAW")) {
			await client
				.request(methods.client.session.requestPermission, touch("probe.txt", "toolu_withdraw"), {
					cancellationSignal: AbortSignal.timeout(100),
					stopWaitingOnCancel: true,
				})
				.catch(() => {});
			await sleep(300);
			reply(sessionId, "withdrawn");
			return { stopReason: "end_turn" };
		}
		if (text.includes("ABANDON")) {
			void client
				.request(methods.client.session.requestPermission, touch("probe.txt", "toolu_abandon"))
				.catch(() => {});
			await sleep(50);
			reply(sessionId, "abandoned");
			return { stopReason: "end_turn" };
		}
		if (text.includes("LATEASK")) {
			await untilCancelled(sessionId);
			const { outcome } = await client.request(
				methods.client.session.requestPermission,
				touch("late.txt", "toolu_late"),
			);
			reply(sessionId, `asked once cancelled: ${outcome.outcome}`);
			return { stopReason: "cancelled" };
		}
		if (text.includes("ASK")) {
			const toolUseId = `toolu_${randomUUID()}`;
			write(sessionId, "assistant", [
				{ type: "tool_use", id: toolUseId, name: "Bash", input: { command: "touch probe.txt" } },
			]);
			const { outcome } = await client.request(methods.client.session.requestPermission, {
				sessionId,
				toolCall: {
					toolCallId: toolUseId,
					title: "touch probe.txt",
					kind: "execute",
					rawInput: { command: "touch probe.txt", description: "Create probe.txt" },
				},
				options: [
					{ optionId: "allow-once", name: "Yes", kind: "allow_once" },
					{ optionId: "allow-with-updates", name: "Yes, and don't ask again for touch", kind: "allow_always" },
					{ optionId: "reject", name: "No", kind: "reject_once" },
				],
			});
			if (text.includes("ASKHANG")) await new Promise(() => {});
			if (outcome.outcome === "cancelled" && (await wasCancelled(sessionId))) return { stopReason: "cancelled" };
			const chosen = outcome.outcome === "selected" ? outcome.optionId : "cancelled";
			write(sessionId, "user", [{ type: "tool_result", tool_use_id: toolUseId, content: `chosen ${chosen}` }]);
			reply(sessionId, `結果：完成\npermission ${chosen}`);
			return { stopReason: "end_turn" };
		}
		if (text.includes("ENV")) {
			const session = sessions.get(sessionId)?.cwd;
			reply(
				sessionId,
				`SOMA_AGENT=${process.env.SOMA_AGENT} ppid=${process.ppid} cwd=${process.cwd()} session=${session}`,
			);
			return { stopReason: "end_turn" };
		}
		if (text.includes("LATE")) {
			setTimeout(() => reply(sessionId, "late reply"), 150);
			return { stopReason: "end_turn" };
		}
		if (text.includes("BULKY")) {
			const blob = { type: "api-request-blob", uuid: randomUUID(), blob: "x".repeat(600 * 1024) };
			appendFileSync(transcriptOf(sessionId, sessions.get(sessionId)?.cwd ?? ""), `${JSON.stringify(blob)}\n`);
			reply(sessionId, "bulky reply");
			return { stopReason: "end_turn" };
		}
		if (text.includes("LONG")) {
			reply(sessionId, "cut short");
			return { stopReason: "max_tokens" };
		}
		reply(sessionId, `echo: ${text}`);
		return { stopReason: "end_turn" };
	})
	.onNotification(methods.agent.session.cancel, ({ params }) => {
		mkdirSync(projects, { recursive: true });
		appendFileSync(join(projects, "cancelled"), `${params.sessionId}\n`);
		cancelled.add(params.sessionId);
		cancelling.get(params.sessionId)?.();
	});

app.connect(
	ndJsonStream(
		Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
		Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
	),
);
