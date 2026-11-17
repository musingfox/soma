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
export type PromptChoices = { readonly card: string; readonly fingerprint: string; readonly options: Choice[] };

/**
 * A question with a few options that names no card: a press means "the human said this option", through
 * `HumanPort.say`. Asked by soma's model, the option is submitted as the human's input. Listed by a job's agent at the
 * end of its 需要你 reply, it names the job's card in `job`, and the option goes to that agent as its next prompt.
 */
export type SaidChoices = { readonly question: string; readonly options: Choice[]; readonly job?: string };

export type Choices = PromptChoices | SaidChoices;

export const isPrompt = (choices: Choices): choices is PromptChoices => "card" in choices;

export type HumanAnswerOutcome = AnswerOutcome | { readonly sent: false; readonly refusal: "no_job" };

/**
 * What became of a press on a question's option; a question already answered refuses with the label chosen then. One
 * that went to a job's agent names the job's card in `job`: it started no round. `not_waiting`: the job no longer waits
 * on the question, so nothing was sent. `unsent`: the agent side refused the prompt before typing anything, for a reason
 * other than the agent being busy, given in `reason`; the question stays open, so a later press may go through.
 * `unsure`: sending to the agent failed after it may have typed some of the label; the question stays settled, so it is
 * never sent twice.
 */
export type SaidOutcome =
	| { readonly said: true; readonly label: string; readonly job?: string }
	| { readonly said: false; readonly refusal: "settled" | "unsure"; readonly label: string }
	| { readonly said: false; readonly refusal: "unsent"; readonly reason: string }
	| { readonly said: false; readonly refusal: "no_question" | "unknown_option" | "not_waiting" };

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
	// Pushed when a round the core started answered (`PUSHED_ANSWERS`). `asked`: the round asked the human a question in
	// reply to this input, which rang where it replied, so this answer does not ring, and one with no text shows nothing.
	| ({
			readonly type: "answer";
			readonly requestId: string;
			readonly content: string;
			readonly asked?: true;
	  } & Partial<Pushed>)
	// The answer of the running round as the model writes it: the requestIds of the round's inputs, and the whole text
	// so far of the current generation, never a delta; a new generation of the round starts over from empty. Sent only
	// when the text changed, never stored and never replayed: the round still ends with its `answer` or `failure`.
	| { readonly type: "partial"; readonly requestIds: readonly string[]; readonly content: string }
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
	// A question's option was pressed on some interface: every client settles that question's options on `label`.
	| { readonly type: "said"; readonly question: string; readonly label: string }
	| { readonly type: "job"; readonly card: string; readonly agent: string; readonly status: AgentState }
	// soma's own run: working while a round of the root conversation runs, whoever started it.
	| { readonly type: "run"; readonly state: "working" | "idle" };

export interface HumanPort {
	submit(input: HumanInput): Promise<void>;
	subscribe(listener: (event: SomaEvent) => void): () => void;
	notify(content: string, kind: NoticeKind, messageClass: MessageClass): Promise<void>;
	// The human's own choice on a blocked prompt: sent to the card's agent without a model round.
	respond(card: string, answer: Answer): Promise<HumanAnswerOutcome>;
	/**
	 * The human's press on an option of a question soma asked: the option's label is submitted to the root conversation
	 * as their input, as `submit` would, and the question is settled, so a second press says nothing. On a question a
	 * job's agent listed, the label goes to that agent as its next prompt instead, while the job still waits on it.
	 */
	say(question: string, option: string, input: Omit<HumanInput, "content">): Promise<SaidOutcome>;
}
