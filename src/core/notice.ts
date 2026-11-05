import type { JsonObject } from "@earendil-works/pi-durable";
import type { Choices, NoticeKind } from "../ports/human.ts";
import type { PendingPush } from "./domain/push.ts";

/** Entry kind of a notice to the human; HumanPort turns each one into a notice event. */
export const NOTICE = "notice";

/**
 * Result details of a tool call that sent the human's words on to a worker agent; HumanPort turns them into a
 * forwarded notice for each input of the round.
 */
export const FORWARDED = { forwarded: true } as const;

export const isForwarded = (details: unknown) =>
	typeof details === "object" && details !== null && (details as { forwarded?: unknown }).forwarded === true;

/** `foreign` names the foreign agent's prompt a question tells of, so its push is dropped once the agent is past it. */
export function noticeEntry(kind: NoticeKind, content: string, choices?: Choices, foreign?: PendingPush["foreign"]) {
	const data: JsonObject = { kind, content };
	if (choices !== undefined) data.choices = choices;
	if (foreign !== undefined) data.foreign = foreign;
	return { kind: NOTICE, data };
}
