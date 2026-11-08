import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { Answer } from "../../ports/agent.ts";
import {
	type Choices,
	type Delivery,
	deliveryTo,
	type HumanAnswerOutcome,
	type HumanPort,
	type NoticeKind,
} from "../../ports/human.ts";
import { escapeHtml, htmlToPlain, markdownToHtml, splitHtml } from "./html.ts";

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
/** The entry kind of this client's inputs, by which the core says what this chat does with each push. */
export const ENTRY_KIND = "chat.telegram";
// sendMessage takes 1-4096 characters; JavaScript string length counts the same UTF-16 units.
export const MESSAGE_LIMIT = 4096;
const EMPTY_ANSWER = "（這一輪沒有文字回答）";
// What Telegram answers a message whose entities it cannot place: https://core.telegram.org/bots/api#formatting-options
const ENTITY_REFUSAL = /can't parse entities|can't find end tag|unsupported start tag|entity/i;

// The one reaction a message from the human carries, replaced as the round moves on; a bot without premium gets one.
// Each is in ReactionTypeEmoji's list: https://core.telegram.org/bots/api#reactiontypeemoji
const REACTIONS = { received: "👀", forwarded: "👌", answered: "👍", failed: "👎" } as const;

// callback_data takes 1-64 bytes: https://core.telegram.org/bots/api#inlinekeyboardbutton
const CALLBACK_DATA_LIMIT = 64;
// The data of the button that replaces a pressed keyboard: it names no answer, so a press on it only gets answered.
const SETTLED = "-";
// What replaces the buttons of a prompt answered on another interface, or by the model.
const ELSEWHERE = "已在別處處理";

const ButtonSchema = z.object({ text: z.string(), callback_data: z.string().optional() }).passthrough();
const UpdateSchema = z
	.object({
		update_id: z.number(),
		message: z
			.object({ message_id: z.number(), chat: z.object({ id: z.number() }).passthrough(), text: z.string().optional() })
			.passthrough()
			.optional(),
		callback_query: z
			.object({
				id: z.string(),
				data: z.string().optional(),
				message: z
					.object({
						message_id: z.number(),
						chat: z.object({ id: z.number() }).passthrough(),
						reply_markup: z
							.object({ inline_keyboard: z.array(z.array(ButtonSchema)) })
							.passthrough()
							.optional(),
					})
					.passthrough()
					.optional(),
			})
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
	let rest = text.trim() === "" ? EMPTY_ANSWER : text;
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

/**
 * What the model wrote as the HTML parts sendMessage takes: converted from markdown and cut so that no part holds an
 * unclosed tag. Text that cannot be converted goes as plain text, escaped. The limit counts the markup, which is
 * more than Telegram counts, so a part never passes it.
 */
export function messageParts(text: string): string[] {
	const source = text.trim() === "" ? EMPTY_ANSWER : text;
	try {
		const parts = splitHtml(markdownToHtml(source), MESSAGE_LIMIT);
		if (parts.length > 0) return parts;
	} catch {
		// Falls through to plain text.
	}
	return splitMessage(source).map(escapeHtml);
}

const REFUSALS: Record<Extract<HumanAnswerOutcome, { sent: false }>["refusal"], string> = {
	not_blocked: "agent 已經不在等回答",
	stale: "提示已經變了",
	unknown_option: "沒有這個選項",
	auth: "憑證要你親自處理",
	unreadable: "畫面讀不出選項，或游標停不到選項上，可以再按一次",
	no_job: "派工清單裡沒有這張卡片",
};

// A card name is kebab-case and a fingerprint hex, so neither holds the separator.
const callbackData = (card: string, { option, fingerprint }: Answer) => `${option}:${fingerprint}:${card}`;

function parseCallbackData(data: string | undefined): { card: string; answer: Answer } | undefined {
	const [option, fingerprint, card, ...rest] = data?.split(":") ?? [];
	if (!option || !fingerprint || !card || rest.length > 0) return undefined;
	return { card, answer: { option, fingerprint } };
}

/** One button per option, or none when a button's data would not fit: a cut card name would answer another job. */
function keyboard({ card, fingerprint, options }: Choices) {
	const rows = options.map(({ id, label }) => [
		{ text: label, callback_data: callbackData(card, { option: id, fingerprint }) },
	]);
	const fits = rows.every(([button]) => Buffer.byteLength(button?.callback_data ?? "") <= CALLBACK_DATA_LIMIT);
	return fits ? { inline_keyboard: rows } : undefined;
}

const label = (kind: NoticeKind, content: string) => `[${kind === "question" ? "問題" : "通知"}] ${content}`;

/**
 * The Telegram client: each text message from the configured chat is an input, and answers and failures of this
 * client's inputs, failures of rounds the core started, and notices go back to that chat. A question that offers
 * choices gets a button per option; a press from that chat goes to the agent as the human's own answer. A message Telegram delivers again keeps its requestId, so the core admits it
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

	// A second tap arrives before the first press's edit hides the buttons; its refusal must not replace the result.
	// A message whose buttons were taken away as answered elsewhere is settled too.
	const settled = new Set<number>();
	// By card and fingerprint, the messages here showing that prompt's buttons; lost on a restart.
	const shown = new Map<string, { card: string; fingerprint: string; messageIds: number[] }>();
	// A part Telegram refuses for its entities goes again as the text it shows, so formatting never loses a message.
	const sendPart = async (html: string, extra: object): Promise<unknown> => {
		try {
			return await call("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", ...extra });
		} catch (error) {
			if (!(error instanceof Error) || !ENTITY_REFUSAL.test(error.message)) throw error;
			return call("sendMessage", { chat_id: chatId, text: htmlToPlain(html), ...extra });
		}
	};
	// One at a time, so a long answer's parts and the messages after it arrive in order.
	let sending = Promise.resolve();
	const send = (
		text: string,
		markup?: object,
		{ silent = false, prompt }: { silent?: boolean; prompt?: Choices } = {},
	) => {
		sending = sending.then(async () => {
			const parts = messageParts(text);
			for (const [index, part] of parts.entries()) {
				const last = index === parts.length - 1 && markup !== undefined;
				try {
					const sent = await sendPart(part, {
						...(last ? { reply_markup: markup } : {}),
						...(silent ? { disable_notification: true } : {}),
					});
					const messageId = (sent as { message_id?: unknown }).message_id;
					if (last && prompt !== undefined && typeof messageId === "number") {
						const key = `${prompt.card}\n${prompt.fingerprint}`;
						const entry = shown.get(key) ?? { card: prompt.card, fingerprint: prompt.fingerprint, messageIds: [] };
						entry.messageIds.push(messageId);
						shown.set(key, entry);
					}
				} catch (error) {
					if (!signal.aborted) onError(error);
					return;
				}
			}
		});
	};
	// Telegram refuses to answer a query that is too old or to edit or react to a deleted message; none may stop the polling.
	const quietly = (method: string, body: object) =>
		call(method, body).catch((error: unknown) => {
			if (!signal.aborted) onError(error);
		});
	// One at a time, so a later stage's reaction is the one that stays.
	let reacting = Promise.resolve();
	const react = (requestId: string, stage: keyof typeof REACTIONS) => {
		const body = {
			chat_id: chatId,
			message_id: Number(requestId.slice(REQUEST_PREFIX.length)),
			reaction: [{ type: "emoji", emoji: REACTIONS[stage] }],
		};
		reacting = reacting.then(() => quietly("setMessageReaction", body).then(() => {}));
	};

	// A push the core starts: it says whether this chat rings, shows it without a sound, or leaves it to the history.
	const push = (text: string, delivery: Delivery, choices?: Choices) => {
		if (delivery === "log") return;
		const markup = choices && keyboard(choices);
		send(text, markup, { silent: delivery === "quiet", ...(markup && { prompt: choices }) });
	};

	// The prefix, not a set of ids sent from here, marks this client's rounds: a round the core finishes after a
	// restart still reaches the chat that started it.
	const unsubscribe = human.subscribe((event) => {
		const mine = "requestId" in event && event.requestId.startsWith(REQUEST_PREFIX);
		if (event.type === "notice") {
			if (event.kind === "forwarded") {
				if (mine) react(event.requestId, "forwarded");
			} else push(label(event.kind, event.content), deliveryTo(event, ENTRY_KIND), event.choices);
		} else if (event.type === "job") {
			// Answered elsewhere: the prompt is no longer on the job's screen. Queued behind the sends, so it sees them.
			const { card, status } = event;
			sending = sending.then(async () => {
				for (const [key, prompt] of shown) {
					if (prompt.card !== card) continue;
					if (status.state === "blocked" && status.fingerprint === prompt.fingerprint) continue;
					shown.delete(key);
					for (const messageId of prompt.messageIds.filter((id) => !settled.has(id))) {
						settled.add(messageId);
						await quietly("editMessageReplyMarkup", {
							chat_id: chatId,
							message_id: messageId,
							reply_markup: { inline_keyboard: [[{ text: ELSEWHERE, callback_data: SETTLED }]] },
						});
					}
				}
			});
		} else if (event.type === "answer") {
			if (mine) {
				react(event.requestId, "answered");
				send(event.content);
			} else if (event.class !== undefined) push(label("report", event.content), deliveryTo(event, ENTRY_KIND));
		} else if (event.type === "failure") {
			if (mine) {
				react(event.requestId, "failed");
				send(`[失敗] ${event.reason}`);
			} else if (event.class !== undefined)
				push(`[失敗] ${event.requestId} 那一輪：${event.reason}`, deliveryTo(event, ENTRY_KIND));
		}
	});
	type CallbackQuery = NonNullable<z.infer<typeof UpdateSchema>["callback_query"]>;
	const answerPress = async (query: CallbackQuery, message: NonNullable<CallbackQuery["message"]>) => {
		const pressed = parseCallbackData(query.data);
		if (pressed === undefined || settled.has(message.message_id))
			return quietly("answerCallbackQuery", { callback_query_id: query.id });
		settled.add(message.message_id);
		const outcome = await human.respond(pressed.card, pressed.answer);
		const button = message.reply_markup?.inline_keyboard.flat().find((each) => each.callback_data === query.data);
		const result = outcome.sent
			? `已選：${button?.text ?? pressed.answer.option}`
			: `未送出：${REFUSALS[outcome.refusal]}`;
		await quietly("answerCallbackQuery", { callback_query_id: query.id, text: result });
		await quietly("editMessageReplyMarkup", {
			chat_id: chatId,
			message_id: message.message_id,
			reply_markup: { inline_keyboard: [[{ text: result, callback_data: SETTLED }]] },
		});
	};

	const timeout = options.pollTimeoutSeconds ?? 30;
	let offset: number | undefined;
	try {
		while (!signal.aborted) {
			try {
				const updates = z
					.array(UpdateSchema)
					.parse(await call("getUpdates", { offset, timeout, allowed_updates: ["message", "callback_query"] }));
				for (const { update_id, message, callback_query } of updates) {
					if (message?.text !== undefined && message.chat.id === chatId) {
						const requestId = `${REQUEST_PREFIX}${message.message_id}`;
						await human.submit({
							content: message.text,
							entry: { kind: ENTRY_KIND, data: { messageId: message.message_id } },
							requestId,
						});
						react(requestId, "received");
					}
					// A press delivered again after a restart is safe: once its answer went through, the fingerprint no longer matches.
					if (callback_query?.message?.chat.id === chatId) await answerPress(callback_query, callback_query.message);
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
		await Promise.all([sending, reacting]);
	}
}
