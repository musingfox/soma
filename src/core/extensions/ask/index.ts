import { createHash } from "node:crypto";
import { type ConversationId, defineDoc, defineExtension, defineTool, type Tx } from "@earendil-works/pi-durable";
import { arr, obj, str } from "@earendil-works/pi-schema";
import type { Choice } from "../../../ports/agent.ts";
import type { SaidChoices } from "../../../ports/human.ts";
import { noticeEntry } from "../../notice.ts";

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
/** An option is a button's text: a few words, not a sentence. */
export const OPTION_MAX_CHARS = 40;

/** A question soma's model asked the human, and the option they said once they pressed one. */
export type Asked = { readonly options: Choice[]; readonly said?: string };

/** The questions asked with options, by question id; one is settled in the commit that submits its press. */
export const Questions = defineDoc<{ questions: Record<string, Asked> }>({
	kind: "soma.ask.questions",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ questions: {} }),
	checkpointWhen: () => false,
});

/** The ids of the questions whose option was pressed, so their buttons are offered no more. */
export async function saidQuestions(tx: Tx, conversationId: ConversationId): Promise<Set<string>> {
	const { questions } = await tx.doc(Questions, conversationId);
	return new Set(Object.keys(questions).filter((id) => questions[id]?.said !== undefined));
}

const text = (value: object, isError = false) => ({
	output: [{ type: "text" as const, text: JSON.stringify(value) }],
	isError,
});

/** Why these option labels cannot be offered, if they cannot. */
function refusal(options: readonly string[]): string | undefined {
	if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS)
		return `give ${MIN_OPTIONS} to ${MAX_OPTIONS} options, not ${options.length}`;
	if (options.some((label) => label.trim() === "")) return "an option is empty";
	if (options.some((label) => [...label].length > OPTION_MAX_CHARS))
		return `an option is longer than ${OPTION_MAX_CHARS} characters: keep each to a few words`;
	if (new Set(options.map((label) => label.trim())).size !== options.length) return "two options are the same";
	return undefined;
}

/**
 * The `ask` tool: one question to the human with a few options, as a `question` notice of class `action` whose choices
 * name no card. A press comes back as the human's input through `HumanPort.say`; no agent is involved.
 */
export function askExtension() {
	const ask = defineTool({
		name: "ask",
		description:
			`Ask the human one question with ${MIN_OPTIONS} to ${MAX_OPTIONS} short options. Where their interface shows ` +
			"buttons they answer with one press; elsewhere they type the answer. Use it when the answer is one of " +
			"a small closed set, such as yes or no, now or later, or which of a few named things. Not for an open question, " +
			"one whose answer you cannot list: ask that in your reply. The question goes to the human as its own message, so " +
			"do not repeat it in your reply. Their choice comes back as their next message, the option's label word for " +
			"word; they may also type an answer instead. Write the question and options in the human's language, each " +
			`option a few words (at most ${OPTION_MAX_CHARS} characters).`,
		parameters: obj({
			question: str({ description: "The question, in the human's language" }),
			options: arr(str(), {
				description: `${MIN_OPTIONS} to ${MAX_OPTIONS} distinct answers, each a few words, in the order to show them`,
			}),
		}),
		// A rerun finds the question its first run asked by call id instead of asking again.
		replay: "safe",
		execute: async (args, api, context) => {
			const refused = refusal(args.options);
			if (refused !== undefined) return text({ asked: false, error: refused }, true);
			const question = createHash("sha256").update(api.callId).digest("hex").slice(0, 16);
			const choices: SaidChoices = {
				question,
				options: args.options.map((label, index) => ({ id: String(index + 1), label: label.trim() })),
			};
			await api.commit(async (tx) => {
				const doc = await tx.doc(Questions, api.conversationId);
				if (doc.questions[question] !== undefined) return;
				doc.questions[question] = { options: choices.options };
				await tx.appendEntry(api.conversationId, noticeEntry("question", "action", args.question, choices));
			}, context);
			return text({ asked: true });
		},
	});
	return defineExtension({ name: "soma.ask", tools: [ask] });
}
