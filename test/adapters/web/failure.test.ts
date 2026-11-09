import { expect, test } from "vitest";
import { readableFailure } from "../../../src/adapters/web/failure.ts";

// An Anthropic error body: the SDK's APIError message is the status and the body whole (makeMessage in
// @anthropic-ai/sdk core/error), pi-ai keeps that message, and soma puts the reason's heading before it.
const REQUEST_ID = "req_011CVa1b2c3d4e5f6g7h8i9j";
const BODY = {
	type: "error",
	error: { type: "authentication_error", message: "invalid x-api-key" },
	request_id: REQUEST_ID,
};
const ANTHROPIC_401 = `模型出錯：401 ${JSON.stringify(BODY)}`;

test("a provider's JSON error reads as its status, type and message, without the body or the request id", () => {
	const shown = readableFailure(ANTHROPIC_401);
	expect(shown).toBe("模型出錯：401 authentication_error：invalid x-api-key");
	expect(shown).not.toContain(REQUEST_ID);
	expect(shown).not.toContain("{");
});

test("text after the body stays", () => {
	expect(readableFailure(`${ANTHROPIC_401} (retried 3 times)`)).toBe(
		"模型出錯：401 authentication_error：invalid x-api-key (retried 3 times)",
	);
});

test("an error body with only a type, or only a message, says the one it has", () => {
	expect(readableFailure('529 {"type":"error","error":{"type":"overloaded_error"}}')).toBe("529 overloaded_error");
	expect(readableFailure('500 {"error":{"message":"upstream gone"}}')).toBe("500 upstream gone");
});

test("a failure whose text is not JSON shows as it is", () => {
	for (const text of [
		"no model",
		"模型出錯：401 invalid x-api-key",
		"內部錯誤：expected } after {",
		"內部錯誤：{not json}",
		'faulted: {"step":3}',
		"[1, 2]",
	]) {
		expect(readableFailure(text)).toBe(text);
	}
});
