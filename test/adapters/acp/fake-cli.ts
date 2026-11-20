// A stand-in for the Claude CLI claude-agent-acp spawns: the fake agent's one child, which lives on its own once the agent
// is gone. It appends its pid to $FAKE_ACP_PROJECTS/cli once it is ready, and exits $FAKE_ACP_CLI ms after its stdin ends,
// as the agent's exit ends it; "forever" never exits.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const projects = process.env.FAKE_ACP_PROJECTS ?? "/nonexistent";
const linger = process.env.FAKE_ACP_CLI ?? "0";
setInterval(() => {}, 1_000);
process.stdin.on("end", () => {
	if (linger !== "forever") setTimeout(() => process.exit(0), Number(linger));
});
process.stdin.resume();
mkdirSync(projects, { recursive: true });
appendFileSync(join(projects, "cli"), `${process.pid}\n`);
