import { inspect } from "node:util";
import { ZodError, type ZodIssue } from "zod";

/**
 * Each issue as `path: message`, the root path as `(root)`; a union's failing branches are listed under it, indented,
 * since its own message only says the input matched none of them.
 */
export function issueLines(issues: readonly ZodIssue[], indent = ""): string[] {
	return issues.flatMap((issue) => [
		`${indent}${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`,
		...(issue.code === "invalid_union"
			? issue.unionErrors.flatMap((error, index) => [
					`${indent}  branch ${index + 1}:`,
					...issueLines(error.issues, `${indent}    `),
				])
			: []),
	]);
}

/** A value as `util.inspect` shows it, or as plain a text as can be had when inspecting it throws. */
function describe(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return inspect(value);
	} catch {
		try {
			return value instanceof Error && typeof value.stack === "string" ? value.stack : String(value);
		} catch {
			return "[a value that cannot be printed]";
		}
	}
}

/**
 * Makes printing an error safe for `target`, `console` by default, and for every `util.inspect` of a ZodError.
 *
 * On Node 24, inspecting an error whose `errors` is an array adds `errors` to the keys it shows, so as to show an
 * AggregateError's errors, and then reads that key's own property descriptor. A zod 3 ZodError's `errors` is a getter on
 * its prototype, which has no own descriptor, so `util.inspect` throws "Cannot read properties of undefined (reading
 * 'value')", and with it `console.error`. A ZodError is shown instead as its name, its issues, and its stack frames.
 * Any other value whose inspection throws makes `target.error` print each argument as plain a text as it can.
 */
export function installErrorPrinting(target: Pick<Console, "error"> = console): void {
	Object.defineProperty(ZodError.prototype, inspect.custom, {
		configurable: true,
		value(this: ZodError) {
			const frames = (this.stack ?? "").split("\n").filter((line) => line.startsWith("    at "));
			const count = `${this.issues.length} issue${this.issues.length === 1 ? "" : "s"}`;
			return [`${this.name}: ${count}`, ...issueLines(this.issues, "  "), ...frames].join("\n");
		},
	});
	const print = target.error.bind(target);
	target.error = (...args: unknown[]) => {
		try {
			print(...args);
		} catch {
			print(args.map(describe).join(" "));
		}
	};
}
