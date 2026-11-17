import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import type { Conversation, Harness, SubmissionDraft } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vitest";
import { ABILITIES as TELEGRAM_ABILITIES, ENTRY_KIND as TELEGRAM_KIND } from "../src/adapters/telegram/index.ts";
import { ABILITIES as TERMINAL_ABILITIES, ENTRY_KIND as TERMINAL_KIND } from "../src/adapters/terminal/index.ts";
import { ABILITIES as WEB_ABILITIES, ENTRY_KIND as WEB_KIND } from "../src/adapters/web/index.ts";
import { interfaces } from "../src/core/extensions/interfaces/index.ts";
import { openHarness, openStorage } from "../src/core/harness.ts";

const context = BACKGROUND_CONTEXT;
const texts = { [TELEGRAM_KIND]: TELEGRAM_ABILITIES, [TERMINAL_KIND]: TERMINAL_ABILITIES, [WEB_KIND]: WEB_ABILITIES };
const dirs: string[] = [];
let harness: Harness | undefined;
afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A root whose rounds each return the system prompt in effect for their request, and every section patch the
 * transcript holds by then. An earlier round's section stays in the transcript, so only the prompt in effect tells
 * what this round was shown.
 */
async function open(on: readonly string[]) {
	const dir = mkdtempSync(join(tmpdir(), "soma-interfaces-"));
	dirs.push(dir);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const storage = await openStorage(join(dir, "soma.sqlite"));
	harness = await openHarness(storage, [interfaces(storage, { texts, on: () => on })], context, { models });
	const root: Conversation = await harness.root(context, {
		agent: { model: { provider: "faux", modelId: "faux-1" } },
	});
	const seen: { prompt: string; patches: Record<string, string | null>[] }[] = [];
	const answer = (request: TranscriptContext) => {
		seen.push({
			prompt: getCurrentSystemPrompt(request.messages),
			patches: request.messages.flatMap((m) => (m.role === "system" && m.sections ? [m.sections] : [])),
		});
		return fauxAssistantMessage("好。");
	};
	return async (draft: Omit<Extract<SubmissionDraft, { type: "input" }>, "type">) => {
		const before = seen.length;
		faux.setResponses([answer]);
		expect((await (await root.submit({ type: "input", ...draft }, context)).wait(context)).status).toBe("done");
		const request = seen[before];
		if (request === undefined) throw new Error("the round made no request");
		return request;
	};
}

test("a round from an interface is told that interface's text, not another's", async () => {
	const round = await open([TELEGRAM_KIND, TERMINAL_KIND, WEB_KIND]);

	const fromTelegram = (await round({ content: "hi", entry: { kind: TELEGRAM_KIND }, requestId: "telegram:1" })).prompt;
	expect(fromTelegram).toContain(TELEGRAM_ABILITIES);
	expect(fromTelegram).not.toContain(TERMINAL_ABILITIES);
	expect(fromTelegram).not.toContain(WEB_ABILITIES);

	const fromTerminal = (await round({ content: "hi", entry: { kind: TERMINAL_KIND }, requestId: "terminal:1" })).prompt;
	expect(fromTerminal).toContain(TERMINAL_ABILITIES);
	expect(fromTerminal).not.toContain(TELEGRAM_ABILITIES);
});

test("a round no interface started is told the texts of the interfaces on, and of none off", async () => {
	const round = await open([TELEGRAM_KIND, WEB_KIND]);

	const scheduled = (await round({ content: "tick", entry: { kind: "schedule" }, requestId: "schedule:1" })).prompt;
	expect(scheduled).toContain(TELEGRAM_ABILITIES);
	expect(scheduled).toContain(WEB_ABILITIES);
	expect(scheduled).not.toContain(TERMINAL_ABILITIES);

	// After a Telegram round, so the digest round's section is its own and not the schedule round's left in place.
	await round({ content: "hi", entry: { kind: TELEGRAM_KIND }, requestId: "telegram:1" });
	const digest = (await round({ content: "digest", requestId: "digest:1" })).prompt;
	expect(digest).toContain(TELEGRAM_ABILITIES);
	expect(digest).toContain(WEB_ABILITIES);
	expect(digest).not.toContain(TERMINAL_ABILITIES);
});

test("a round with no interface on still has the section, so no section is ever removed", async () => {
	const round = await open([]);

	await round({ content: "hi", entry: { kind: TELEGRAM_KIND }, requestId: "telegram:1" });
	const scheduled = await round({ content: "tick", entry: { kind: "schedule" }, requestId: "schedule:1" });
	expect(scheduled.prompt).toContain("<interface>");
	expect(scheduled.prompt).not.toContain(TELEGRAM_ABILITIES);
	expect(scheduled.patches.flatMap(Object.values)).not.toContain(null);
});

test("Telegram's text names what it shows, the collapsed detail and the limit", () => {
	for (const said of ["markdown", "表格", "標題", "<details>", "32768"]) expect(TELEGRAM_ABILITIES).toContain(said);
	// Only the sentence that puts a long detail in a collapsed section under a one-line summary says these.
	expect(TELEGRAM_ABILITIES).toContain("長的細節放進收合的 `<details>` 區段");
	expect(TELEGRAM_ABILITIES).toContain("一行摘要");
});
