/**
 * What an agent soma dispatched asks with `soma defer`: `instruction` sent back to it at `at`. `agent` is the agent's
 * own SOMA_AGENT, the card soma started it for; `at` is as the agent wrote it, resolved by soma.
 */
export interface AgentDeferRequest {
	readonly agent: string;
	readonly at: string;
	readonly instruction: string;
}

/**
 * What a Claude Code session soma did not dispatch asks with `soma defer`: soma resumes `session` in `cwd` at `at` and
 * gives it `instruction`. `session` is its CLAUDE_CODE_SESSION_ID, `cwd` the absolute directory the CLI ran in.
 */
export interface HandoffRequest {
	readonly session: string;
	readonly cwd: string;
	readonly at: string;
	readonly instruction: string;
	/**
	 * The drop directory's alone: the name of the request file, so a request read again after a crash or a reply that
	 * could not be written gets the deferral it made the first time instead of a second one.
	 */
	readonly request?: string;
	/**
	 * The drop directory's alone: when the session asked, in epoch ms (the file's modification time), since soma may read
	 * the file long after, as when it was down. A duration in `at` counts from it.
	 */
	readonly setAt?: number;
}

export type DeferRequest = AgentDeferRequest | HandoffRequest;

/** `id` names the deferral, `at` is when it falls as an ISO 8601 date-time; a refusal's `reason` is for the agent. */
export type DeferReply =
	| { readonly accepted: true; readonly id: string; readonly at: string }
	| { readonly accepted: false; readonly reason: string };
