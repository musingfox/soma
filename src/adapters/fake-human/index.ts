import type { Answer } from "../../ports/agent.ts";
import type { HumanAnswerOutcome, HumanInput, HumanPort, NoticeKind, SomaEvent } from "../../ports/human.ts";

export class FakeHumanPort implements HumanPort {
	readonly inputs: HumanInput[] = [];
	readonly answers: { readonly card: string; readonly answer: Answer }[] = [];
	/** What the next `respond` returns. */
	outcome: HumanAnswerOutcome = { sent: true };
	readonly #listeners = new Set<(event: SomaEvent) => void>();

	async submit(input: HumanInput): Promise<void> {
		if (this.inputs.some((seen) => seen.requestId === input.requestId)) return;
		this.inputs.push(input);
	}

	subscribe(listener: (event: SomaEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async notify(content: string, kind: NoticeKind): Promise<void> {
		this.emit({ type: "notice", kind, content });
	}

	async respond(card: string, answer: Answer): Promise<HumanAnswerOutcome> {
		this.answers.push({ card, answer });
		return this.outcome;
	}

	emit(event: SomaEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}
