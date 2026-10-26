// A WebSocket client over a unix socket, from node:http alone (RFC 6455): rex serves its control API there, and the
// adapter takes no dependency beyond node built-ins. Text and control frames only; no extensions are offered, so the
// server sends nothing compressed.
import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import type { Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OPCODE = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

export type Frame = { readonly fin: boolean; readonly opcode: number; readonly payload: Buffer };

/** One frame; a client masks every frame it sends, a server none. */
export function encodeFrame(opcode: number, payload: Buffer, masked: boolean): Buffer {
	const length = payload.length;
	const extended = length < 126 ? 0 : length < 0x10000 ? 2 : 8;
	const head = Buffer.alloc(2 + extended + (masked ? 4 : 0));
	head[0] = 0x80 | opcode;
	head[1] = (masked ? 0x80 : 0) | (extended === 0 ? length : extended === 2 ? 126 : 127);
	if (extended === 2) head.writeUInt16BE(length, 2);
	if (extended === 8) head.writeBigUInt64BE(BigInt(length), 2);
	if (!masked) return Buffer.concat([head, payload]);
	const mask = randomBytes(4);
	mask.copy(head, 2 + extended);
	const body = Buffer.from(payload);
	for (let i = 0; i < body.length; i++) body[i] = (body[i] as number) ^ (mask[i % 4] as number);
	return Buffer.concat([head, body]);
}

/** Splits a byte stream into frames; bytes of a frame not complete yet are kept for the next chunk. */
export function createFrameDecoder(): (chunk: Buffer) => Frame[] {
	let buffer: Buffer = Buffer.alloc(0);
	return (chunk) => {
		buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
		const frames: Frame[] = [];
		for (;;) {
			if (buffer.length < 2) break;
			const first = buffer[0] as number;
			const second = buffer[1] as number;
			let offset = 2;
			let length = second & 0x7f;
			if (length === 126) {
				if (buffer.length < 4) break;
				length = buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (buffer.length < 10) break;
				length = Number(buffer.readBigUInt64BE(2));
				offset = 10;
			}
			const masked = (second & 0x80) !== 0;
			const start = offset + (masked ? 4 : 0);
			if (buffer.length < start + length) break;
			const payload = Buffer.from(buffer.subarray(start, start + length));
			if (masked) {
				const mask = buffer.subarray(offset, offset + 4);
				for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
			}
			frames.push({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload });
			buffer = buffer.subarray(start + length);
		}
		return frames;
	};
}

export const acceptKey = (key: string) =>
	createHash("sha1")
		.update(key + GUID)
		.digest("base64");

export interface WebSocketHandlers {
	onMessage(text: string): void;
	/** Once, however the connection ended; `error` is unset for a clean close. */
	onClose(error?: Error): void;
}

export interface WebSocketConnection {
	send(text: string): void;
	close(): void;
	/** Whether an open connection alone keeps the process alive. */
	ref(): void;
	unref(): void;
}

export interface OpenWebSocketOptions {
	readonly socketPath: string;
	readonly path: string;
	readonly protocol: string;
	readonly timeoutMs?: number;
}

export type OpenWebSocket = (
	options: OpenWebSocketOptions,
	handlers: WebSocketHandlers,
) => Promise<WebSocketConnection>;

/** Resolves once the server has accepted the upgrade with the asked-for subprotocol. */
export const openWebSocket: OpenWebSocket = (options, handlers) =>
	new Promise((resolve, reject) => {
		const key = randomBytes(16).toString("base64");
		const upgrade = request({
			socketPath: options.socketPath,
			path: options.path,
			headers: {
				Host: "localhost",
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Key": key,
				"Sec-WebSocket-Version": "13",
				"Sec-WebSocket-Protocol": options.protocol,
			},
			timeout: options.timeoutMs ?? 5_000,
		});
		upgrade.once("timeout", () => upgrade.destroy(new Error(`WebSocket upgrade to ${options.path} timed out`)));
		upgrade.once("error", reject);
		upgrade.once("response", (response) => {
			response.resume();
			reject(new Error(`WebSocket upgrade to ${options.path} answered HTTP ${response.statusCode}`));
		});
		upgrade.once("upgrade", (response, socket: Socket, head: Buffer) => {
			upgrade.off("error", reject);
			if (response.headers["sec-websocket-accept"] !== acceptKey(key)) {
				socket.destroy();
				return reject(new Error("WebSocket upgrade: wrong Sec-WebSocket-Accept"));
			}
			if (response.headers["sec-websocket-protocol"] !== options.protocol) {
				socket.destroy();
				return reject(new Error(`WebSocket upgrade: server did not accept subprotocol ${options.protocol}`));
			}
			resolve(wrap(socket, head, handlers));
		});
		upgrade.end();
	});

function wrap(socket: Socket, head: Buffer, handlers: WebSocketHandlers): WebSocketConnection {
	socket.setTimeout(0);
	socket.setNoDelay(true);
	const decode = createFrameDecoder();
	let fragments: Buffer[] = [];
	let closed = false;
	const finish = (error?: Error) => {
		if (closed) return;
		closed = true;
		socket.destroy();
		handlers.onClose(error);
	};
	const write = (opcode: number, payload: Buffer) => {
		if (!closed && socket.writable) socket.write(encodeFrame(opcode, payload, true));
	};

	const receive = (chunk: Buffer) => {
		for (const frame of decode(chunk)) {
			if (closed) return;
			switch (frame.opcode) {
				case OPCODE.ping:
					write(OPCODE.pong, frame.payload);
					break;
				case OPCODE.pong:
					break;
				case OPCODE.close: {
					const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
					const reason = frame.payload.subarray(2).toString("utf8");
					write(OPCODE.close, frame.payload.subarray(0, 2));
					finish(code === 1000 ? undefined : new Error(`WebSocket closed by the server: ${code} ${reason}`.trim()));
					return;
				}
				case OPCODE.text:
				case OPCODE.binary:
				case OPCODE.continuation:
					fragments.push(frame.payload);
					if (frame.fin) {
						const message = Buffer.concat(fragments).toString("utf8");
						fragments = [];
						handlers.onMessage(message);
					}
					break;
				default:
					write(OPCODE.close, Buffer.from([0x03, 0xea]));
					finish(new Error(`WebSocket: unknown opcode ${frame.opcode}`));
					return;
			}
		}
	};

	socket.on("data", receive);
	socket.on("error", (error) => finish(error));
	socket.on("close", () => finish(new Error("WebSocket connection dropped")));
	if (head.length > 0) queueMicrotask(() => receive(head));
	return {
		send(text) {
			if (closed) throw new Error("WebSocket is closed");
			write(OPCODE.text, Buffer.from(text, "utf8"));
		},
		close() {
			write(OPCODE.close, Buffer.from([0x03, 0xe8]));
			finish();
		},
		ref: () => socket.ref(),
		unref: () => socket.unref(),
	};
}
