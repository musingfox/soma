import type { Answer } from "../../ports/agent.ts";
import type {
	HumanAnswerOutcome,
	HumanInput,
	HumanPort,
	MessageClass,
	NoticeKind,
	SaidOutcome,
	SomaEvent,
} from "../../ports/human.ts";

export class FakeHumanPort implements HumanPort {
	readonly inputs: HumanInput[] = [];
	readonly answers: { readonly card: string; readonly answer: Answer }[] = [];
	/** What the next `respond` returns. */
	outcome: HumanAnswerOutcome = { sent: true };
	readonly said: { readonly question: string; readonly option: string; readonly input: Omit<HumanInput, "content"> }[] =
		[];
	/** What the next `say` returns. */
	saidOutcome: SaidOutcome = { said: true, label: "" };
	readonly stops: string[] = [];
	/** What the next `stop` returns. */
	stopOutcome = true;
	readonly #listeners = new Set<(event: SomaEvent) => void>();

	async submit(input: HumanInput): Promise<void> {
		if (this.inputs.some((seen) => seen.requestId === input.requestId)) return;
		this.inputs.push(input);
	}

	subscribe(listener: (event: SomaEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async notify(content: string, kind: NoticeKind, messageClass: MessageClass): Promise<void> {
		this.emit({ type: "notice", kind, class: messageClass, content });
	}

	async respond(card: string, answer: Answer): Promise<HumanAnswerOutcome> {
		this.answers.push({ card, answer });
		return this.outcome;
	}

	async say(question: string, option: string, input: Omit<HumanInput, "content">): Promise<SaidOutcome> {
		this.said.push({ question, option, input });
		return this.saidOutcome;
	}

	async stop(requestId: string): Promise<boolean> {
		this.stops.push(requestId);
		return this.stopOutcome;
	}

	emit(event: SomaEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}
