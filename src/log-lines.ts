import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

type Logging = Pick<Console, "log" | "info" | "warn" | "error">;

/**
 * `args` as a console prints them after `stamp` and one space. A string first argument is prefixed itself, so a format
 * string in it still formats the rest; any other is preceded by `stamp`, which the console then joins with a space.
 * Only the first line of what is printed carries the stamp, so a stack trace's frames stay as they were.
 */
export function stamped(stamp: string, args: readonly unknown[]): unknown[] {
	if (args.length === 0) return [`${stamp} `];
	const [first, ...rest] = args;
	return typeof first === "string" ? [`${stamp} ${first}`, ...rest] : [stamp, ...args];
}

/**
 * Makes every line `target`, `console` by default, logs start with the time it was logged, as `toISOString` gives it,
 * so that a line of prod's log, which launchd collects from soma's stdout and stderr, can be placed in time. Writes
 * straight to `process.stdout`, such as the terminal's OSC 7501 records, are not log lines and are left as they are.
 * Installed after `installErrorPrinting`, so a `console.error` whose printing throws still prints, stamped.
 */
export function installTimestamps(target: Logging = console, now: () => Date = () => new Date()): void {
	for (const method of ["log", "info", "warn", "error"] as const) {
		const print = target[method].bind(target);
		target[method] = (...args: unknown[]) => print(...stamped(now().toISOString(), args));
	}
}

/**
 * What soma runs from: the release, when `root`, this checkout by default, resolves to a directory under `releases/` as
 * `scripts/release.sh` unpacks it, else the commit checked out at `root`, else nothing.
 */
export function runningFrom(root = dirname(dirname(fileURLToPath(import.meta.url)))): string | undefined {
	try {
		const real = realpathSync(root);
		if (basename(dirname(real)) === "releases") return `release ${basename(real)}`;
		// Without the GIT_ variables a git hook exports, which would point git at the repo the hook runs in.
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd: real,
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return sha === "" ? undefined : `commit ${sha}`;
	} catch {
		return undefined;
	}
}

/** The line soma logs as it starts, so that each start is a line in prod's log. */
export function startedLine(from: string | undefined): string {
	return from === undefined ? "[soma] started" : `[soma] started from ${from}`;
}
