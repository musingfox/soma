import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { LiveSession } from "../ports/live-session.ts";

export function defaultSessionsDir(): string {
	return join(homedir(), ".claude", "sessions");
}

// An undocumented internal file of Claude Code (ARCHITECTURE.md "Session identity"), so only what is read is checked.
const ProcessSessionSchema = z
	.object({
		pid: z.number(),
		sessionId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
		cwd: z.string().optional(),
	})
	.passthrough();

/**
 * The session a running claude is in, off `<sessionsDir>/<pid>.json`, which claude rewrites when `/clear` starts a new
 * one. Undefined when the file is missing, is not one claude wrote for that pid, or does not read as expected.
 */
export async function readProcessSession(
	pid: number,
	sessionsDir = defaultSessionsDir(),
): Promise<{ readonly sessionId: string; readonly cwd?: string } | undefined> {
	let text: string;
	try {
		text = await readFile(join(sessionsDir, `${pid}.json`), "utf8");
	} catch {
		return undefined;
	}
	let parsed: ReturnType<typeof ProcessSessionSchema.safeParse>;
	try {
		parsed = ProcessSessionSchema.safeParse(JSON.parse(text));
	} catch {
		return undefined;
	}
	if (!parsed.success || parsed.data.pid !== pid) return undefined;
	const { sessionId, cwd } = parsed.data;
	return cwd === undefined ? { sessionId } : { sessionId, cwd };
}

/** Whether signal 0 reaches `pid`: it is alive, though perhaps another user's, which EPERM says. */
export function signalReaches(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * The look for a claude that has a session open: every `<pid>.json` of `sessionsDir` that claude wrote for that pid and
 * that names the session, whose pid `alive` says is alive. A directory that does not exist holds none; one that cannot be
 * listed throws, since that is no sign none is open; a file that does not read as claude's is skipped.
 */
export function liveSession(sessionsDir = defaultSessionsDir(), alive = signalReaches): LiveSession {
	return async (sessionId) => {
		let names: string[];
		try {
			names = await readdir(sessionsDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		for (const name of names) {
			const pid = /^([1-9][0-9]*)\.json$/.exec(name)?.[1];
			if (pid === undefined) continue;
			const session = await readProcessSession(Number(pid), sessionsDir);
			if (session?.sessionId !== sessionId || !alive(Number(pid))) continue;
			return session.cwd === undefined ? { pid: Number(pid) } : { pid: Number(pid), cwd: session.cwd };
		}
		return undefined;
	};
}
