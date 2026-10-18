import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { type HumanPort, type NoticeKind, PUSHED_FAILURES } from "../../ports/human.ts";

export interface TelegramConfig {
	readonly token: string;
	/** The one chat soma takes inputs from and sends to: anyone else who finds the bot could dispatch agents. */
	readonly chatId: number;
	readonly apiBase: string;
}

export interface TelegramOptions extends TelegramConfig {
	readonly human: HumanPort;
	readonly signal: AbortSignal;
	readonly pollTimeoutSeconds?: number;
	readonly retryMs?: number;
	readonly onError?: (error: unknown) => void;
}

const REQUEST_PREFIX = "telegram:";
// Rounds started by these sources produce something the human did not ask for here: push them as notices.
// A digest round is not among them: its report arrives as a notice entry of its own.
const PUSHED_SOURCES = ["schedule:"];
// sendMessage takes 1-4096 characters; JavaScript string length counts the same UTF-16 units.
export const MESSAGE_LIMIT = 4096;

const UpdateSchema = z
	.object({
		update_id: z.number(),
		message: z
			.object({ message_id: z.number(), chat: z.object({ id: z.number() }).passthrough(), text: z.string().optional() })
			.passthrough()
			.optional(),
	})
	.passthrough();
const ResponseSchema = z.union([
	z.object({ ok: z.literal(true), result: z.unknown() }).passthrough(),
	z.object({ ok: z.literal(false), description: z.string().optional() }).passthrough(),
]);

/** Cut text into sendMessage-sized parts, at a line break when one is near, never inside a surrogate pair. */
export function splitMessage(text: string, limit = MESSAGE_LIMIT): string[] {
	const parts: string[] = [];
	let rest = text.trim() === "" ? "（這一輪沒有文字回答）" : text;
	while (rest.length > limit) {
		let cut = rest.lastIndexOf("\n", limit);
		if (cut < limit / 2) cut = limit;
		if (/[\uD800-\uDBFF]/.test(rest[cut - 1] ?? "")) cut -= 1;
		parts.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	parts.push(rest);
	return parts;
}

const label = (kind: NoticeKind, content: string) => `[${kind === "question" ? "問題" : "通知"}] ${content}`;

/**
 * The Telegram client: each text message from the configured chat is an input, and answers and failures of this
 * client's inputs, failures of rounds the core started, and notices go back to that chat. A message Telegram delivers again keeps its requestId, so the core admits it
 * once; the update offset only lives in memory. Resolves when `signal` aborts.
 */
export async function runTelegram(options: TelegramOptions): Promise<void> {
	const { human, chatId, signal } = options;
	const onError = options.onError ?? ((error) => console.error("[soma] telegram:", error));
	const call = async (method: string, body: object): Promise<unknown> => {
		const response = await fetch(`${options.apiBase}/bot${options.token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
		const parsed = ResponseSchema.parse(await response.json());
		if (!parsed.ok) throw new Error(`${method}: ${parsed.description ?? response.status}`);
		return parsed.result;
	};

	// One at a time, so a long answer's parts and the messages after it arrive in order.
	let sending = Promise.resolve();
	const send = (text: string) => {
		sending = sending.then(async () => {
			for (const part of splitMessage(text)) {
				try {
					await call("sendMessage", { chat_id: chatId, text: part });
				} catch (error) {
					if (!signal.aborted) onError(error);
					return;
				}
			}
		});
	};
	// The prefix, not a set of ids sent from here, marks this client's rounds: a round the core finishes after a
	// restart still reaches the chat that started it.
	const unsubscribe = human.subscribe((event) => {
		if (event.type === "notice") send(label(event.kind, event.content));
		else if (event.type === "answer") {
			if (event.requestId.startsWith(REQUEST_PREFIX)) send(event.content);
			else if (PUSHED_SOURCES.some((source) => event.requestId.startsWith(source)))
				send(label("report", event.content));
		} else if (event.type === "failure") {
			if (event.requestId.startsWith(REQUEST_PREFIX)) send(`[失敗] ${event.reason}`);
			else if (PUSHED_FAILURES.some((source) => event.requestId.startsWith(source)))
				send(`[失敗] ${event.requestId} 那一輪：${event.reason}`);
		}
	});

	const timeout = options.pollTimeoutSeconds ?? 30;
	let offset: number | undefined;
	try {
		while (!signal.aborted) {
			try {
				const updates = z
					.array(UpdateSchema)
					.parse(await call("getUpdates", { offset, timeout, allowed_updates: ["message"] }));
				for (const { update_id, message } of updates) {
					if (message?.text !== undefined && message.chat.id === chatId) {
						await human.submit({
							content: message.text,
							entry: { kind: "chat.telegram", data: { messageId: message.message_id } },
							requestId: `${REQUEST_PREFIX}${message.message_id}`,
						});
					}
					// Confirmed by the next getUpdates, so only once the core has admitted the input.
					offset = update_id + 1;
				}
			} catch (error) {
				if (signal.aborted) break;
				onError(error);
				await sleep(options.retryMs ?? 5_000, undefined, { signal }).catch(() => {});
			}
		}
	} finally {
		unsubscribe();
		await sending;
	}
}
