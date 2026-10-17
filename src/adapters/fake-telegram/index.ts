import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeUpdate {
	readonly update_id: number;
	readonly message: { readonly message_id: number; readonly chat: { readonly id: number }; readonly text: string };
}

export interface SentMessage {
	readonly chat_id: number;
	readonly text: string;
}

/**
 * A local stand-in for the Telegram Bot API (getUpdates long polling and sendMessage) for one bot token, so the
 * client runs over real HTTP without a bot. An update stays queued until a getUpdates offset above its id
 * confirms it, as Telegram does; `redeliver` puts one back, as Telegram does when a confirmation was lost.
 */
export class FakeBotApi {
	readonly sent: SentMessage[] = [];
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
			if (method === "getUpdates") return reply(200, { ok: true, result: await this.#updates(params) });
			if (method === "sendMessage") {
				const message = { chat_id: params.chat_id as number, text: params.text as string };
				if (typeof message.text !== "string" || message.text.length < 1 || message.text.length > 4096)
					return reply(400, { ok: false, error_code: 400, description: "Bad Request: message text is invalid" });
				this.sent.push(message);
				return reply(200, { ok: true, result: { message_id: this.#nextMessage++, chat: { id: message.chat_id } } });
			}
			reply(404, { ok: false, error_code: 404, description: "Not Found" });
		});
		this.#server = server;
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	/** Queue a text message from `chatId` as a new update. */
	deliver(text: string, chatId: number): FakeUpdate {
		const update = {
			update_id: this.#nextUpdate++,
			message: { message_id: this.#nextMessage++, chat: { id: chatId }, text },
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
