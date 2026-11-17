import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { Answer } from "../../ports/agent.ts";
import {
	type Choices,
	type Delivery,
	deliveryTo,
	type HumanAnswerOutcome,
	type HumanPort,
	isPrompt,
	type NoticeKind,
	type SaidOutcome,
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
	readonly draftRefreshMs?: number;
	readonly draftLimitMs?: number;
	/** The least time between two draft calls of one round. */
	readonly draftIntervalMs?: number;
	/** The clock a round's drafts and a message's wait for flood control are timed by, `Date.now` by default. */
	readonly now?: () => number;
	/** Runs `run` in `ms` on that clock and returns what cancels it; `setTimeout` by default. */
	readonly setTimer?: (run: () => void, ms: number) => () => void;
	readonly onError?: (error: unknown) => void;
}

const REQUEST_PREFIX = "telegram:";
/** The entry kind of this client's inputs, by which the core says what this chat does with each push. */
export const ENTRY_KIND = "chat.telegram";
// sendMessage takes 1-4096 characters; JavaScript string length counts the same UTF-16 units.
export const MESSAGE_LIMIT = 4096;
// sendRichMessage takes up to 32768 UTF-8 characters; counting bytes keeps a text with wide characters under it too.
// https://core.telegram.org/bots/api#rich-message-formatting-options
const RICH_LIMIT = 32768;
/** What this chat shows of what the model writes, told to the model in the system prompt. */
export const ABILITIES = [
	"Telegram（人的手機）：markdown 照你寫的原樣送出，Telegram 顯示成格式（GitHub Flavored Markdown）：標題、表格、清單、程式碼區塊、引用、連結，以及可折疊的 `<details><summary>摘要</summary>…</details>` 區段。",
	"長的細節放進收合的 `<details>` 區段，上面只留一行摘要，讓人在手機上先看到短的回答。",
	"你用 `ask` 問的問題，選項會顯示成訊息下的按鈕，人按一個就是回答。",
	`超過 ${RICH_LIMIT} 位元組（UTF-8，中文一字約 3 位元組）的訊息改送分段的簡單格式：標題變粗體、表格變等寬文字，\`<details>\` 只顯示成原始文字，不會收合。Telegram 拒收的訊息也改用這種簡單格式重送。Telegram 說明的上限另有 500 個區塊、表格 20 欄。`,
].join("\n");
const EMPTY_ANSWER = "（這一輪沒有文字回答）";
// What Telegram answers a message whose entities it cannot place: https://core.telegram.org/bots/api#formatting-options
const ENTITY_REFUSAL = /can't parse entities|can't find end tag|unsupported start tag|entity/i;

// The one reaction a message from the human carries, replaced as the round moves on; a bot without premium gets one.
// Each is in ReactionTypeEmoji's list: https://core.telegram.org/bots/api#reactiontypeemoji
const REACTIONS = { received: "👀", forwarded: "👌", answered: "👍", failed: "👎" } as const;
// An empty draft shows "Thinking…" for 30 seconds, so it is sent again before it goes: https://core.telegram.org/bots/api#sendmessagedraft
const DRAFT_REFRESH_MS = 20_000;
// A round whose answer or failure never comes, such as a message delivered again after a restart, stops showing it.
const DRAFT_LIMIT_MS = 10 * 60_000;
// The answer's text as it grows goes at most once a second per round, the newest text first. The only figure Telegram
// gives is about one message per second per chat: https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this
const DRAFT_INTERVAL_MS = 1_000;
// A draft may hold half-written markdown, such as an open fence or a table in progress, that Telegram might refuse while
// the next text is fine: text drafts stop for the round only after this many refusals in a row.
const DRAFT_REFUSALS = 3;
// A message flood control refuses is tried again after its retry_after, this many times and waiting this long in all at
// most, before it goes the way of any other refusal. A draft waits this long at most too: a longer retry_after stops
// the round's text drafts, and a timer that long would overflow and fire at once.
const SEND_RETRIES = 2;
const FLOOD_WAIT_MS = 60_000;

// callback_data takes 1-64 bytes: https://core.telegram.org/bots/api#inlinekeyboardbutton
const CALLBACK_DATA_LIMIT = 64;
// The one button that replaces a settled keyboard is disabled, so it does nothing when pressed:
// https://core.telegram.org/bots/api#inlinekeyboardbutton. Older messages carry one with the data "-" instead,
// which names no answer, so a press on it only gets answered.
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
	z
		.object({
			ok: z.literal(false),
			description: z.string().optional(),
			parameters: z.object({ retry_after: z.number().optional() }).passthrough().optional(),
		})
		.passthrough(),
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

/**
 * A call the Bot API answered with `ok: false`, as opposed to one that never got an answer. `retryAfter`: flood
 * control's seconds to wait before the next call: https://core.telegram.org/bots/api#responseparameters
 */
class Refused extends Error {
	readonly retryAfter: number | undefined;
	constructor(message: string, retryAfter?: number) {
		super(message);
		this.retryAfter = retryAfter;
	}
}

const REFUSALS: Record<Extract<HumanAnswerOutcome, { sent: false }>["refusal"], string> = {
	not_blocked: "agent 已經不在等回答",
	stale: "提示已經變了",
	unknown_option: "沒有這個選項",
	auth: "憑證要你親自處理",
	unreadable: "畫面讀不出選項，或游標停不到選項上，可以再按一次",
	no_job: "派工清單裡沒有這張卡片",
};

const PRESS_FAILED = "未送出：出錯了，可以再按一次";
// answerCallbackQuery takes a text of 0-200 characters: https://core.telegram.org/bots/api#answercallbackquery
const CALLBACK_TEXT_LIMIT = 200;
/** A press the agent side refused for `reason`, which may be pressed again; the reason is cut to fit. */
function unsentText(reason: string): string {
	const [head, tail] = ["未送出：", "，可以再按一次"];
	const words = [...reason.trim()];
	if (words.length === 0) return PRESS_FAILED;
	const room = CALLBACK_TEXT_LIMIT - head.length - tail.length;
	return head + (words.length <= room ? words.join("") : `${words.slice(0, room - 1).join("")}…`) + tail;
}
// A respond that throws may have sent the keys already, and where a fingerprint is the prompt's content a later
// identical prompt carries the same one, so a second press could answer that prompt: this text does not offer one.
const PRESS_UNKNOWN = "不確定有沒有送出：出錯了，請到 agent 的畫面確認";

const SAID_REFUSALS: Record<
	Exclude<Extract<SaidOutcome, { said: false }>["refusal"], "settled" | "unsure" | "unsent">,
	string
> = {
	no_question: "找不到這個問題",
	unknown_option: "沒有這個選項",
	not_waiting: "agent 已經不在等這個回答",
};

// A card name is kebab-case and a fingerprint hex, so neither holds the separator.
const callbackData = (card: string, { option, fingerprint }: Answer) => `${option}:${fingerprint}:${card}`;

function parseCallbackData(data: string | undefined): { card: string; answer: Answer } | undefined {
	const [option, fingerprint, card, ...rest] = data?.split(":") ?? [];
	if (!option || !fingerprint || !card || rest.length > 0) return undefined;
	return { card, answer: { option, fingerprint } };
}

// A question soma asked: `ask/<question>/<option>`. It holds no ':', so it never reads as a prompt's data.
const SAID_PREFIX = "ask/";
const saidData = (question: string, option: string) => `${SAID_PREFIX}${question}/${option}`;

function parseSaidData(data: string | undefined): { question: string; option: string } | undefined {
	if (!data?.startsWith(SAID_PREFIX) || data.includes(":")) return undefined;
	const [question, option, ...rest] = data.slice(SAID_PREFIX.length).split("/");
	if (!question || !option || rest.length > 0) return undefined;
	return { question, option };
}

/** One button per option, or none when a button's data would not fit: a cut card name would answer another job. */
function keyboard(choices: Choices) {
	const data = isPrompt(choices)
		? (id: string) => callbackData(choices.card, { option: id, fingerprint: choices.fingerprint })
		: (id: string) => saidData(choices.question, id);
	const rows = choices.options.map(({ id, label }) => [{ text: label, callback_data: data(id) }]);
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
	const call = async (method: string, body: object, callSignal = signal): Promise<unknown> => {
		const response = await fetch(`${options.apiBase}/bot${options.token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: callSignal,
		});
		const parsed = ResponseSchema.parse(await response.json());
		if (!parsed.ok)
			throw new Refused(`${method}: ${parsed.description ?? response.status}`, parsed.parameters?.retry_after);
		return parsed.result;
	};

	// A second tap arrives before the first press's edit hides the buttons; its refusal must not replace the result.
	// A message whose buttons were taken away as answered elsewhere is settled too.
	const settled = new Set<number>();
	// By message, the presses still in flight and what an event settled each message with meanwhile: the event leaves
	// the message to the press, and a press that then fails shows that instead of offering its buttons again.
	const pressing = new Map<number, string | undefined>();
	// By card and fingerprint, the messages here showing that prompt's buttons; lost on a restart.
	const shown = new Map<string, { card: string; fingerprint: string; messageIds: number[] }>();
	// By question, the messages here showing the options of a question soma asked; lost on a restart.
	const asked = new Map<string, number[]>();
	const now = options.now ?? Date.now;
	const setTimer =
		options.setTimer ??
		((run: () => void, ms: number) => {
			const timer = setTimeout(run, ms);
			return () => clearTimeout(timer);
		});
	// Ends early once `signal` aborts.
	const pause = (ms: number) =>
		new Promise<void>((resolve) => {
			let cancel = () => {};
			const done = () => {
				cancel();
				signal.removeEventListener("abort", done);
				resolve();
			};
			signal.addEventListener("abort", done);
			cancel = setTimer(done, ms);
		});
	// A message call flood control refuses waits its retry_after and goes again, within SEND_RETRIES and FLOOD_WAIT_MS;
	// each such refusal is reported. Past them it throws as any refusal.
	const patiently = async (method: string, body: object): Promise<unknown> => {
		let waited = 0;
		for (let retries = 0; ; retries++) {
			try {
				return await call(method, body);
			} catch (error) {
				if (!(error instanceof Refused) || error.retryAfter === undefined || signal.aborted) throw error;
				const wait = error.retryAfter * 1000;
				if (retries >= SEND_RETRIES || waited + wait > FLOOD_WAIT_MS) throw error;
				onError(error);
				waited += wait;
				await pause(wait);
			}
		}
	};
	// A part Telegram refuses for its entities goes again as the text it shows, so formatting never loses a message.
	const sendPart = async (html: string, extra: object): Promise<unknown> => {
		try {
			return await patiently("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", ...extra });
		} catch (error) {
			if (!(error instanceof Error) || !ENTITY_REFUSAL.test(error.message)) throw error;
			return patiently("sendMessage", { chat_id: chatId, text: htmlToPlain(html), ...extra });
		}
	};
	// One at a time, so a long answer's parts and the messages after it arrive in order, a wait for flood control included.
	let sending = Promise.resolve();
	const send = (
		text: string,
		markup?: object,
		{ silent = false, prompt }: { silent?: boolean; prompt?: Choices } = {},
	) => {
		sending = sending.then(async () => {
			// The message that carries the keyboard, whichever way it went.
			const show = (sent: unknown) => {
				const messageId = (sent as { message_id?: unknown }).message_id;
				if (prompt === undefined || typeof messageId !== "number") return;
				if (!isPrompt(prompt)) {
					asked.set(prompt.question, [...(asked.get(prompt.question) ?? []), messageId]);
					return;
				}
				const key = `${prompt.card}\n${prompt.fingerprint}`;
				const entry = shown.get(key) ?? { card: prompt.card, fingerprint: prompt.fingerprint, messageIds: [] };
				entry.messageIds.push(messageId);
				shown.set(key, entry);
			};
			// One rich message shows the markdown as written, tables and headings included. A text too long for one, or
			// one Telegram refuses, goes as HTML parts, so formatting never loses a message; a refusal is still reported.
			const markdown = text.trim() === "" ? EMPTY_ANSWER : text;
			if (Buffer.byteLength(markdown) <= RICH_LIMIT) {
				try {
					return show(
						await patiently("sendRichMessage", {
							chat_id: chatId,
							rich_message: { markdown },
							...(markup !== undefined ? { reply_markup: markup } : {}),
							...(silent ? { disable_notification: true } : {}),
						}),
					);
				} catch (error) {
					if (!signal.aborted) onError(error);
					if (!(error instanceof Refused)) return;
				}
			}
			const parts = messageParts(text);
			for (const [index, part] of parts.entries()) {
				const last = index === parts.length - 1 && markup !== undefined;
				try {
					const sent = await sendPart(part, {
						...(last ? { reply_markup: markup } : {}),
						...(silent ? { disable_notification: true } : {}),
					});
					if (last) show(sent);
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
	// What an event puts in place of the buttons of each message here it settles.
	const settleShown = async (messageIds: number[], text: string) => {
		for (const messageId of messageIds) {
			if (pressing.has(messageId)) pressing.set(messageId, text);
			if (settled.has(messageId)) continue;
			settled.add(messageId);
			await quietly("editMessageReplyMarkup", {
				chat_id: chatId,
				message_id: messageId,
				reply_markup: { inline_keyboard: [[{ text, disabled: {} }]] },
			});
		}
	};
	// One at a time, so a later stage's reaction is the one that stays.
	let reacting = Promise.resolve();
	// A press's round has no message from the human to react on.
	const react = (requestId: string, stage: keyof typeof REACTIONS) => {
		const messageId = Number(requestId.slice(REQUEST_PREFIX.length));
		if (!Number.isInteger(messageId)) return;
		const body = {
			chat_id: chatId,
			message_id: messageId,
			reaction: [{ type: "emoji", emoji: REACTIONS[stage] }],
		};
		reacting = reacting.then(() => quietly("setMessageReaction", body).then(() => {}));
	};
	// The draft of each round from this chat still open, by requestId; lost on a restart. The entry is made before the
	// input is submitted, so an answer that comes before the submit resolves still ends it.
	type Drafting = {
		/** The message the draft is shown under, once the core has admitted the input. */
		messageId?: number;
		refresh?: ReturnType<typeof setInterval>;
		/** What the draft shows: the newest text of the answer that fits a draft; one empty after trimming is "Thinking…". */
		text: string;
		/** What the last draft taken showed, which the draft keeps when a text is refused. */
		taken: string;
		/** Text drafts refused since the last draft taken, and whether one was reported for the round. */
		refusals: number;
		reported: boolean;
		/**
		 * `DRAFT_REFUSALS` text drafts were refused in a row, or flood control asked for more than `FLOOD_WAIT_MS`: the
		 * round shows only "Thinking…" from then on.
		 */
		refused: boolean;
		/** When its last draft call went, and the call waiting for the interval to pass. */
		last: number;
		waiting?: () => void;
		/** What aborts the draft call in flight, and whether one is wanted once it ends. */
		flight?: AbortController;
		again: boolean;
		closed: boolean;
	};
	const drafts = new Map<string, Drafting>();
	const interval = options.draftIntervalMs ?? DRAFT_INTERVAL_MS;
	// Flood control's wait, which every draft of this chat keeps; the messages do not.
	let floodUntil = Number.NEGATIVE_INFINITY;
	/**
	 * Sends what the round's draft shows, once the interval since its last call has passed and that call has ended: a
	 * text in the markdown the answer goes in, or the "Thinking…" placeholder. One call of a round at a time, so an older
	 * text never lands after a newer one; the round's close aborts it and its outcome is ignored. Never on the `sending`
	 * queue, so a draft neither waits for a message nor holds one back. A call after `signal` aborts is never sent: fetch
	 * takes the signal.
	 */
	const show = (round: Drafting) => {
		if (round.closed || round.waiting !== undefined || round.messageId === undefined) return;
		if (round.flight !== undefined) {
			round.again = true;
			return;
		}
		const wait = Math.max(round.last + interval, floodUntil) - now();
		if (wait > 0) {
			round.waiting = setTimer(() => {
				round.waiting = undefined;
				show(round);
			}, wait);
			return;
		}
		round.last = now();
		const { text } = round;
		const rich = text.trim() !== "";
		const body = { chat_id: chatId, draft_id: round.messageId };
		const flight = new AbortController();
		round.flight = flight;
		const callSignal = AbortSignal.any([signal, flight.signal]);
		const sent = rich
			? call("sendRichMessageDraft", { ...body, rich_message: { markdown: text } }, callSignal)
			: call("sendMessageDraft", { ...body, text: "" }, callSignal);
		sent
			.then(
				() => {
					if (round.closed) return;
					round.taken = rich ? text : "";
					round.refusals = 0;
				},
				(error: unknown) => {
					if (signal.aborted || round.closed) return;
					if (error instanceof Refused && error.retryAfter !== undefined) {
						onError(error);
						const wait = error.retryAfter * 1000;
						floodUntil = Math.max(floodUntil, now() + Math.min(wait, FLOOD_WAIT_MS));
						if (wait > FLOOD_WAIT_MS) {
							round.refused = true;
							round.text = "";
						}
						round.again = true;
					} else if (error instanceof Refused && rich) {
						// Reported once a round and skipped: the draft keeps what it showed, and the next text goes.
						if (!round.reported) onError(error);
						round.reported = true;
						round.refusals += 1;
						if (round.refusals >= DRAFT_REFUSALS) {
							round.refused = true;
							round.text = "";
						} else if (round.text === text) round.text = round.taken;
					} else onError(error);
				},
			)
			.then(() => {
				round.flight = undefined;
				if (!round.again) return;
				round.again = false;
				show(round);
			});
	};
	const think = (requestId: string, messageId: number) => {
		const round = drafts.get(requestId);
		if (round === undefined || round.messageId !== undefined) return;
		round.messageId = messageId;
		show(round);
		const until = now() + (options.draftLimitMs ?? DRAFT_LIMIT_MS);
		const refresh = () => (now() > until ? settle(requestId) : show(round));
		round.refresh = setInterval(refresh, options.draftRefreshMs ?? DRAFT_REFRESH_MS);
	};
	// A text longer than one rich message stops the updates, and the draft keeps the last text that fit.
	const stream = (requestId: string, text: string) => {
		const round = drafts.get(requestId);
		if (round === undefined || round.refused || text === round.text || Buffer.byteLength(text) > RICH_LIMIT) return;
		round.text = text;
		show(round);
	};
	const open = (requestId: string) => {
		if (!drafts.has(requestId))
			drafts.set(requestId, {
				text: "",
				taken: "",
				refusals: 0,
				reported: false,
				refused: false,
				last: Number.NEGATIVE_INFINITY,
				again: false,
				closed: false,
			});
	};
	const close = (round: Drafting) => {
		round.closed = true;
		clearInterval(round.refresh);
		round.waiting?.();
		round.flight?.abort();
	};
	const settle = (requestId: string) => {
		const round = drafts.get(requestId);
		if (round !== undefined) close(round);
		drafts.delete(requestId);
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
		} else if (event.type === "said") {
			// Pressed here or elsewhere: every message here offering that question shows the choice. Queued behind the
			// sends, so it sees them.
			const { question } = event;
			sending = sending.then(async () => {
				const messageIds = asked.get(question) ?? [];
				asked.delete(question);
				await settleShown(messageIds, `已選：${event.label}`);
			});
		} else if (event.type === "job") {
			// Answered elsewhere: the prompt is no longer on the job's screen. Queued behind the sends, so it sees them.
			const { card, status } = event;
			sending = sending.then(async () => {
				for (const [key, prompt] of shown) {
					if (prompt.card !== card) continue;
					if (status.state === "blocked" && status.fingerprint === prompt.fingerprint) continue;
					shown.delete(key);
					await settleShown(prompt.messageIds, ELSEWHERE);
				}
			});
		} else if (event.type === "partial") {
			for (const requestId of event.requestIds)
				if (requestId.startsWith(REQUEST_PREFIX)) stream(requestId, event.content);
		} else if (event.type === "answer") {
			if (mine) {
				settle(event.requestId);
				react(event.requestId, "answered");
				// A round that asked a question rang with it, and the question is the reply: an answer with no text sends
				// nothing, not the placeholder, and one with text goes without a sound.
				if (event.asked === undefined) send(event.content);
				else if (event.content.trim() !== "") send(event.content, undefined, { silent: true });
			} else if (event.class !== undefined) push(label("report", event.content), deliveryTo(event, ENTRY_KIND));
		} else if (event.type === "failure") {
			if (mine) {
				settle(event.requestId);
				react(event.requestId, "failed");
				send(`[失敗] ${event.reason}`);
			} else if (event.class !== undefined)
				push(`[失敗] ${event.requestId} 那一輪：${event.reason}`, deliveryTo(event, ENTRY_KIND));
		}
	});
	type CallbackQuery = NonNullable<z.infer<typeof UpdateSchema>["callback_query"]>;
	const settleOn = async (query: CallbackQuery, messageId: number, result: string) => {
		await quietly("answerCallbackQuery", { callback_query_id: query.id, text: result });
		await quietly("editMessageReplyMarkup", {
			chat_id: chatId,
			message_id: messageId,
			reply_markup: { inline_keyboard: [[{ text: result, disabled: {} }]] },
		});
	};
	// A press that can be made again: its buttons stay, unless an event settled the message while it was in flight.
	const reopen = async (query: CallbackQuery, messageId: number, text: string) => {
		const meanwhile = pressing.get(messageId);
		if (meanwhile !== undefined) return settleOn(query, messageId, meanwhile);
		settled.delete(messageId);
		await quietly("answerCallbackQuery", { callback_query_id: query.id, text });
	};
	// The human said an option of a question soma asked: their input, which starts a round as a typed message does.
	// One request id per question, so a press Telegram delivers again after a restart is admitted once. An option a
	// job's agent listed goes to that agent instead, and starts no round here.
	const sayPress = async (query: CallbackQuery, messageId: number, pressed: { question: string; option: string }) => {
		const requestId = `${REQUEST_PREFIX}${SAID_PREFIX}${pressed.question}`;
		open(requestId);
		const outcome = await human.say(pressed.question, pressed.option, {
			entry: { kind: ENTRY_KIND, data: { pressed: messageId } },
			requestId,
		});
		if (outcome.said && outcome.job === undefined) think(requestId, messageId);
		else settle(requestId);
		if (!outcome.said && outcome.refusal === "unsent") return reopen(query, messageId, unsentText(outcome.reason));
		const result =
			outcome.said || outcome.refusal === "settled"
				? `已選：${outcome.label}`
				: outcome.refusal === "unsure"
					? PRESS_UNKNOWN
					: `未送出：${SAID_REFUSALS[outcome.refusal]}`;
		await settleOn(query, messageId, result);
	};
	const answerPress = async (query: CallbackQuery, message: NonNullable<CallbackQuery["message"]>) => {
		const said = parseSaidData(query.data);
		const pressed = parseCallbackData(query.data);
		if ((said === undefined && pressed === undefined) || settled.has(message.message_id))
			return quietly("answerCallbackQuery", { callback_query_id: query.id });
		settled.add(message.message_id);
		pressing.set(message.message_id, undefined);
		try {
			if (said !== undefined) return await sayPress(query, message.message_id, said);
			if (pressed === undefined) return;
			const outcome = await human.respond(pressed.card, pressed.answer);
			const button = message.reply_markup?.inline_keyboard.flat().find((each) => each.callback_data === query.data);
			const result = outcome.sent
				? `已選：${button?.text ?? pressed.answer.option}`
				: `未送出：${REFUSALS[outcome.refusal]}`;
			await settleOn(query, message.message_id, result);
		} catch (error) {
			// Thrown back to the poll loop, the press would never be confirmed and every update after it would wait. It is
			// reported and answered instead.
			if (!signal.aborted) onError(error);
			// A respond can throw after the keys went, so the message stays settled and says the outcome is unknown.
			if (said === undefined) await settleOn(query, message.message_id, PRESS_UNKNOWN);
			// say is idempotent through the questions doc, so its buttons stay and the human can press again.
			else await reopen(query, message.message_id, PRESS_FAILED);
		} finally {
			pressing.delete(message.message_id);
		}
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
						open(requestId);
						await human.submit({
							content: message.text,
							entry: { kind: ENTRY_KIND, data: { messageId: message.message_id } },
							requestId,
						});
						react(requestId, "received");
						think(requestId, message.message_id);
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
		for (const round of drafts.values()) close(round);
		await Promise.all([sending, reacting]);
	}
}
