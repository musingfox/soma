import type { HumanInput, HumanPort, NoticeKind, SomaEvent } from "../../ports/human.ts";

export class FakeHumanPort implements HumanPort {
	readonly inputs: HumanInput[] = [];
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

	emit(event: SomaEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}
