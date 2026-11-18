/**
 * What `soma dispatch` asks: a job on `card`, in the git repo at `repo`, started by host code as the dispatch tool
 * starts one, with no turn of the model. `repo` is as the human gave it, absolute; soma resolves and checks it.
 */
export interface DispatchRequest {
	readonly repo: string;
	readonly card: string;
}

/**
 * `how` the card has its job now: `started` by this request; `found`, an agent of the card's name already running,
 * which soma recorded as the job without starting another; `existing`, the card had a job, which is returned as it is,
 * whatever repo it runs in. `repo` is absent only for a job recorded before jobs kept one. A refusal's `reason` is for
 * the human, and no job was recorded.
 */
export type DispatchReply =
	| {
			readonly dispatched: true;
			readonly how: "started" | "found" | "existing";
			readonly card: string;
			readonly agent: string;
			readonly sessionId: string;
			readonly repo?: string;
			readonly state: string;
	  }
	| { readonly dispatched: false; readonly reason: string };

/** The repo's real path when a job may be started in it, else why not, for the human. */
export type RepoCheck = (path: string) => Promise<{ readonly repo: string } | { readonly refused: string }>;
