// A scripted stand-in for the model, answering each request by its last message so it behaves the same
// in every process of a kill -9 run. No ANTHROPIC_API_KEY on this machine; see the schedule-tool card.
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

export function fauxModels(at: string) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const call = (name: string, args: Record<string, string>) =>
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
	const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
	const route: FauxResponseStep = (request) => {
		const last = request.messages.findLast((message) => message.role !== "system");
		if (last === undefined) return answer("?");
		const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
		const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		if (last.role === "toolResult") return answer(`好。${text}`);
		const fired = /^\[schedule \d+\] (.*)$/s.exec(text);
		if (fired !== null) return answer(`提醒你：${fired[1]}`);
		const remind = /提醒我\s*(.+)$/s.exec(text);
		if (remind?.[1] !== undefined) return call("schedule", { at, instruction: remind[1] });
		if (text.includes("列出排程")) return call("schedule_list", {});
		const cancel = /取消排程\s*(\d+)/.exec(text);
		if (cancel?.[1] !== undefined) return call("schedule_cancel", { id: cancel[1] });
		return answer("?");
	};
	faux.setResponses(Array.from({ length: 100 }, () => route));
	return { models, model: { provider: faux.provider.id, modelId: faux.getModel().id } };
}
