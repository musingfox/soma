// Pane read smoke through the rex adapter, against the real rex server and real claude:
//   1. a dedicated rex session, labelled soma-smoke-<random>, is the hangar, with a job's window (a shell block labelled
//      with a session id) and a window "human" whose shell starts claude, as a pane the human opened in the hangar;
//   2. readScreen reads the job's pane, and reads it again once a second line was typed into it: the second read shows
//      the line the first could not;
//   3. listForeign lists the human's claude, and readForeignScreen reads its pane by that id, while the job's block is
//      refused as no foreign agent.
// Nothing is typed into claude, so no model turn runs. It destroys its rex session and its directory at the end, also
// on failure.
//   node smoke/rex-screen.ts
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createRexAgentPort } from "../src/adapters/rex/agent-port.ts";
import { createRexClient, defaultRexSocket } from "../src/adapters/rex/client.ts";
import {
	EmptyResultSchema,
	NewWindowResultSchema,
	SHELL_FLAVOR,
	TERMINAL,
	WriteResultSchema,
} from "../src/adapters/rex/schema.ts";
import { delay } from "./driver.ts";

const tag = Date.now().toString(36);
const card = `smoke-${tag}`;
const socketPath = process.env.SOMA_REX_SOCKET ?? defaultRexSocket(homedir());
const client = createRexClient({ socketPath, onError: () => {} });
const log = (step: string, value: unknown) => console.log(`${step.padEnd(10)} ${JSON.stringify(value)}`);

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(message);
}

/** Polls `read` until `ok` holds of what it returned, for up to `ms`; the last value read either way. */
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 15_000): Promise<T> {
	for (const deadline = Date.now() + ms; ; await delay(250)) {
		const value = await read().catch(() => undefined);
		if ((value !== undefined && ok(value)) || Date.now() > deadline) {
			if (value === undefined) throw new Error("nothing could be read");
			return value;
		}
	}
}

const created = await client.call(
	"session.create",
	{ label: `soma-smoke-${tag}` },
	z.object({ session_id: z.string() }).passthrough(),
);
const hangar = created.session_id;
// A plain directory under $TMPDIR, which claude trusts without its folder-trust dialog.
const directory = await mkdtemp(join(tmpdir(), "soma-rex-screen-"));
try {
	// rex takes a window, and the session's destroy, only from a connection attached to the session.
	await client.attach(hangar);
	log("hangar", { session: hangar, label: `soma-smoke-${tag}`, directory });
	const window = (label: string, block: string, input: string) =>
		client.call(
			"session.new_window",
			{
				session_id: hangar,
				window_label: label,
				focus: false,
				layout: { block: { flavor: SHELL_FLAVOR, label: block, options: { cwd: directory, initial_input: input } } },
			},
			NewWindowResultSchema,
		);
	const job = await window(card, randomUUID(), `echo FIRST-${tag}\n`);
	await window("human", "human", "claude\n");
	const jobBlock = job.block_ids?.[0] ?? "";
	const agents = createRexAgentPort({ client, sessionId: hangar, label: `soma-smoke-${tag}` });

	const first = await until(
		() => agents.readScreen(card),
		(text) => text.split("\n").some((line) => line.trim() === `FIRST-${tag}`),
	);
	check(
		first.split("\n").some((line) => line.trim() === `FIRST-${tag}`),
		`the job's pane never showed FIRST-${tag}`,
	);
	check(!first.includes(`SECOND-${tag}`), "the job's pane showed SECOND before it was typed");
	log("job", { lines: first.split("\n").length, last: first.trimEnd().split("\n").at(-1) });

	// Typed into the job's own shell, a pane this smoke made.
	await client.call(
		`${TERMINAL}.write`,
		{ session_id: hangar, block_id: jobBlock, args: { data: `echo SECOND-${tag}\n` } },
		WriteResultSchema,
	);
	const second = await until(
		() => agents.readScreen(card),
		(text) => text.split("\n").some((line) => line.trim() === `SECOND-${tag}`),
	);
	check(
		second.split("\n").some((line) => line.trim() === `SECOND-${tag}`),
		"a second read did not show the new line",
	);
	log("again", { lines: second.split("\n").length, last: second.trimEnd().split("\n").at(-1) });

	const listed = await until(
		() => agents.listForeign(),
		(found) => found.some((each) => each.session === `soma-smoke-${tag}`),
		30_000,
	);
	const human = listed.find((each) => each.session === `soma-smoke-${tag}`);
	check(human !== undefined, "the human's claude in the hangar was never listed as foreign");
	check(human?.id !== jobBlock, "the job's block was listed as foreign");
	const screen = await until(
		() => agents.readForeignScreen(human?.id ?? ""),
		(text) => text.trim() !== "",
	);
	check(screen.trim() !== "", "the human's claude pane read empty");
	log("foreign", { id: human?.id, label: human?.label, state: human?.status?.state, lines: screen.split("\n").length });
	const refused = await agents.readForeignScreen(jobBlock).then(
		() => "read",
		(error: Error) => error.message,
	);
	check(refused.startsWith(`no foreign agent ${jobBlock}`), `the job's block read as foreign: ${refused}`);
	log("refused", { refused });
	console.log("PASS");
} finally {
	await client
		.call("session.destroy", { session_id: hangar }, EmptyResultSchema)
		.catch((error: Error) => console.error(`destroy ${hangar}: ${error.message}`));
	client.close();
	await rm(directory, { recursive: true, force: true });
}
