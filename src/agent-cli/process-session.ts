import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

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
