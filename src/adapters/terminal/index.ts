import { createInterface } from "node:readline";
import type { AgentState } from "../../ports/agent.ts";
import { type Delivery, deliveryTo, type HumanPort, type SomaEvent } from "../../ports/human.ts";
import {
	formatProgramStatus,
	isProgramStatusReply,
	PROGRAM_STATUS_QUERY,
	type ProgramStatus,
} from "./program-status.ts";

export interface TerminalInput extends NodeJS.ReadableStream {
	readonly isTTY?: boolean;
	setRawMode?(raw: boolean): unknown;
}

export interface TerminalOutput extends NodeJS.WritableStream {
	readonly isTTY?: boolean;
}

export interface TerminalOptions {
	readonly human: HumanPort;
	readonly input: TerminalInput;
	readonly output: TerminalOutput;
	/** `true` sends OSC 7501 without asking the terminal, `false` never sends it. */
	readonly programStatus?: boolean;
	readonly probeTimeoutMs?: number;
}

const DEVICE_ATTRIBUTES_QUERY = "\x1b[c";
const DEVICE_ATTRIBUTES_REPLY = "\x1b[?";
const PROGRAM_STATUS_REPLY = "\x1b]7501;?";
/** The entry kind of this client's inputs, by which the core says what this terminal does with each push. */
export const ENTRY_KIND = "chat.terminal";

/**
 * Ask whether the terminal supports OSC 7501. Every terminal answers the device attributes query that follows it,
 * so a 7501 reply arriving first means supported, and the DA reply alone means not. Raw mode keeps the replies
 * off the screen and out of the line reader.
 */
export async function detectProgramStatus(
	input: TerminalInput,
	output: TerminalOutput,
	override: boolean | undefined,
	timeoutMs = 1000,
): Promise<boolean> {
	if (override !== undefined) return override;
	if (!input.isTTY || !output.isTTY || input.setRawMode === undefined) return false;
	input.setRawMode(true);
	let received = "";
	try {
		return await new Promise<boolean>((resolve) => {
			const done = (supported: boolean) => {
				clearTimeout(timer);
				input.off("data", onData);
				resolve(supported);
			};
			const onData = (chunk: Buffer | string) => {
				received += chunk.toString();
				const da = received.indexOf(DEVICE_ATTRIBUTES_REPLY);
				if (da < 0 || !received.slice(da).includes("c")) return;
				const before = received.slice(0, da);
				const reply = before.indexOf(PROGRAM_STATUS_REPLY);
				done(reply >= 0 && isProgramStatusReply(before.slice(reply)));
			};
			const timer = setTimeout(() => done(false), timeoutMs);
			input.on("data", onData);
			output.write(PROGRAM_STATUS_QUERY + DEVICE_ATTRIBUTES_QUERY);
		});
	} finally {
		input.setRawMode(false);
		input.pause();
	}
}

/** `job/<card>`, cut and cleaned to the spec's 32-byte segment. */
export function jobRecordId(card: string): string {
	return `job/${card.replace(/[^A-Za-z0-9_.+-]/g, "-").slice(0, 32) || "-"}`;
}

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

function jobStatus(card: string, status: AgentState): ProgramStatus {
	const { state, msg } = status;
	const kind = status.state === "blocked" ? status.kind : undefined;
	return { state, id: jobRecordId(card), title: card, ...(kind && { kind }), ...(msg && { message: msg }) };
}

/**
 * The development terminal client: each stdin line is an input, answers and failures of this client's inputs,
 * failures of rounds the core started, and notices are printed, and soma's state goes to the terminal as OSC 7501 records when the terminal supports them.
 * Resolves when stdin ends.
 */
export async function runTerminal(options: TerminalOptions): Promise<void> {
	const { human, input, output } = options;
	const programStatus = await detectProgramStatus(input, output, options.programStatus, options.probeTimeoutMs);
	const print = (line: string) => output.write(`${line}\n`);

	let running = false;
	// What waits for the human: a question blocks soma, a report is done and a failed round is an error until the
	// human types again.
	let attention: ProgramStatus | undefined;
	let lastRoot = "";
	const report = (status: ProgramStatus) => {
		if (programStatus) output.write(formatProgramStatus(status));
	};
	const reportRoot = () => {
		const status: ProgramStatus =
			attention?.state === "blocked" ? attention : running ? { state: "working" } : (attention ?? { state: "idle" });
		const sequence = formatProgramStatus({ ...status, app: "soma" });
		if (sequence === lastRoot) return;
		lastRoot = sequence;
		report({ ...status, app: "soma" });
	};
	// A push this terminal shows quietly is printed only: the root record is how this client rings.
	const notice = (kind: "question" | "report", content: string, delivery: Delivery) => {
		if (delivery === "log") return;
		print(`[${kind === "question" ? "問題" : "通知"}] ${content}`);
		if (delivery === "quiet") return;
		if (attention?.state !== "blocked" || kind === "question") {
			attention =
				kind === "question"
					? { state: "blocked", kind: "question", message: firstLine(content) }
					: { state: "done", message: firstLine(content) };
		}
	};

	const fail = (content: string, delivery: Delivery = "ring") => {
		if (delivery === "log") return;
		print(`[失敗] ${content}`);
		if (delivery === "quiet") return;
		if (attention?.state !== "blocked") attention = { state: "error", message: firstLine(content) };
	};

	const mine = new Set<string>();
	const onEvent = (event: SomaEvent) => {
		if (event.type === "run") running = event.state === "working";
		else if (event.type === "notice" && event.kind !== "forwarded")
			notice(event.kind, event.content, deliveryTo(event, ENTRY_KIND));
		else if (event.type === "answer") {
			if (mine.delete(event.requestId)) print(event.content);
			else if (event.class !== undefined) notice("report", event.content, deliveryTo(event, ENTRY_KIND));
		} else if (event.type === "failure") {
			if (mine.delete(event.requestId)) fail(event.reason);
			else if (event.class !== undefined)
				fail(`${event.requestId} 那一輪：${event.reason}`, deliveryTo(event, ENTRY_KIND));
		} else if (event.type === "job") report(jobStatus(event.card, event.status));
		reportRoot();
	};
	const unsubscribe = human.subscribe(onEvent);

	// requestIds dedupe for the conversation's whole life, so a counter restarting at 1 would swallow inputs.
	let last = 0;
	const lines = createInterface({ input, terminal: false });
	try {
		for await (const line of lines) {
			if (line.trim() === "") continue;
			last = Math.max(last + 1, Date.now());
			const requestId = `terminal:${last}`;
			mine.add(requestId);
			attention = undefined;
			reportRoot();
			await human.submit({ content: line, entry: { kind: ENTRY_KIND }, requestId });
		}
	} finally {
		unsubscribe();
	}
}
