// Ported from musingfox/cc-mobile server/launch-prompt.ts @ d9f0690.
const LAUNCH_RULES = `你正在被無人值守地派工，操作者可能不在終端機前。請遵守三條規則：

1. 不要使用 AskUserQuestion 工具。需要問問題時，把問題寫在最終回覆裡，然後結束這一輪。
2. Never run /clear: it replaces the session id, which breaks soma's binding of this job to your session.
3. 每一輪最終回覆的第一行必須恰好是下列三者之一：
結果：完成
結果：需要你
結果：失敗
`;

export function composeLaunchPrompt(cardContent: string): string {
	return `${LAUNCH_RULES}\n以下是任務卡：\n\n${cardContent}`;
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
