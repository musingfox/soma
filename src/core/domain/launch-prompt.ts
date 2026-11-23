import { MAX_OPTIONS, MIN_OPTIONS, OPTION_MAX_CHARS, OPTIONS_LINE } from "./options.ts";

// Ported from musingfox/cc-mobile server/launch-prompt.ts @ d9f0690. Rule 1's options are read by `listedOptions`.
const LAUNCH_RULES = `你正在被無人值守地派工，操作者可能不在終端機前。請遵守三條規則：

1. 不要使用 AskUserQuestion 工具。需要問問題時，把問題寫在最終回覆裡，然後結束這一輪。要人從 ${MIN_OPTIONS} 到 ${MAX_OPTIONS} 個短選項中選一個時，在回覆最後寫一行「${OPTIONS_LINE}」，下面每行一個選項，從 1 依序編號，例如「1. A」「2. B」，每個選項不超過 ${OPTION_MAX_CHARS} 字，選項之後不要再寫任何東西。人會看到按鈕，按下的選項文字會原樣成為你的下一個提示。
2. Never run /clear: it replaces the session id, which breaks soma's binding of this job to your session.
3. 每一輪最終回覆的第一行必須恰好是下列三者之一：
結果：完成
結果：需要你
結果：失敗
`;

export function composeLaunchPrompt(cardContent: string): string {
	return `${LAUNCH_RULES}\n以下是任務卡：\n\n${cardContent}`;
}

/**
 * The first prompt soma gives a session handed over with `soma defer`: it now runs unattended as soma's job, so it
 * gets the rules a dispatched agent's brief opens with, and then `instruction`.
 */
export function composeHandoffPrompt(instruction: string): string {
	return `${LAUNCH_RULES}\n${instruction}`;
}

/** The line of a ticket agent's final reply, after the result line, that names the card it wrote. */
export const TICKET_CARD_LINE = "卡片：";

/**
 * The brief of an agent that writes the human's ticket as a card (ARCHITECTURE.md "Tickets the human asks for"). soma
 * writes no card itself: the agent does, with the obw pm skill, and names the card on its reply's second line, so the
 * notice that carries the reply tells the human which card it is.
 */
export function composeTicketPrompt(request: string): string {
	return (
		`${LAUNCH_RULES}\n` +
		"The human asked soma, their assistant, for a ticket, and soma handed the request to you. Your only work is to " +
		"write it as one obw task card with the obw pm skill:\n\n" +
		"- Write the card under pm/<project>/tasks/ of the vault and project this repository's .obsidian.yaml names.\n" +
		"- Read the code the request is about before writing, so the Description and the Acceptance Criteria name what " +
		"is really there. Do not make decisions the human has not made; write what is still open under Notes.\n" +
		"- Record the human's request as the card's source: quote it word for word in the Description, introduced as " +
		"the human's request through soma.\n" +
		"- Do not change code, commit or dispatch anything. If a card for this request already exists, write no " +
		"second one and name the existing card instead.\n" +
		`- The second line of your final reply is exactly ${TICKET_CARD_LINE}<the card's file name, without .md>.\n\n` +
		`The human's request:\n\n${request.trim()}`
	);
}
