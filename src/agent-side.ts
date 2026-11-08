import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAcpAgentPort } from "./adapters/acp/agent-port.ts";
import { createHandoverAgentPort, noHandover } from "./adapters/handover/agent-port.ts";
import { createHerdrAgentPort } from "./adapters/herdr/agent-port.ts";
import { createHerdrClient } from "./adapters/herdr/client.ts";
import { createRexAgentPort } from "./adapters/rex/agent-port.ts";
import { createRexClient } from "./adapters/rex/client.ts";
import { createTtyAgentPort } from "./adapters/tty/agent-port.ts";
import { spawnPty } from "./adapters/tty/pty.ts";
import type { Config } from "./config.ts";
import { dispatchExtension } from "./core/extensions/dispatch/index.ts";
import type { AgentPort } from "./ports/agent.ts";
import type { AgentHandover } from "./ports/handover.ts";

/** The dispatch extension over a side as `openAgentPort` opened it, its handover with it: without one, every show_job answers no_hangar. */
export function dispatchOver(
	{ agents, handover }: { readonly agents: AgentPort; readonly handover?: AgentHandover },
	readCard: (repo: string, card: string) => Promise<string>,
) {
	return dispatchExtension(agents, readCard, handover);
}

/**
 * The one place the agent-side adapter is chosen, by the config's `agentAdapter`, with the agents it found dormant as it
 * was made, which only ACP has: rex and herdr host theirs past soma, and tty's end with it. ACP with a hangar named runs
 * its jobs on two sides, and is the one that can hand a job over; ACP without one hands over to nothing, which the
 * dispatch extension says for itself.
 */
export function openAgentPort({ agentAdapter, herdrSocket, rex, hangarCap, deferSocket, db }: Config): {
	agents: AgentPort;
	dormant: () => Promise<readonly string[]>;
	handover?: AgentHandover;
} {
	const none = async () => [];
	const cap = hangarCap === undefined ? {} : { cap: hangarCap };
	// What `soma defer` needs in an agent's shell: this release's bin/soma on PATH, the socket, and the node soma runs
	// on, since the agent's own may be one its project pins.
	const env = { SOMA_SOCKET: deferSocket, SOMA_NODE: process.execPath };
	const path = join(dirname(dirname(fileURLToPath(import.meta.url))), "bin");
	const rexPort = ({ socket, sessionId }: NonNullable<Config["rex"]>) => {
		const onError = (error: Error) => console.error("[soma] rex:", error.message);
		const client = createRexClient({ socketPath: socket, onError });
		return createRexAgentPort({ client, sessionId, onError, env, path, ...cap });
	};
	const notAcp = noHandover("not_acp", `this soma runs its jobs on ${agentAdapter}, not over ACP`);
	if (agentAdapter === "rex") {
		// resolveConfig sets rex whenever it is selected.
		if (rex === undefined) throw new Error("agentAdapter is rex but the config holds no rex settings");
		return { agents: rexPort(rex), dormant: none, handover: notAcp };
	}
	if (agentAdapter === "acp") {
		const onError = (error: Error) => console.error("[soma] acp:", error.message);
		// Next to the db, as the defer socket is: one soma per db, so prod and a dev instance keep their own. The port lists
		// the agents of the last soma it finds there dormant, and starts none until a prompt needs one.
		const sessionsFile = resolve(`${db}.acp-sessions.json`);
		const acp = createAcpAgentPort({ env: process.env, vars: env, path, sessionsFile, onError, ...cap });
		if (rex === undefined) return { agents: acp, dormant: acp.dormant };
		const both = createHandoverAgentPort({ from: acp, to: rexPort(rex) });
		return { agents: both, dormant: acp.dormant, handover: both };
	}
	if (agentAdapter === "tty") {
		const onError = (error: Error) => console.error("[soma] tty:", error.message);
		const agents = createTtyAgentPort({ spawn: spawnPty, env: process.env, onError, ...cap });
		return { agents, dormant: none, handover: notAcp };
	}
	return {
		agents: createHerdrAgentPort({ client: createHerdrClient({ socketPath: herdrSocket }), ...cap }),
		dormant: none,
		handover: notAcp,
	};
}
