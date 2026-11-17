import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface InlineKeyboard {
	readonly inline_keyboard: readonly (readonly { readonly text: string; readonly callback_data?: string }[])[];
}

export interface MessageUpdate {
	readonly update_id: number;
	readonly message: { readonly message_id: number; readonly chat: { readonly id: number }; readonly text: string };
}

export interface CallbackUpdate {
	readonly update_id: number;
	readonly callback_query: {
		readonly id: string;
		readonly data: string;
		readonly message: {
			readonly message_id: number;
			readonly chat: { readonly id: number };
			readonly reply_markup?: InlineKeyboard;
		};
	};
}

export type FakeUpdate = MessageUpdate | CallbackUpdate;

export interface SentMessage {
	readonly chat_id: number;
	readonly text: string;
	readonly reply_markup?: InlineKeyboard;
	/** Present only when the message was sent with a parse mode. */
	readonly parse_mode?: string;
	/** Present only when the message was sent without a sound. */
	readonly disable_notification?: true;
	/** Present only when the message was sent by sendRichMessage; `text` is then its `rich_message.markdown`. */
	readonly rich?: true;
}

// A rich message takes up to 32768 UTF-8 characters: https://core.telegram.org/bots/api#rich-message-formatting-options
const RICH_LIMIT = 32768;

// The tags parse_mode HTML takes: https://core.telegram.org/bots/api#html-style
const HTML_TAGS = new Set([
	"b",
	"strong",
	"i",
	"em",
	"u",
	"ins",
	"s",
	"strike",
	"del",
	"a",
	"code",
	"pre",
	"blockquote",
	"tg-spoiler",
	"span",
	"tg-emoji",
]);
const HTML_ENTITIES = /^&(?:lt|gt|amp|quot|#\d+|#x[\da-f]+);/i;

/** What Telegram would refuse in HTML text: a stray `<` or `&`, an unknown tag, or tags that do not nest. */
function htmlProblem(html: string): string | undefined {
	const open: string[] = [];
	for (let at = 0; at < html.length; ) {
		const char = html[at];
		if (char === "&") {
			const entity = HTML_ENTITIES.exec(html.slice(at, at + 12));
			if (entity === null) return `unescaped & at byte offset ${at}`;
			at += entity[0].length;
		} else if (char === "<") {
			const tag = /^<(\/?)([a-z-]+)(?:\s+[a-z-]+="[^"<>]*")*>/.exec(html.slice(at));
			if (tag === null) return `unsupported start tag at byte offset ${at}`;
			const [whole, closing, name = ""] = tag;
			if (!HTML_TAGS.has(name)) return `unsupported start tag "${name}" at byte offset ${at}`;
			if (closing === "") open.push(name);
			else if (open.pop() !== name) return `unmatched end tag at byte offset ${at}`;
			at += whole.length;
		} else at += 1;
	}
	return open.length > 0 ? `can't find end tag corresponding to start tag "${open.at(-1)}"` : undefined;
}

/** The text Telegram shows for valid HTML: tags dropped, entities decoded. */
function htmlToText(html: string): string {
	return html
		.replace(/<[^>]*>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&");
}

const badButtonData = (markup: InlineKeyboard | undefined) =>
	markup?.inline_keyboard.flat().some((button) => {
		const bytes = Buffer.byteLength(button.callback_data ?? "");
		return bytes < 1 || bytes > 64;
	});

/**
 * A local stand-in for the Telegram Bot API (getUpdates long polling, sendMessage and sendRichMessage with inline buttons, and the
 * answerCallbackQuery and editMessageReplyMarkup calls a button press leads to, setMessageReaction and sendMessageDraft) for one bot token, so the
 * client runs over real HTTP without a bot. An update stays queued until a getUpdates offset above its id
 * confirms it, as Telegram does; `redeliver` puts one back, as Telegram does when a confirmation was lost.
 */
export class FakeBotApi {
	readonly sent: SentMessage[] = [];
	/** The method of every call but getUpdates, refused ones included, in the order they came. */
	readonly methods: string[] = [];
	/** answerCallbackQuery and editMessageReplyMarkup, in the order they came. */
	readonly calls: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
	/** Each setMessageReaction as the message and its one emoji, in the order they came. */
	readonly reactions: { readonly message_id: number; readonly emoji: string }[] = [];
	/** Each sendMessageDraft it accepted, in the order they came; `text` as sent, absent when it was left out. */
	readonly drafts: { readonly chat_id: number; readonly draft_id: number; readonly text?: string }[] = [];
	/** Refuse every message that asks for a parse mode, as Telegram does for entities it cannot place. */
	refuseEntities = false;
	/** Methods answered with a 400, as Telegram answers a callback query that is too old. */
	readonly failing = new Set<string>();
	/** Methods whose connection is cut without an answer, as a network failure looks to the client. */
	readonly dropping = new Set<string>();
	readonly #markups = new Map<number, InlineKeyboard>();
	readonly #token: string;
	#queue: FakeUpdate[] = [];
	#nextUpdate = 1;
	#nextMessage = 1;
	#wake = new Set<() => void>();
	#server: Server | undefined;

	constructor(token: string) {
		this.#token = token;
	}

	/** Listen on a free local port; resolves to the base URL for `TELEGRAM_API_BASE`. */
	async listen(): Promise<string> {
		const server = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += chunk;
			const reply = (status: number, value: object) => {
				response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
			};
			const [, token, method] = /^\/bot([^/]+)\/(\w+)$/.exec(request.url ?? "") ?? [];
			if (token !== this.#token) return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });
			const params = JSON.parse(body || "{}") as Record<string, unknown>;
			if (method !== undefined && method !== "getUpdates") this.methods.push(method);
			if (method !== undefined && this.dropping.has(method)) return void response.destroy();
			if (method !== undefined && this.failing.has(method))
				return reply(400, { ok: false, error_code: 400, description: "Bad Request: query is too old" });
			if (method === "getUpdates") return reply(200, { ok: true, result: await this.#updates(params) });
			if (method === "sendMessage") {
				const markup = params.reply_markup as InlineKeyboard | undefined;
				const message = { chat_id: params.chat_id as number, text: params.text as string };
				const parseMode = params.parse_mode as string | undefined;
				if (typeof message.text !== "string")
					return reply(400, { ok: false, error_code: 400, description: "Bad Request: message text is invalid" });
				if (parseMode !== undefined) {
					const problem = this.refuseEntities ? "refused by the fake" : htmlProblem(message.text);
					if (problem !== undefined)
						return reply(400, {
							ok: false,
							error_code: 400,
							description: `Bad Request: can't parse entities: ${problem}`,
						});
				}
				// The limit counts the text after its entities are parsed.
				const shown = parseMode === undefined ? message.text : htmlToText(message.text);
				if (shown.length < 1 || shown.length > 4096)
					return reply(400, { ok: false, error_code: 400, description: "Bad Request: message text is invalid" });
				if (badButtonData(markup))
					return reply(400, { ok: false, error_code: 400, description: "Bad Request: BUTTON_DATA_INVALID" });
				const silent = params.disable_notification === true ? { disable_notification: true as const } : {};
				const mode = parseMode === undefined ? {} : { parse_mode: parseMode };
				this.sent.push(
					markup === undefined
						? { ...message, ...mode, ...silent }
						: { ...message, reply_markup: markup, ...mode, ...silent },
				);
				const messageId = this.#nextMessage++;
				if (markup !== undefined) this.#markups.set(messageId, markup);
				return reply(200, { ok: true, result: { message_id: messageId, chat: { id: message.chat_id } } });
			}
			// Only the markdown form of InputRichMessage, which takes exactly one of html, markdown or blocks:
			// https://core.telegram.org/bots/api#inputrichmessage. Empty markdown is refused as sendMessage refuses empty
			// text; the docs give no minimum.
			if (method === "sendRichMessage") {
				const markup = params.reply_markup as InlineKeyboard | undefined;
				const rich = (params.rich_message ?? {}) as Record<string, unknown>;
				const forms = ["html", "markdown", "blocks"].filter((field) => field in rich);
				const markdown = rich.markdown;
				if (forms.length !== 1 || typeof markdown !== "string" || markdown === "" || [...markdown].length > RICH_LIMIT)
					return reply(400, { ok: false, error_code: 400, description: "Bad Request: rich message is invalid" });
				if (badButtonData(markup))
					return reply(400, { ok: false, error_code: 400, description: "Bad Request: BUTTON_DATA_INVALID" });
				const silent = params.disable_notification === true ? { disable_notification: true as const } : {};
				const message = { chat_id: params.chat_id as number, text: markdown, rich: true as const };
				this.sent.push(
					markup === undefined ? { ...message, ...silent } : { ...message, reply_markup: markup, ...silent },
				);
				const messageId = this.#nextMessage++;
				if (markup !== undefined) this.#markups.set(messageId, markup);
				return reply(200, { ok: true, result: { message_id: messageId, chat: { id: message.chat_id } } });
			}
			if (method === "answerCallbackQuery" || method === "editMessageReplyMarkup") {
				this.calls.push({ method, params });
				if (method === "editMessageReplyMarkup")
					this.#markups.set(params.message_id as number, params.reply_markup as InlineKeyboard);
				return reply(200, { ok: true, result: true });
			}
			if (method === "setMessageReaction") {
				const [reaction] = params.reaction as { emoji: string }[];
				this.reactions.push({ message_id: params.message_id as number, emoji: reaction?.emoji ?? "" });
				return reply(200, { ok: true, result: true });
			}
			// draft_id must be non-zero and text 0-4096 characters: https://core.telegram.org/bots/api#sendmessagedraft
			if (method === "sendMessageDraft") {
				const { chat_id, draft_id, text } = params;
				if (!Number.isInteger(draft_id) || draft_id === 0)
					return reply(400, { ok: false, error_code: 400, description: "Bad Request: invalid draft_id" });
				if (text !== undefined && (typeof text !== "string" || text.length > 4096))
					return reply(400, { ok: false, error_code: 400, description: "Bad Request: message text is invalid" });
				this.drafts.push({
					chat_id: chat_id as number,
					draft_id: draft_id as number,
					text: text as string | undefined,
				});
				return reply(200, { ok: true, result: true });
			}
			reply(404, { ok: false, error_code: 404, description: "Not Found" });
		});
		this.#server = server;
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	/** Queue a text message from `chatId` as a new update. */
	deliver(text: string, chatId: number): MessageUpdate {
		const update = {
			update_id: this.#nextUpdate++,
			message: { message_id: this.#nextMessage++, chat: { id: chatId }, text },
		};
		this.redeliver(update);
		return update;
	}

	/**
	 * Queue a press on the button carrying `data`, on the last message that shows it, as seen from `chatId`; or on message
	 * `messageId` whatever it shows now, as a client that has not yet seen the message's buttons change would press it.
	 */
	press(data: string, chatId: number, messageId?: number): CallbackUpdate {
		const shown =
			messageId === undefined
				? [...this.#markups].findLast(([, markup]) =>
						markup.inline_keyboard.flat().some((button) => button.callback_data === data),
					)
				: ([messageId, this.#markups.get(messageId)] as const);
		const update = {
			update_id: this.#nextUpdate++,
			callback_query: {
				id: `cb${this.#nextUpdate}`,
				data,
				message: { message_id: shown?.[0] ?? 0, chat: { id: chatId }, reply_markup: shown?.[1] },
			},
		};
		this.redeliver(update);
		return update;
	}

	redeliver(update: FakeUpdate): void {
		this.#queue.push(update);
		for (const wake of this.#wake) wake();
	}

	async close(): Promise<void> {
		for (const wake of this.#wake) wake();
		this.#server?.closeAllConnections();
		await new Promise((resolve) => this.#server?.close(resolve));
	}

	async #updates(params: Record<string, unknown>): Promise<FakeUpdate[]> {
		const offset = typeof params.offset === "number" ? params.offset : undefined;
		if (offset !== undefined) this.#queue = this.#queue.filter((update) => update.update_id >= offset);
		if (this.#queue.length === 0 && typeof params.timeout === "number" && params.timeout > 0) {
			await new Promise<void>((resolve) => {
				const wake = () => {
					clearTimeout(timer);
					this.#wake.delete(wake);
					resolve();
				};
				const timer = setTimeout(wake, (params.timeout as number) * 1000);
				this.#wake.add(wake);
			});
		}
		return [...this.#queue];
	}
}
