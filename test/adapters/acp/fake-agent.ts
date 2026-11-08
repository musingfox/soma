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
//   anything else is echoed.
// session/close appends the session's id to $FAKE_ACP_PROJECTS/closed.
// $FAKE_ACP_NEW_MS delays session/new, as claude's CLI start does; $FAKE_ACP_NEW_AUTH refuses it with -32000.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
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
const sessions = new Map<string, { cwd: string; last?: string }>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Appends one record to the session's transcript, chained to the one before, as claude writes them. */
function write(sessionId: string, type: "user" | "assistant", content: unknown): void {
	const session = sessions.get(sessionId);
	if (session === undefined) throw new Error(`no session ${sessionId}`);
	const directory = join(projects, session.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
	mkdirSync(directory, { recursive: true });
	const uuid = randomUUID();
	const message = type === "user" ? { role: "user", content } : { id: `msg-${uuid}`, role: "assistant", content };
	const record = { type, uuid, parentUuid: session.last ?? null, sessionId, cwd: session.cwd, message };
	appendFileSync(join(directory, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`);
	session.last = uuid;
}

const reply = (sessionId: string, text: string) => write(sessionId, "assistant", [{ type: "text", text }]);

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
		sessions.set(sessionId, { cwd: params.cwd });
		return { sessionId };
	})
	.onRequest(methods.agent.session.close, ({ params }) => {
		mkdirSync(projects, { recursive: true });
		appendFileSync(join(projects, "closed"), `${params.sessionId}\n`);
		return {};
	})
	.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
		const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
		const { sessionId } = params;
		if (text.includes("AUTH")) throw RequestError.authRequired();
		write(sessionId, "user", text);
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
			const session = sessions.get(sessionId);
			const directory = join(projects, (session?.cwd ?? "").replace(/[^a-zA-Z0-9]/g, "-"));
			const blob = { type: "api-request-blob", uuid: randomUUID(), blob: "x".repeat(600 * 1024) };
			appendFileSync(join(directory, `${sessionId}.jsonl`), `${JSON.stringify(blob)}\n`);
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
	.onNotification(methods.agent.session.cancel, () => {});

app.connect(
	ndJsonStream(
		Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
		Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
	),
);
