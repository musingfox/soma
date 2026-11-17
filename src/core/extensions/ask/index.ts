import { createHash } from "node:crypto";
import {
	type ConversationId,
	defineDoc,
	defineExtension,
	defineTool,
	type Storage,
	type Tx,
} from "@earendil-works/pi-durable";
import { arr, obj, str } from "@earendil-works/pi-schema";
import type { Choice } from "../../../ports/agent.ts";
import type { SaidChoices } from "../../../ports/human.ts";
import type { JobQuestion } from "../../domain/dispatch.ts";
import { MAX_OPTIONS, MIN_OPTIONS, OPTION_MAX_CHARS, optionsRefusal } from "../../domain/options.ts";
import { noticeEntry } from "../../notice.ts";
import { inputKinds } from "../interfaces/index.ts";

/**
 * A question asked the human, and the option they said once they pressed one. `job` names the turn of the job whose
 * agent listed the options; a question soma's model asked has none.
 */
export type Asked = { readonly options: Choice[]; readonly said?: string; readonly job?: JobQuestion };

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

/**
 * Records the options a job's agent listed at the end of its 需要你 reply as a question naming the job, in the commit
 * that tells the human of the turn, and returns its choices. The id comes from the job and its turn, so the same turn
 * asks once.
 */
export async function askForJob(
	tx: Tx,
	conversationId: ConversationId,
	asked: JobQuestion,
	labels: readonly string[],
): Promise<SaidChoices> {
	const question = createHash("sha256").update(`job\n${asked.card}\n${asked.turn}`).digest("hex").slice(0, 16);
	const options = labels.map((label, index) => ({ id: String(index + 1), label }));
	const doc = await tx.doc(Questions, conversationId);
	if (!Object.hasOwn(doc.questions, question)) doc.questions[question] = { options, job: asked };
	return { question, options, job: asked.card };
}

const text = (value: object, isError = false) => ({
	output: [{ type: "text" as const, text: JSON.stringify(value) }],
	isError,
});

/**
 * What the model is told to do once it asked, in the description and in the result: the question is the reply, and a
 * text after it reaches the human as a second message they did not want.
 */
const END_TURN =
	"end your turn with no text, unless the human needs something else besides the question; never restate the " +
	"question or its options.";

export interface AskOptions {
	/** The Harness's own storage, where the entry kinds of the running round's inputs are looked up. */
	readonly storage: Pick<Storage, "submission" | "entry">;
	/** The entry kinds of the interfaces' inputs: a question asked in a round one of them started replies to it. */
	readonly interfaces: readonly string[];
}

/**
 * The `ask` tool: one question to the human with a few options, as a `question` notice of class `action` whose choices
 * name no card. Asked in a round an interface's input started, it is part of the reply to that input: the notice names
 * that interface in `replyTo`, each one when a steered round mixes them. A press comes back as the human's input through
 * `HumanPort.say`; no agent is involved.
 */
export function askExtension({ storage, interfaces }: AskOptions) {
	const ask = defineTool({
		name: "ask",
		description:
			`Ask the human one question with ${MIN_OPTIONS} to ${MAX_OPTIONS} short options. Where their interface shows ` +
			"buttons they answer with one press; elsewhere they type the answer. Use it when the answer is one of " +
			"a small closed set, such as yes or no, now or later, or which of a few named things. Not for an open question, " +
			"one whose answer you cannot list: ask that in your reply. The question is sent to the human as its own message, " +
			`options included, so ${END_TURN} Their choice comes back as their next message, the option's label word for ` +
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
			const refused = optionsRefusal(args.options);
			if (refused !== undefined) return text({ asked: false, error: refused }, true);
			const question = createHash("sha256").update(api.callId).digest("hex").slice(0, 16);
			const kinds = await inputKinds(storage, api, api.conversationId, context);
			const replyTo = interfaces.filter((kind) => kinds.includes(kind));
			const choices: SaidChoices = {
				question,
				options: args.options.map((label, index) => ({ id: String(index + 1), label: label.trim() })),
			};
			await api.commit(async (tx) => {
				const doc = await tx.doc(Questions, api.conversationId);
				if (doc.questions[question] !== undefined) return;
				doc.questions[question] = { options: choices.options };
				await tx.appendEntry(
					api.conversationId,
					noticeEntry("question", "action", args.question, choices, undefined, replyTo),
				);
			}, context);
			return text({ asked: true, note: `The question has been sent to the human as its own message: ${END_TURN}` });
		},
	});
	return defineExtension({ name: "soma.ask", tools: [ask] });
}
