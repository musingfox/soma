import type {
	AgentListing,
	AgentPort,
	AgentResult,
	AgentState,
	AgentStatusEvent,
	Answer,
	AnswerOutcome,
	ForeignAgent,
	ForeignStatusEvent,
	ResumeRequest,
	StartRequest,
} from "../../ports/agent.ts";

export class FakeAgentPort implements AgentPort {
	readonly prompts: { readonly agent: string; readonly text: string }[] = [];
	readonly responses: { readonly agent: string; readonly answer: Answer }[] = [];
	readonly started: StartRequest[] = [];
	readonly resumed: ResumeRequest[] = [];
	// One entry per call, so a second stop of the same agent shows.
	readonly stopped: string[] = [];
	readonly #listeners = new Set<(event: AgentStatusEvent) => void>();
	readonly #foreignListeners = new Set<(event: ForeignStatusEvent) => void>();
	readonly #results = new Map<string, AgentResult>();
	readonly #states = new Map<string, { status: AgentState; seq: number }>();
	/** Agents running beside the dispatched ones, with what each one's transcript ends on. */
	readonly foreign: { agent: ForeignAgent; result?: AgentResult }[] = [];
	#seq = 0;
	#turn = 0;

	async start(request: StartRequest): Promise<void> {
		this.started.push(request);
		this.emit(request.name, { state: "idle" });
	}

	/** Ready at once, as start is; the hangar has no cap here. */
	async resume(request: ResumeRequest): Promise<void> {
		this.resumed.push(request);
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

	async readResult(agent: string): Promise<AgentResult | undefined> {
		return this.#results.get(agent);
	}

	/** Sends only to the blocked status last emitted, matched by fingerprint, as the herdr adapter does. */
	async respond(agent: string, answer: Answer): Promise<AnswerOutcome> {
		const status = this.#states.get(agent)?.status;
		if (status?.state !== "blocked") return { sent: false, refusal: "not_blocked" };
		if (status.kind === "auth") return { sent: false, refusal: "auth" };
		if (status.fingerprint !== answer.fingerprint) return { sent: false, refusal: "stale" };
		this.responses.push({ agent, answer });
		this.emit(agent, { state: "working" });
		return { sent: true };
	}

	async stop(agent: string): Promise<void> {
		this.stopped.push(agent);
		this.#states.delete(agent);
	}

	async listForeign(): Promise<readonly ForeignAgent[]> {
		return this.foreign.map(({ agent }) => agent);
	}

	async readForeignResult(id: string): Promise<AgentResult | undefined> {
		const found = this.foreign.find(({ agent }) => agent.id === id);
		if (found === undefined) throw new Error(`no foreign agent ${id}`);
		return found.result;
	}

	onForeignStatus(listener: (event: ForeignStatusEvent) => void): () => void {
		this.#foreignListeners.add(listener);
		return () => this.#foreignListeners.delete(listener);
	}

	/** Lists the foreign agent with `status` and reports it, under `seq`, with whether the human is looking at it. */
	emitForeign(agent: Omit<ForeignAgent, "status">, status: AgentState, seq: number, watched = false): void {
		const listed = { ...agent, status };
		const index = this.foreign.findIndex((each) => each.agent.id === agent.id);
		if (index === -1) this.foreign.push({ agent: listed });
		else this.foreign[index] = { ...this.foreign[index], agent: listed };
		const event = { agent: listed, seq, watched };
		for (const listener of this.#foreignListeners) listener(event);
	}

	/** The agent's window closed by hand: no longer listed, and no stop recorded. */
	close(agent: string): void {
		this.#states.delete(agent);
	}

	/** `seq` defaults to the next one; passing the last one again replays an observation. */
	emit(agent: string, status: AgentState, seq = ++this.#seq): void {
		this.#states.set(agent, { status, seq });
		const event = { agent, status, seq };
		for (const listener of this.#listeners) listener(event);
	}

	/** Each call is a new turn, with a message id of its own. */
	finish(agent: string, result: string): void {
		this.#results.set(agent, { id: `msg_${++this.#turn}`, text: result });
		this.emit(agent, { state: "done" });
	}
}
