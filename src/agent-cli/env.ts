// What a running claude hands its children to mark them as its own session. Inherited from a soma started inside
// claude, CLAUDE_CODE_CHILD_SESSION turns off the agent's transcript, which readResult reads.
const PARENT_SESSION_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(CHILD_SESSION|SESSION_\w+|MESSAGING_\w+|ENTRYPOINT))$/;

/** The environment an agent's claude starts with: `env`'s set variables, less the marks of a claude soma runs in. */
export function agentEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const kept: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && !PARENT_SESSION_ENV.test(key)) kept[key] = value;
	}
	return kept;
}
