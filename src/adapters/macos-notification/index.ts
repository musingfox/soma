import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Runs `file` with `args` and resolves once it exited 0, as `execFile` does. */
export type Run = (file: string, args: readonly string[], options: { timeout: number }) => Promise<unknown>;

const NOTIFY_TIMEOUT_MS = 10_000;
// The text goes as an argument, never spliced into the script, so no quote in it can end the string or add a statement.
const SCRIPT = ["on run argv", 'display notification (item 1 of argv) with title "soma"', "end run"];

/** A notification on this Mac's screen, titled soma, through AppleScript's `display notification`. */
export function macNotifier(run: Run = promisify(execFile)) {
	return async (text: string): Promise<void> => {
		await run("osascript", [...SCRIPT.flatMap((line) => ["-e", line]), text], { timeout: NOTIFY_TIMEOUT_MS });
	};
}
