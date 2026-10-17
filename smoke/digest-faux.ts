// A scripted stand-in for the model that answers a digest input with one line naming each job and its result,
// and counts its calls. No ANTHROPIC_API_KEY on this machine; see the ten-minute-digest card.
//   SOMA_SMOKE_KILL_IN_DIGEST=1 kills the process with SIGKILL while answering, after the input was admitted.
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";

/** `fail` answers a digest input with a provider error instead of a report. */
export function digestModels(fail = false) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from({ length: 100 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
			const last = JSON.stringify(request.messages.at(-1)?.content ?? "");
			if (!last.includes("[digest ")) return fauxAssistantMessage([fauxText("?")]);
			if (process.env.SOMA_SMOKE_KILL_IN_DIGEST === "1") process.kill(process.pid, "SIGKILL");
			if (fail) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid x-api-key" });
			const jobs = [...last.matchAll(/卡片 (\S+?)（agent \S+?）結果：(\S+?)\\n/g)].map(
				([, card, outcome]) => `${card} ${outcome}`,
			);
			return fauxAssistantMessage([fauxText(`報告：${jobs.join("；")}`)]);
		}),
	);
	return {
		models,
		model: { provider: faux.provider.id, modelId: faux.getModel().id },
		calls: () => faux.state.callCount,
	};
}
