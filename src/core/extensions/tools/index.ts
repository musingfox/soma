import { defineExtension, section } from "@earendil-works/pi-durable";

/**
 * The root conversation never ends while its tools come and go, and a model follows what it said before over its tool
 * list: on 2026-11-18 it answered that it had no web tool, quoting an answer it gave before the web tools existed,
 * while both were in its request.
 */
export const TOOLS_RULE =
	"你能做什麼，以現在的工具清單為準。工具會隨時間增加或移除，所以這段對話裡較早說過「沒有某個工具」或「做不到某件事」的話可能已經過時，你自己說過的也一樣。回答做不到之前，先看現在的工具清單；清單裡有合適的工具就直接用。";

export const tools = defineExtension({ name: "soma.tools", sections: [section("tools", () => TOOLS_RULE)] });
