import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeferReply, DeferRequest } from "../../ports/defer.ts";

// The drop directory: a Claude Code session's `register.sh` renames `<name>.req` into it, and soma answers with
// `<name>.reply`. Only the script and this adapter know the directory, the format and the reply; the core gets the same
// `defer` the socket gives it. Both sides write a temporary name and rename it, so neither ever reads half a file.
const NAME = "[A-Za-z0-9][A-Za-z0-9-]{0,99}";
const REQUEST = new RegExp(`^(${NAME})\\.req$`);
const REPLY = new RegExp(`^${NAME}\\.reply$`);
// As the socket's: far above any instruction a session types.
const MAX_REQUEST_BYTES = 64 * 1024;
const REPLY_KEPT_MS = 24 * 60 * 60 * 1000;
const SCAN_MS = 1_000;
const HEADERS = ["session", "cwd", "at"] as const;

export interface DropServer {
	close(): Promise<void>;
}

type Parsed = { readonly session: string; readonly cwd: string; readonly at: string; readonly instruction: string };

/** The request's fields, or why its text is not a request, in words for the session. */
export function parseRequest(text: string): Parsed | string {
	const end = text.indexOf("\n\n");
	if (end === -1) return "the request has no empty line after its headers";
	const fields = new Map<string, string>();
	for (const line of text.slice(0, end).split("\n")) {
		const header = /^([a-z]+): (.*)$/.exec(line);
		const key = header?.[1];
		if (header === null || key === undefined || !(HEADERS as readonly string[]).includes(key)) {
			return `the request's header line "${line.slice(0, 80)}" is not one of ${HEADERS.join(", ")}`;
		}
		if (fields.has(key)) return `the request has its ${key} header twice`;
		fields.set(key, header[2] ?? "");
	}
	const missing = HEADERS.filter((key) => !fields.has(key));
	if (missing.length > 0) return `the request has no ${missing.join(", ")} header`;
	return {
		session: fields.get("session") ?? "",
		cwd: fields.get("cwd") ?? "",
		at: fields.get("at") ?? "",
		instruction: text.slice(end + 2),
	};
}

const replyLine = (reply: DeferReply) =>
	reply.accepted ? `accepted ${reply.id} ${reply.at}\n` : `refused ${reply.reason.replace(/\r\n|\r|\n/g, " ")}\n`;

/**
 * Serves the drop directory `dir`, made 0700 when missing; one that is open to group or others, or not soma's user's
 * own, is refused, since any request in it is taken as the user's. It is scanned at start and every `scanMs`, one scan
 * at a time, with no watcher: a request renamed in while soma was down is taken at its next start.
 */
export async function serveDrop(options: {
	readonly dir: string;
	readonly defer: (request: DeferRequest) => Promise<DeferReply>;
	readonly onError?: (error: Error) => void;
	readonly scanMs?: number;
}): Promise<DropServer> {
	const { dir, defer } = options;
	const onError = options.onError ?? ((error: Error) => console.error(`[soma] drop directory: ${error.message}`));
	const scanMs = options.scanMs ?? SCAN_MS;
	const uid = process.getuid?.();
	await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
	const stat = await lstat(dir);
	if (!stat.isDirectory()) throw new Error(`${dir} is not a directory, so soma serves no drop directory there`);
	if (stat.uid !== uid) throw new Error(`${dir} is not soma's user's own, so soma serves no drop directory there`);
	if ((stat.mode & 0o077) !== 0) {
		throw new Error(
			`${dir} is open to group or others (mode ${(stat.mode & 0o777).toString(8)}), so soma serves no drop directory there; chmod 700 it`,
		);
	}

	// What has been told already, so a failure met at every scan is told once until it clears.
	const told = new Set<string>();
	const tell = (key: string, error: unknown) => {
		if (told.has(key)) return;
		told.add(key);
		onError(error instanceof Error ? error : new Error(String(error)));
	};

	/** Writes the reply by a rename, mode 0600, then removes the request; on a failure the request stays for the next scan. */
	async function answer(name: string, reply: DeferReply): Promise<void> {
		const temporary = join(dir, `${name}.reply.tmp`);
		try {
			await rm(temporary, { force: true });
			await writeFile(temporary, replyLine(reply), { mode: 0o600, flag: "wx" });
			await rename(temporary, join(dir, `${name}.reply`));
			await unlink(join(dir, `${name}.req`));
			told.delete(`record ${name}`);
			told.delete(`answer ${name}`);
		} catch (error) {
			tell(`answer ${name}`, new Error(`soma could not answer ${name}.req: ${(error as Error).message}`));
		}
	}

	/** The request file's text and time, or why it is refused unread; undefined when it is gone already. */
	async function read(name: string): Promise<{ text: string; setAt: number } | { refused: string } | undefined> {
		const path = join(dir, `${name}.req`);
		const seen = await lstat(path).catch(() => undefined);
		if (seen === undefined) return undefined;
		if (!seen.isFile()) return { refused: "the request is not a regular file" };
		if (seen.uid !== uid) return { refused: "the request is not soma's user's own file" };
		if (seen.size > MAX_REQUEST_BYTES) return { refused: `the request is over ${MAX_REQUEST_BYTES} bytes` };
		// Opened without following a link, and checked to be the file just looked at, in case it was swapped since.
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
			() => undefined,
		);
		if (file === undefined) return undefined;
		try {
			const held = await file.stat();
			if (!held.isFile() || held.ino !== seen.ino || held.dev !== seen.dev || held.size > MAX_REQUEST_BYTES) {
				return { refused: "the request changed while soma read it" };
			}
			const bytes = await file.readFile();
			try {
				return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), setAt: Math.floor(held.mtimeMs) };
			} catch {
				return { refused: "the request is not UTF-8 text" };
			}
		} finally {
			await file.close();
		}
	}

	async function take(name: string): Promise<void> {
		const got = await read(name);
		if (got === undefined) return;
		if ("refused" in got) return answer(name, { accepted: false, reason: got.refused });
		const parsed = parseRequest(got.text);
		if (typeof parsed === "string") return answer(name, { accepted: false, reason: parsed });
		let reply: DeferReply;
		try {
			reply = await defer({ ...parsed, request: name, setAt: got.setAt });
		} catch (error) {
			// Nothing was recorded: the request stays and is tried again at the next scan.
			tell(`record ${name}`, new Error(`soma failed to record ${name}.req: ${(error as Error).message}`));
			return;
		}
		await answer(name, reply);
	}

	async function prune(file: string): Promise<void> {
		const path = join(dir, file);
		const seen = await lstat(path).catch(() => undefined);
		if (seen?.isFile() && Date.now() - seen.mtimeMs > REPLY_KEPT_MS) await unlink(path).catch(() => {});
	}

	async function scan(): Promise<void> {
		let files: string[];
		try {
			files = (await readdir(dir)).sort();
			told.delete("");
		} catch (error) {
			tell("", new Error(`soma could not read ${dir}: ${(error as Error).message}`));
			return;
		}
		for (const file of files) {
			const request = REQUEST.exec(file)?.[1];
			if (request !== undefined) await take(request).catch((error: unknown) => tell(`take ${request}`, error));
			else if (REPLY.test(file)) await prune(file);
		}
	}

	let closed = false;
	let timer: NodeJS.Timeout | undefined;
	let running: Promise<void> = Promise.resolve();
	const loop = () => {
		running = scan().finally(() => {
			if (!closed) timer = setTimeout(loop, scanMs);
		});
	};
	loop();
	return {
		close: async () => {
			closed = true;
			clearTimeout(timer);
			await running;
		},
	};
}
