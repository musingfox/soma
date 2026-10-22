import type { AgentState, Answer, AnswerOutcome, Choice } from "./agent.ts";

export interface HumanInput {
	readonly content: string;
	readonly entry: { readonly kind: string; readonly data?: unknown };
	readonly requestId: string;
}

// ARCHITECTURE.md: the core notifies when it needs the human (a question) or has a report ready.
export type NoticeKind = "question" | "report";

/** A blocked prompt handed to the human with everything a client needs to offer its options. */
export type Choices = { readonly card: string; readonly fingerprint: string; readonly options: Choice[] };

export type HumanAnswerOutcome = AnswerOutcome | { readonly sent: false; readonly refusal: "no_job" };

/**
 * requestId prefixes of rounds the core starts itself (schedule, event bridge) whose failure no client owns, so every
 * client pushes it. A digest round is not among them: on failure the digest task writes a notice with the reason.
 */
export const PUSHED_FAILURES = ["schedule:", "herdr:"] as const;

export type SomaEvent =
	| { readonly type: "answer"; readonly requestId: string; readonly content: string }
	// The round ended without an answer: a provider error, no model, an abort or a fault.
	| { readonly type: "failure"; readonly requestId: string; readonly reason: string }
	| { readonly type: "notice"; readonly kind: NoticeKind; readonly content: string; readonly choices?: Choices }
	| { readonly type: "job"; readonly card: string; readonly agent: string; readonly status: AgentState }
	// soma's own run: working while a round of the root conversation runs, whoever started it.
	| { readonly type: "run"; readonly state: "working" | "idle" };

export interface HumanPort {
	submit(input: HumanInput): Promise<void>;
	subscribe(listener: (event: SomaEvent) => void): () => void;
	notify(content: string, kind: NoticeKind): Promise<void>;
	// The human's own choice on a blocked prompt: sent to the card's agent without a model round.
	respond(card: string, answer: Answer): Promise<HumanAnswerOutcome>;
}
