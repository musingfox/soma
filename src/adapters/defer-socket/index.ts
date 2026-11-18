import { lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { z } from "zod";
import type { DeferReply, DeferRequest } from "../../ports/defer.ts";
import { type DispatchReply, type DispatchRequest, refusedForAgent } from "../../ports/dispatch.ts";

// One request per connection: a JSON line from the CLI, a JSON line back, then the server ends the connection. A
// request with `kind: "dispatch"` is `soma dispatch`'s; any other is `soma defer`'s, whose CLI, in the shell of an agent
// an older release started, sends no kind. A dispatch request carries the caller's SOMA_AGENT when it had one, and the
// CLI of an older release sends none.
const RequestSchema = z.object({ agent: z.string().min(1), at: z.string(), instruction: z.string() }).strict();
const DispatchRequestSchema = z
	.object({
		kind: z.literal("dispatch"),
		repo: z.string().min(1),
		card: z.string().min(1),
		agent: z.string().optional(),
	})
	.strict();
const ReplySchema = z.union([
	z.object({ accepted: z.literal(true), id: z.string(), at: z.string() }),
	z.object({ accepted: z.literal(false), reason: z.string() }),
]);
const DispatchReplySchema = z.union([
	z.object({
		dispatched: z.literal(true),
		how: z.enum(["started", "found", "existing"]),
		card: z.string(),
		agent: z.string(),
		sessionId: z.string(),
		repo: z.string().optional(),
		state: z.string(),
	}),
	z.object({ dispatched: z.literal(false), reason: z.string() }),
	// What the server answers before it knows the request's kind, such as one too long.
	z.object({ accepted: z.literal(false), reason: z.string() }).transform(({ reason }) => ({
		dispatched: false as const,
		reason,
	})),
]);
// Far above any instruction an agent types; a client that sends more is not one of soma's.
const MAX_REQUEST_BYTES = 64 * 1024;
// The CLI writes its request as soon as it connects; a connection silent this long is not one of soma's.
const READ_TIMEOUT_MS = 5_000;

export interface DeferServer {
	close(): Promise<void>;
}

/** Whether some process answers on `path`: a socket file left by a killed soma takes no connection. */
function answers(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = connect(path);
		probe.once("connect", () => {
			probe.destroy();
			resolve(true);
		});
		probe.once("error", () => resolve(false));
	});
}

/** Binds under a umask of 0177: the socket file is 0600 from the moment it exists, with no chmod after it. */
function listen(server: Server, path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const fail = (error: Error) => reject(error);
		server.once("error", fail);
		const umask = process.umask(0o177);
		try {
			server.listen(path, () => {
				server.off("error", fail);
				resolve();
			});
		} finally {
			process.umask(umask);
		}
	});
}

/**
 * Serves `soma defer`, and `soma dispatch` when given `dispatch`, on the unix socket `path`, mode 0600, so only the user
 * soma runs as can connect. A socket file nobody answers on, as a killed soma leaves, is replaced; one another process
 * serves, or any file not a socket, is not.
 */
export async function serveDefer(options: {
	readonly path: string;
	readonly defer: (request: DeferRequest) => Promise<DeferReply>;
	readonly dispatch?: (request: DispatchRequest) => Promise<DispatchReply>;
	readonly onError?: (error: Error) => void;
	/** How long a connection may sit idle, before its request or after its reply, before it is dropped. */
	readonly readTimeoutMs?: number;
}): Promise<DeferServer> {
	const { path, defer, dispatch } = options;
	const onError = options.onError ?? ((error: Error) => console.error(`[soma] defer socket: ${error.message}`));
	const readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
	// Connections whose request is not read yet, which close drops; one being answered ends with its reply.
	const reading = new Set<Socket>();
	const handle = (socket: Socket) => {
		let buffered = "";
		// The timeout is off only while the core records the request; a client that never closes after the reply is
		// dropped as one that never sends is.
		const reply = (value: DeferReply | DispatchReply) => {
			socket.setTimeout(readTimeoutMs);
			socket.end(`${JSON.stringify(value)}\n`);
		};
		const read = () => {
			reading.delete(socket);
			socket.setTimeout(0);
			socket.removeAllListeners("data");
		};
		reading.add(socket);
		socket.once("close", () => reading.delete(socket));
		socket.on("timeout", () => socket.destroy());
		socket.setTimeout(readTimeoutMs);
		socket.setEncoding("utf8");
		socket.on("error", onError);
		socket.on("data", (chunk: string) => {
			buffered += chunk;
			if (buffered.length > MAX_REQUEST_BYTES) {
				read();
				return reply({ accepted: false, reason: `the request is over ${MAX_REQUEST_BYTES} bytes` });
			}
			const newline = buffered.indexOf("\n");
			if (newline === -1) return;
			read();
			let json: unknown;
			try {
				json = JSON.parse(buffered.slice(0, newline));
			} catch {
				return reply({ accepted: false, reason: "the request is not JSON" });
			}
			const fields = (error: z.ZodError) =>
				error.issues.map((issue) => issue.path.join(".") || "(top level)").join(", ");
			if ((json as { kind?: unknown } | null)?.kind === "dispatch") {
				const request = DispatchRequestSchema.safeParse(json);
				if (!request.success) {
					return reply({ dispatched: false, reason: `the request is malformed at ${fields(request.error)}` });
				}
				if (dispatch === undefined)
					return reply({ dispatched: false, reason: "this soma does not serve soma dispatch" });
				const agent = request.data.agent?.trim();
				if (agent) return reply({ dispatched: false, reason: refusedForAgent(agent) });
				const { repo, card } = request.data;
				dispatch({ repo, card }).then(reply, (error: Error) => {
					onError(error);
					reply({ dispatched: false, reason: `soma failed to dispatch it: ${error.message}` });
				});
				return;
			}
			const request = RequestSchema.safeParse(json);
			if (!request.success) {
				return reply({ accepted: false, reason: `the request is malformed at ${fields(request.error)}` });
			}
			defer(request.data).then(reply, (error: Error) => {
				onError(error);
				reply({ accepted: false, reason: `soma failed to record it: ${error.message}` });
			});
		});
	};

	mkdirSync(dirname(path), { recursive: true });
	const server = createServer(handle);
	try {
		await listen(server, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		if (await answers(path)) throw new Error(`another process already serves ${path}`);
		// Only a socket can be one a killed soma left; anything else at the path is someone's file.
		if (!lstatSync(path).isSocket())
			throw new Error(`${path} is not a socket, so soma leaves it alone; soma defer is not served`);
		unlinkSync(path);
		await listen(server, path);
	}
	return {
		close: () =>
			new Promise<void>((resolve) => {
				// Closing a unix-socket server removes its file; it calls back once every connection has ended.
				server.close(() => resolve());
				for (const socket of reading) socket.destroy();
			}),
	};
}

/**
 * What `requestDefer` and `requestDispatch` reject with when they could not connect: the request never went out, so
 * nothing was deferred or dispatched.
 */
export class DeferUnreachable extends Error {}

/**
 * Sends one request to the soma serving `path`; rejects when none answers or the reply is not one. Only a rejection
 * before the request went out is a DeferUnreachable: after it, soma may have recorded the request whatever the error.
 */
export function requestDefer(path: string, request: DeferRequest, timeoutMs = 10_000): Promise<DeferReply> {
	return send(path, request, ReplySchema, "soma defer", timeoutMs);
}

/**
 * Sends one `soma dispatch` request to the soma serving `path`, as `requestDefer` sends a defer. Its timeout is longer,
 * since soma reads the card and starts the agent before it replies.
 */
export function requestDispatch(path: string, request: DispatchRequest, timeoutMs = 60_000): Promise<DispatchReply> {
	return send(path, { kind: "dispatch", ...request }, DispatchReplySchema, "soma dispatch", timeoutMs);
}

function send<T>(
	path: string,
	request: object,
	schema: z.ZodType<T, z.ZodTypeDef, unknown>,
	command: string,
	timeoutMs: number,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const socket = connect(path);
		let buffered = "";
		let sent = false;
		socket.setEncoding("utf8");
		socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`no reply from ${path} in ${timeoutMs} ms`)));
		socket.once("connect", () => {
			sent = true;
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.on("data", (chunk: string) => {
			buffered += chunk;
		});
		socket.once("error", (error) => reject(sent ? error : new DeferUnreachable(error.message)));
		socket.once("end", () => {
			const reply = schema.safeParse(
				(() => {
					try {
						return JSON.parse(buffered);
					} catch {
						return undefined;
					}
				})(),
			);
			if (reply.success) resolve(reply.data);
			else reject(new Error(`${path} sent no reply ${command} can read`));
		});
	});
}
