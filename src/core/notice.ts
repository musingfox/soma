import type { JsonObject } from "@earendil-works/pi-durable";
import type { Choices, MessageClass, NoticeKind } from "../ports/human.ts";
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

/**
 * Every notice names its class, which the interfaces' policies go by. `foreign` names the foreign agent's prompt a
 * question tells of, so its push is dropped once the agent is past it. `replyTo` names, by entry kind, the interfaces
 * whose input the notice is part of the reply to: they get it at once whatever their policy, and never hold it.
 */
export function noticeEntry(
	kind: NoticeKind,
	messageClass: MessageClass,
	content: string,
	choices?: Choices,
	foreign?: PendingPush["foreign"],
	replyTo?: readonly string[],
) {
	const data: JsonObject = { kind, class: messageClass, content };
	if (choices !== undefined) data.choices = choices;
	if (foreign !== undefined) data.foreign = foreign;
	if (replyTo !== undefined && replyTo.length > 0) data.replyTo = [...replyTo];
	return { kind: NOTICE, data };
}
