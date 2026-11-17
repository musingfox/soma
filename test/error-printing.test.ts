import { Console } from "node:console";
import { Writable } from "node:stream";
import { expect, test } from "vitest";
import { z } from "zod";
import { installErrorPrinting } from "../src/error-printing.ts";

/** A console whose error output is kept, with soma's error printing in place. */
function capture() {
	const chunks: string[] = [];
	const stream = new Writable({
		write(chunk, _encoding, done) {
			chunks.push(String(chunk));
			done();
		},
	});
	const target = new Console({ stdout: stream, stderr: stream });
	installErrorPrinting(target);
	return { target, output: () => chunks.join("") };
}

const Update = z.object({ update_id: z.number(), message: z.object({ chat: z.object({ id: z.number() }) }) });

test("a ZodError prints as its issues, each naming its path, and its stack frames", () => {
	const { target, output } = capture();
	const failed = Update.safeParse({ update_id: 1, message: { chat: { id: "42" } } });
	if (failed.success) throw new Error("expected the update not to parse");

	expect(() => target.error("[soma] telegram:", failed.error)).not.toThrow();

	const lines = output().split("\n");
	expect(lines.slice(0, 2)).toEqual([
		"[soma] telegram: ZodError: 1 issue",
		"  message.chat.id: Expected number, received string",
	]);
	expect(lines[2]).toMatch(/^ {4}at /);
});

test("a ZodError as an error's cause prints as its issues too", () => {
	const { target, output } = capture();
	const failed = Update.safeParse({ message: { chat: { id: 42 } } });
	if (failed.success) throw new Error("expected the update not to parse");

	expect(() => target.error("[soma] telegram:", new Error("getUpdates", { cause: failed.error }))).not.toThrow();

	expect(output()).toMatch(/\[cause\]: ZodError: 1 issue\n +update_id: Required\n/);
});

test("a union's failing branches are listed under it", () => {
	const { target, output } = capture();
	const failed = z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false) })]).safeParse({ ok: 1 });
	if (failed.success) throw new Error("expected the response not to parse");

	target.error(failed.error);

	expect(output().split("\n").slice(0, 6)).toEqual([
		"ZodError: 1 issue",
		"  (root): Invalid input",
		"    branch 1:",
		"      ok: Invalid literal value, expected true",
		"    branch 2:",
		"      ok: Invalid literal value, expected false",
	]);
});

test("any other error whose inspection throws prints as its stack instead of throwing", () => {
	const { target, output } = capture();
	// What makes a ZodError's inspection throw on Node 24: an array `errors` that is not an own property.
	class Listed extends Error {
		get errors() {
			return [new Error("inner")];
		}
	}
	const error = new Listed("outer");

	expect(() => target.error("[soma] x:", error)).not.toThrow();

	expect(output()).toMatch(/^\[soma\] x: Error: outer\n {4}at /);
});
