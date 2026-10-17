import type { AgentState } from "./agent.ts";

export interface HumanInput {
	readonly content: string;
	readonly entry: { readonly kind: string; readonly data?: unknown };
	readonly requestId: string;
}

export type SomaEvent =
	| { readonly type: "answer"; readonly requestId: string; readonly content: string }
	| { readonly type: "notice"; readonly content: string }
	| { readonly type: "job"; readonly card: string; readonly agent: string; readonly status: AgentState };

export interface HumanPort {
	submit(input: HumanInput): Promise<void>;
	subscribe(listener: (event: SomaEvent) => void): () => void;
	notify(content: string): Promise<void>;
}
