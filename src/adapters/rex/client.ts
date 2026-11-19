// The control connection to a rex server (GET /llms.txt, "The Control Connection"): one WebSocket, a hello naming
// API revision 7, then requests matched to responses by id and events pushed in between.
import { join } from "node:path";
import type { ZodType } from "zod";
import {
	API_REVISION,
	AttachResultSchema,
	CONTROL_PROTOCOL,
	EventSchema,
	ResponseSchema,
	type SessionEvent,
	SessionEventSchema,
	WelcomeSchema,
} from "./schema.ts";
import { type OpenWebSocket, openWebSocket, type WebSocketConnection } from "./websocket.ts";

export function defaultRexSocket(home: string): string {
	return join(home, "Library/Application Support/rex/server.sock");
}

/** The server answered a request with an error; `code` is what to branch on, per the API's error table. */
export class RexRpcError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(method: string, code: string, message: string, status: number) {
		super(`${method}: ${code}: ${message}`);
		this.name = "RexRpcError";
		this.code = code;
		this.status = status;
	}
}

/** The connection failed or dropped; a request in flight may or may not have run. */
export class RexTransportError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "RexTransportError";
	}
}

export interface RexClientOptions {
	readonly socketPath: string;
	/** DI seam: how the WebSocket is opened. */
	readonly open?: OpenWebSocket;
	readonly requestTimeoutMs?: number;
	/** The first pause before reconnecting; it doubles up to 30 s while the server stays away. */
	readonly reconnectMs?: number;
	readonly onError?: (error: Error) => void;
}

export interface CallOptions {
	/** Awaited once the connection is ready, right before the request goes out; one that throws sends nothing. */
	readonly sending?: () => Promise<void>;
}

export interface RexClient {
	call<T>(method: string, payload: unknown, schema: ZodType<T>, options?: CallOptions): Promise<T>;
	/**
	 * Attaches this and every later connection to the session, so its methods work and its events arrive, until rex says
	 * the session does not exist.
	 */
	attach(sessionId: string): Promise<void>;
	/** While any listener is registered, a dropped connection is opened again. */
	onSessionEvent(listener: (event: SessionEvent) => void): () => void;
	/** Called each time a connection is ready and attached, the first one included: events in a gap are lost. */
	onConnected(listener: () => void): () => void;
	close(): void;
}

type Pending = { method: string; resolve(payload: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
type Connection = { ws: WebSocketConnection; pending: Map<string, Pending>; attached: Set<string> };

const HELLO_TIMEOUT_MS = 5_000;
const MAX_RECONNECT_MS = 30_000;

export function createRexClient(options: RexClientOptions): RexClient {
	const open = options.open ?? openWebSocket;
	const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
	const firstPause = options.reconnectMs ?? 1_000;
	const onError = options.onError ?? ((error: Error) => console.warn(`[rex] ${error.message}`));
	const sessions = new Set<string>();
	const eventListeners = new Set<(event: SessionEvent) => void>();
	const connectedListeners = new Set<() => void>();
	let connection: Promise<Connection> | undefined;
	let nextId = 0;
	let pause = firstPause;
	let retry: NodeJS.Timeout | undefined;
	let closed = false;

	// A connection only keeps the process alive while it waits on an answer.
	const settle = (conn: Connection) => (conn.pending.size > 0 ? conn.ws.ref() : conn.ws.unref());

	function send(conn: Connection, method: string, payload: unknown): Promise<unknown> {
		const id = String(++nextId);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				conn.pending.delete(id);
				settle(conn);
				reject(new RexTransportError(`${method}: no response within ${requestTimeoutMs} ms`));
			}, requestTimeoutMs);
			conn.pending.set(id, { method, resolve, reject, timer });
			settle(conn);
			try {
				conn.ws.send(JSON.stringify({ type: "request", id, method, payload }));
			} catch (error) {
				clearTimeout(timer);
				conn.pending.delete(id);
				settle(conn);
				reject(new RexTransportError(`${method}: ${(error as Error).message}`, { cause: error }));
			}
		});
	}

	async function connect(): Promise<Connection> {
		let welcomed: (message: unknown) => void = () => {};
		let failed: (error: Error) => void = () => {};
		const welcome = new Promise<unknown>((resolve, reject) => {
			welcomed = resolve;
			failed = reject;
		});
		let conn: Connection | undefined;
		// Frames of one chunk are handled in one go, so a close can come right behind the welcome or an attach's answer,
		// while `conn` is not set or not handed out yet; a connection closed by then is not handed out.
		let lost: Error | undefined;
		const ws = await open(
			{ socketPath: options.socketPath, path: "/api/control", protocol: CONTROL_PROTOCOL },
			{
				onMessage(text) {
					let message: unknown;
					try {
						message = JSON.parse(text);
					} catch {
						onError(new Error(`rex sent a message that is not JSON: ${text.slice(0, 200)}`));
						return;
					}
					if (conn === undefined) welcomed(message);
					else receive(conn, message);
				},
				onClose(error) {
					const reason = new RexTransportError(`rex connection closed${error ? `: ${error.message}` : ""}`, {
						cause: error,
					});
					lost = reason;
					failed(reason);
					if (conn !== undefined) dropped(conn, reason);
				},
			},
		);
		ws.ref();
		const timer = setTimeout(() => failed(new RexTransportError("rex sent no welcome")), HELLO_TIMEOUT_MS);
		try {
			ws.send(JSON.stringify({ type: "hello", api_revision: API_REVISION, client: { kind: "agent", name: "soma" } }));
			const parsed = WelcomeSchema.safeParse(await welcome);
			if (!parsed.success) throw new RexTransportError(`rex sent no welcome: ${parsed.error.message}`);
			if (parsed.data.api_revision !== API_REVISION) {
				throw new RexTransportError(`rex speaks API revision ${parsed.data.api_revision}, soma needs ${API_REVISION}`);
			}
		} catch (error) {
			ws.close();
			throw error;
		} finally {
			clearTimeout(timer);
		}
		conn = { ws, pending: new Map(), attached: new Set() };
		const ready = conn;
		try {
			for (const sessionId of sessions) await attachOn(ready, sessionId).catch(forgetGone(sessionId));
			if (lost !== undefined) throw lost;
		} catch (error) {
			ws.close();
			throw error;
		}
		settle(ready);
		pause = firstPause;
		queueMicrotask(() => {
			for (const listener of connectedListeners) listener();
		});
		return ready;
	}

	function receive(conn: Connection, message: unknown): void {
		const type = (message as { type?: unknown } | null)?.type;
		if (type === "response") {
			const parsed = ResponseSchema.safeParse(message);
			if (!parsed.success) {
				onError(new Error(`rex sent a malformed response: ${parsed.error.message}`));
				return;
			}
			const { id, payload, error } = parsed.data;
			const waiting = conn.pending.get(id);
			if (waiting === undefined) return;
			conn.pending.delete(id);
			clearTimeout(waiting.timer);
			settle(conn);
			if (error) waiting.reject(new RexRpcError(waiting.method, error.code, error.message, error.status));
			else waiting.resolve(payload ?? {});
			return;
		}
		if (type !== "event") return;
		const event = EventSchema.safeParse(message);
		if (!event.success || event.data.payload.type !== "session_event") return;
		const inner = SessionEventSchema.safeParse(event.data.payload.payload);
		if (!inner.success) {
			onError(new Error(`rex sent a malformed session event: ${inner.error.message}`));
			return;
		}
		for (const listener of eventListeners) listener(inner.data);
	}

	function dropped(conn: Connection, reason: Error): void {
		for (const waiting of conn.pending.values()) {
			clearTimeout(waiting.timer);
			waiting.reject(reason);
		}
		conn.pending.clear();
		connection = undefined;
		if (!closed && eventListeners.size > 0) {
			onError(reason);
			schedule();
		}
	}

	function schedule(): void {
		if (retry !== undefined || closed) return;
		retry = setTimeout(() => {
			retry = undefined;
			if (eventListeners.size === 0 || connection !== undefined) return;
			void ensure().catch(onError);
		}, pause);
		pause = Math.min(pause * 2, MAX_RECONNECT_MS);
		// Reconnecting must never be the reason a process stays alive.
		retry.unref();
	}

	function ensure(): Promise<Connection> {
		if (closed) return Promise.reject(new RexTransportError("rex client is closed"));
		if (connection === undefined) {
			const opening = connect();
			connection = opening;
			opening.catch(() => {
				if (connection === opening) connection = undefined;
				// Somebody waits on events, so a server that is away is tried again.
				if (eventListeners.size > 0) schedule();
			});
		}
		return connection;
	}

	async function attachOn(conn: Connection, sessionId: string): Promise<void> {
		if (conn.attached.has(sessionId)) return;
		const result = await send(conn, "session.attach", { session_id: sessionId });
		AttachResultSchema.parse(result);
		conn.attached.add(sessionId);
	}

	/**
	 * A session rex says does not exist is attached no more, on this connection or a later one: rex does not remember
	 * destroyed sessions, so it never will, and attaching it again would fail every connection opened from then on.
	 */
	const forgetGone = (sessionId: string) => (error: Error) => {
		if (error instanceof RexRpcError && error.code === "session_not_found") sessions.delete(sessionId);
		else throw error;
	};

	return {
		async call<T>(method: string, payload: unknown, schema: ZodType<T>, options?: CallOptions): Promise<T> {
			const conn = await ensure();
			await options?.sending?.();
			return schema.parse(await send(conn, method, payload));
		},

		async attach(sessionId: string): Promise<void> {
			// Added once the connection is open, so a first connection does not attach it ahead of this call.
			const conn = await ensure();
			sessions.add(sessionId);
			await attachOn(conn, sessionId).catch((error: Error) => {
				forgetGone(sessionId)(error);
				throw error;
			});
		},

		onSessionEvent(listener) {
			eventListeners.add(listener);
			return () => {
				eventListeners.delete(listener);
			};
		},

		onConnected(listener) {
			connectedListeners.add(listener);
			return () => {
				connectedListeners.delete(listener);
			};
		},

		close() {
			closed = true;
			if (retry !== undefined) clearTimeout(retry);
			void connection?.then(
				(conn) => conn.ws.close(),
				() => {},
			);
			connection = undefined;
		},
	};
}
