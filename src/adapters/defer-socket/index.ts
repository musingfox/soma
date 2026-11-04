import { mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { z } from "zod";
import type { DeferReply, DeferRequest } from "../../ports/defer.ts";

// One request per connection: a JSON line from the CLI, a JSON line back, then the server ends the connection.
const RequestSchema = z.object({ agent: z.string().min(1), at: z.string(), instruction: z.string() }).strict();
const ReplySchema = z.union([
	z.object({ accepted: z.literal(true), id: z.string(), at: z.string() }),
	z.object({ accepted: z.literal(false), reason: z.string() }),
]);
// Far above any instruction an agent types; a client that sends more is not one of soma's.
const MAX_REQUEST_BYTES = 64 * 1024;

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
 * Serves `soma defer` on the unix socket `path`, mode 0600, so only the user soma runs as can connect. A socket file
 * nobody answers on, as a killed soma leaves, is replaced; one another process serves is not.
 */
export async function serveDefer(options: {
	readonly path: string;
	readonly defer: (request: DeferRequest) => Promise<DeferReply>;
	readonly onError?: (error: Error) => void;
}): Promise<DeferServer> {
	const { path, defer } = options;
	const onError = options.onError ?? ((error: Error) => console.error(`[soma] defer socket: ${error.message}`));
	const handle = (socket: Socket) => {
		let buffered = "";
		const reply = (value: DeferReply) => socket.end(`${JSON.stringify(value)}\n`);
		socket.setEncoding("utf8");
		socket.on("error", onError);
		socket.on("data", (chunk: string) => {
			buffered += chunk;
			if (buffered.length > MAX_REQUEST_BYTES) {
				socket.removeAllListeners("data");
				return reply({ accepted: false, reason: `the request is over ${MAX_REQUEST_BYTES} bytes` });
			}
			const newline = buffered.indexOf("\n");
			if (newline === -1) return;
			socket.removeAllListeners("data");
			let json: unknown;
			try {
				json = JSON.parse(buffered.slice(0, newline));
			} catch {
				return reply({ accepted: false, reason: "the request is not JSON" });
			}
			const request = RequestSchema.safeParse(json);
			if (!request.success) {
				const fields = request.error.issues.map((issue) => issue.path.join(".") || "(top level)").join(", ");
				return reply({ accepted: false, reason: `the request is malformed at ${fields}` });
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
		unlinkSync(path);
		await listen(server, path);
	}
	return {
		close: () =>
			new Promise<void>((resolve) => {
				// Closing a unix-socket server removes its file.
				server.close(() => resolve());
			}),
	};
}

/** Sends one request to the soma serving `path`; rejects when none answers or the reply is not one. */
export function requestDefer(path: string, request: DeferRequest, timeoutMs = 10_000): Promise<DeferReply> {
	return new Promise((resolve, reject) => {
		const socket = connect(path);
		let buffered = "";
		socket.setEncoding("utf8");
		socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`no reply from ${path} in ${timeoutMs} ms`)));
		socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk: string) => {
			buffered += chunk;
		});
		socket.once("error", reject);
		socket.once("end", () => {
			const reply = ReplySchema.safeParse(
				(() => {
					try {
						return JSON.parse(buffered);
					} catch {
						return undefined;
					}
				})(),
			);
			if (reply.success) resolve(reply.data);
			else reject(new Error(`${path} sent no reply soma defer can read`));
		});
	});
}
