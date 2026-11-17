import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** One response of the stepped model, which the test writes piece by piece and then ends. */
export class SteppedReply {
	#stream: AssistantMessageEventStream | undefined;
	#message: AssistantMessage | undefined;
	#text: number | undefined;
	#thinking: number | undefined;
	#attach = () => {};
	readonly #attached = new Promise<void>((resolve) => {
		this.#attach = resolve;
	});

	/** The messages of the request this response answers, once it came. */
	messages: readonly Message[] | undefined;

	attach(
		stream: AssistantMessageEventStream,
		model: Model<string>,
		request: TranscriptContext,
		signal?: AbortSignal,
	): void {
		this.#stream = stream;
		this.messages = request.messages;
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: USAGE,
			stopReason: "stop",
			timestamp: Date.now(),
		};
		this.#message = message;
		stream.push({ type: "start", partial: message });
		// As a pi-ai provider ends a request its signal aborted: with the text so far and `stopReason: "aborted"`.
		const abort = () => {
			if (this.#stream === undefined) return;
			this.#stream = undefined;
			const error = { ...message, stopReason: "aborted" as const, errorMessage: "Request was aborted" };
			stream.push({ type: "error", reason: "aborted", error });
			stream.end(error);
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		this.#attach();
	}

	/** Whether the request's signal ended the response before the test did. */
	get aborted(): boolean {
		return this.messages !== undefined && this.#stream === undefined && !this.#ended;
	}
	#ended = false;

	/** Append `text` to the response's text, once its request came. */
	async write(text: string): Promise<void> {
		await this.#attached;
		const [stream, message] = [this.#stream, this.#message];
		if (stream === undefined || message === undefined) return;
		if (this.#text === undefined) {
			this.#text = message.content.push({ type: "text", text: "" }) - 1;
			stream.push({ type: "text_start", contentIndex: this.#text, partial: message });
		}
		const block = message.content[this.#text];
		if (block?.type === "text") block.text += text;
		stream.push({ type: "text_delta", contentIndex: this.#text, delta: text, partial: message });
	}

	/** Append `thinking` to the response's thinking, once its request came. */
	async think(thinking: string): Promise<void> {
		await this.#attached;
		const [stream, message] = [this.#stream, this.#message];
		if (stream === undefined || message === undefined) return;
		if (this.#thinking === undefined) {
			this.#thinking = message.content.push({ type: "thinking", thinking: "" }) - 1;
			stream.push({ type: "thinking_start", contentIndex: this.#thinking, partial: message });
		}
		const block = message.content[this.#thinking];
		if (block?.type === "thinking") block.thinking += thinking;
		stream.push({ type: "thinking_delta", contentIndex: this.#thinking, delta: thinking, partial: message });
	}

	/** End the response with a provider error, as a request that failed. */
	async fail(errorMessage: string): Promise<void> {
		await this.#attached;
		const [stream, message] = [this.#stream, this.#message];
		if (stream === undefined || message === undefined) return;
		this.#ended = true;
		this.#stream = undefined;
		const error = { ...message, stopReason: "error" as const, errorMessage };
		stream.push({ type: "error", reason: "error", error });
		stream.end(error);
	}

	/** End the response: an answer, or with `calls` a tool round. */
	async end(...calls: ToolCall[]): Promise<void> {
		await this.#attached;
		const [stream, message] = [this.#stream, this.#message];
		if (stream === undefined || message === undefined) return;
		if (this.#thinking !== undefined) {
			const block = message.content[this.#thinking];
			const content = block?.type === "thinking" ? block.thinking : "";
			stream.push({ type: "thinking_end", contentIndex: this.#thinking, content, partial: message });
		}
		if (this.#text !== undefined) {
			const block = message.content[this.#text];
			const content = block?.type === "text" ? block.text : "";
			stream.push({ type: "text_end", contentIndex: this.#text, content, partial: message });
		}
		for (const call of calls) {
			const contentIndex = message.content.push(call) - 1;
			stream.push({ type: "toolcall_start", contentIndex, partial: message });
			stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
		}
		const done = { ...message, stopReason: calls.length > 0 ? ("toolUse" as const) : ("stop" as const) };
		this.#ended = true;
		this.#stream = undefined;
		stream.push({ type: "done", reason: done.stopReason, message: done });
		stream.end(done);
	}
}

/**
 * A model, `stepped/stepped-1`, whose every response is a reply the test queued with `reply()` and writes in steps, so
 * a round's text grows when the test says. A request with no reply queued fails.
 */
export function steppedModel() {
	const queued: SteppedReply[] = [];
	const stream = (model: Model<string>, request: TranscriptContext, options?: { signal?: AbortSignal }) => {
		const events = createAssistantMessageEventStream();
		const reply = queued.shift();
		if (reply === undefined) {
			const error = {
				role: "assistant" as const,
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: USAGE,
				stopReason: "error" as const,
				errorMessage: "no stepped reply queued",
				timestamp: Date.now(),
			};
			queueMicrotask(() => {
				events.push({ type: "error", reason: "error", error });
				events.end(error);
			});
		} else queueMicrotask(() => reply.attach(events, model, request, options?.signal));
		return events;
	};
	const provider = createProvider({
		id: "stepped",
		auth: { apiKey: { name: "Stepped", resolve: async () => ({ auth: {} }) } },
		models: [
			{
				id: "stepped-1",
				name: "stepped-1",
				api: "stepped",
				provider: "stepped",
				baseUrl: "http://localhost",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			},
		],
		api: { stream, streamSimple: stream },
	});
	const models = createModels();
	models.setProvider(provider);
	return {
		models,
		model: { provider: "stepped", modelId: "stepped-1" },
		/** Queue the next response. */
		reply(): SteppedReply {
			const reply = new SteppedReply();
			queued.push(reply);
			return reply;
		},
	};
}
