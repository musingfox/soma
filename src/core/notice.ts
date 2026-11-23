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

// Durable spec 8.3: the reasons an input settles unanswered with; model_error and faulted carry the error text.
const REASONS: Record<string, string> = {
	model_error: "模型出錯",
	no_model: "找不到模型",
	aborted: "這一輪被中止",
	faulted: "內部錯誤",
};

/** Why a round settled unanswered, in words a human can read. */
export const failureReason = (reason: string, detail: unknown) => {
	const head = REASONS[reason] ?? reason;
	const text = typeof detail === "string" ? detail : detail === undefined ? "" : JSON.stringify(detail);
	return text === "" ? head : `${head}：${text}`;
};

/** What the human is told of a round the core started that failed. */
export const failureContent = (requestId: string, reason: string) => `${requestId} 那一輪失敗：${reason}`;
