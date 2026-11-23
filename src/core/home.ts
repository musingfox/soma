import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";

/**
 * The conversation whose documents and transcript a conversation's tools act on: the conversation of the task that owns
 * it, followed until one has no owner. The root is its own home. A conversation a background task of the root makes
 * runs with the root's tools, and the event bridge, the reconcile, the jobs file and the HumanPort read only the root's:
 * what a tool kept in its own conversation would reach none of them. A conversation's owner never changes, so the home
 * read once in a call holds for the rest of it. Read it before the commit's first table write, as a commit must.
 */
export async function homeOf(tx: Tx, conversationId: ConversationId): Promise<ConversationId> {
	let id = conversationId;
	for (;;) {
		const owner = (await tx.conversation(id))?.owner;
		if (owner === undefined) return id;
		id = owner.conversationId;
	}
}

/** The home of the conversation a tool call runs in, read in a commit of its own. */
export const homeOfCall = (api: Pick<ToolExecutionApi, "commit" | "conversationId">, context: Context) =>
	api.commit((tx) => homeOf(tx, api.conversationId), context);
