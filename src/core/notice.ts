import type { JsonObject } from "@earendil-works/pi-durable";
import type { Choices, NoticeKind } from "../ports/human.ts";

/** Entry kind of a notice to the human; HumanPort turns each one into a notice event. */
export const NOTICE = "notice";

export function noticeEntry(kind: NoticeKind, content: string, choices?: Choices) {
	const data: JsonObject = { kind, content };
	if (choices !== undefined) data.choices = choices;
	return { kind: NOTICE, data };
}
