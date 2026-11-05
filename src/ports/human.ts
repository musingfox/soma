import type { AgentState, Answer, AnswerOutcome, Choice } from "./agent.ts";

export interface HumanInput {
	readonly content: string;
	readonly entry: { readonly kind: string; readonly data?: unknown };
	readonly requestId: string;
}

// ARCHITECTURE.md: the core notifies when it needs the human (a question) or has a report ready.
export type NoticeKind = "question" | "report";

/**
 * What a push the core starts is about, which each interface's policy is set by (ARCHITECTURE.md "Whom to push to"):
 * `action` waits on the human, `outcome` is how a piece of work ended, `ambient` is what soma did on its own.
 */
export const MESSAGE_CLASSES = ["action", "outcome", "ambient"] as const;
export type MessageClass = (typeof MESSAGE_CLASSES)[number];

/** What one client does with a push: ring, show it without a sound, or not show it (it stays in the history). */
export type Delivery = "ring" | "quiet" | "log";

/** A blocked prompt handed to the human with everything a client needs to offer its options. */
export type Choices = { readonly card: string; readonly fingerprint: string; readonly options: Choice[] };

export type HumanAnswerOutcome = AnswerOutcome | { readonly sent: false; readonly refusal: "no_job" };

/**
 * requestId prefixes of rounds the core starts itself (schedule, the event bridge for a job, the foreign bridge for a
 * foreign agent) whose failure no client owns, so every client pushes it. A digest round is not among them: on failure
 * the digest task writes a notice with the reason.
 */
export const PUSHED_FAILURES = ["schedule:", "agent:", "foreign:"] as const;

/** requestId prefixes of rounds the core starts itself whose answer no client asked for, so it is pushed. */
export const PUSHED_ANSWERS = ["schedule:"] as const;

/**
 * On a push the core starts itself: its class, and by entry kind what each client does with it, which the core decides
 * from the interfaces' policies and the push target; a client it does not name shows it without a sound. `delivery` is
 * absent when the core was given no push options, and then every client rings.
 */
type Pushed = { readonly class: MessageClass; readonly delivery?: Readonly<Record<string, Delivery>> };

/** What the client tagging its inputs `entryKind` does with a push. */
export const deliveryTo = (event: { readonly delivery?: Pushed["delivery"] }, entryKind: string): Delivery =>
	event.delivery === undefined ? "ring" : (event.delivery[entryKind] ?? "quiet");

export type SomaEvent =
	// Pushed when a round the core started answered (`PUSHED_ANSWERS`).
	| ({ readonly type: "answer"; readonly requestId: string; readonly content: string } & Partial<Pushed>)
	// The round ended without an answer: a provider error, no model, an abort or a fault. Pushed for `PUSHED_FAILURES`.
	| ({ readonly type: "failure"; readonly requestId: string; readonly reason: string } & Partial<Pushed>)
	| ({
			readonly type: "notice";
			readonly kind: NoticeKind;
			readonly content: string;
			readonly choices?: Choices;
	  } & Pushed)
	// A round's words went on to a worker agent: progress on the input with this requestId, nothing to show as text.
	| { readonly type: "notice"; readonly kind: "forwarded"; readonly requestId: string }
	| { readonly type: "job"; readonly card: string; readonly agent: string; readonly status: AgentState }
	// soma's own run: working while a round of the root conversation runs, whoever started it.
	| { readonly type: "run"; readonly state: "working" | "idle" };

export interface HumanPort {
	submit(input: HumanInput): Promise<void>;
	subscribe(listener: (event: SomaEvent) => void): () => void;
	notify(content: string, kind: NoticeKind, messageClass: MessageClass): Promise<void>;
	// The human's own choice on a blocked prompt: sent to the card's agent without a model round.
	respond(card: string, answer: Answer): Promise<HumanAnswerOutcome>;
}
