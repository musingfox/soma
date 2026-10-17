import type { AgentListing, AgentPort, AgentState, AgentStatusEvent, StartRequest } from "../../ports/agent.ts";

export class FakeAgentPort implements AgentPort {
	readonly prompts: { readonly agent: string; readonly text: string }[] = [];
	readonly responses: { readonly agent: string; readonly answer: string }[] = [];
	readonly started: StartRequest[] = [];
	readonly stopped = new Set<string>();
	readonly #listeners = new Set<(event: AgentStatusEvent) => void>();
	readonly #results = new Map<string, string>();
	readonly #states = new Map<string, { status: AgentState; seq: number }>();
	#seq = 0;

	async start(request: StartRequest): Promise<void> {
		this.started.push(request);
		this.emit(request.name, { state: "idle" });
	}

	async list(): Promise<readonly AgentListing[]> {
		return [...this.#states].map(([name, { status, seq }]) => ({ name, status, seq }));
	}

	async prompt(agent: string, text: string): Promise<void> {
		this.prompts.push({ agent, text });
		this.emit(agent, { state: "working" });
	}

	onStatus(listener: (event: AgentStatusEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async readResult(agent: string): Promise<string | undefined> {
		return this.#results.get(agent);
	}

	async respond(agent: string, answer: string): Promise<void> {
		this.responses.push({ agent, answer });
		this.emit(agent, { state: "working" });
	}

	async stop(agent: string): Promise<void> {
		this.stopped.add(agent);
		this.#states.delete(agent);
	}

	/** `seq` defaults to the next one; passing the last one again replays an observation. */
	emit(agent: string, status: AgentState, seq = ++this.#seq): void {
		this.#states.set(agent, { status, seq });
		const event = { agent, status, seq };
		for (const listener of this.#listeners) listener(event);
	}

	finish(agent: string, result: string): void {
		this.#results.set(agent, result);
		this.emit(agent, { state: "done" });
	}
}
