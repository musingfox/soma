const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A failure's text as the page shows it. A provider's SDK puts the error body it got into its message whole, as the
 * Anthropic one does with `401 {"type":"error","error":{"type":"authentication_error","message":"…"},"request_id":"req_…"}`:
 * that JSON is replaced by its error type and message, so the bubble says what went wrong without the raw body or the
 * request id. The text around it stays, and a text with no such body is returned as it is. Telegram and the logs get
 * the failure text unchanged; this is the page's view of it only.
 */
export function readableFailure(text: string): string {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end < start) return text;
	let body: unknown;
	try {
		body = JSON.parse(text.slice(start, end + 1));
	} catch {
		return text;
	}
	// A slice from "{" to "}" parses to an object or not at all; the check is for the type.
	if (!isObject(body)) return text;
	// An Anthropic body nests the error under `error`; its outer `type` is always "error".
	const error = isObject(body.error) ? body.error : body;
	const type = typeof error.type === "string" ? error.type : "";
	const message = typeof error.message === "string" ? error.message : "";
	if (type === "" && message === "") return text;
	const said = [type, message].filter((part) => part !== "").join("：");
	return [text.slice(0, start).trimEnd(), said, text.slice(end + 1).trimStart()]
		.filter((part) => part !== "")
		.join(" ");
}
