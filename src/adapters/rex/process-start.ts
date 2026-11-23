// rex reports a block's foreground pid but not when it started; ps does, to the second.
import { execFile } from "node:child_process";

/** When the process started, in ms since the epoch; undefined once it is gone or ps cannot say. */
export type ProcessStart = (pid: number) => Promise<number | undefined>;

export const readProcessStart: ProcessStart = (pid) =>
	new Promise((resolve) => {
		// The C locale keeps lstart in the one format Date.parse reads, e.g. "Tue Oct 27 01:45:51 2026". ps prints it in
		// UTC and it is read as UTC, so the instant does not depend on the TZ soma runs under.
		const env = { LC_ALL: "C", TZ: "UTC" };
		execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env }, (error, stdout) => {
			const at = error ? Number.NaN : Date.parse(`${stdout.trim()} UTC`);
			resolve(Number.isNaN(at) ? undefined : at);
		});
	});

/** The pids of a process's direct children; none once it is gone or pgrep cannot say. */
export type ProcessChildren = (pid: number) => Promise<readonly number[]>;

// `pgrep -P` matches on the parent alone and reads no command line; one that has not answered in 3 s is killed.
export const readProcessChildren: ProcessChildren = (pid) =>
	new Promise((resolve) => {
		execFile(
			"/usr/bin/pgrep",
			["-P", String(pid)],
			{ encoding: "utf8", timeout: 3_000, killSignal: "SIGKILL" },
			(error, stdout) => {
				resolve(error ? [] : stdout.split("\n").filter(Boolean).map(Number));
			},
		);
	});
