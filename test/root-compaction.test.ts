import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import { describe, expect, test } from "vitest";
import { COMPACT_AT } from "../src/config.ts";
import { rootCompaction } from "../src/core/harness.ts";

/** Where pi-durable starts a background compaction and where a request waits for one, under `settings` for `model`. */
function thresholds(
	settings: ReturnType<typeof rootCompaction>,
	model: { provider: string; id: string; contextWindow: number },
) {
	// As pi-durable resolves it (dist/harness/compaction.js, compactionPolicy): the model's entry over the harness-wide one.
	const { modelOverrides, ...global } = settings ?? {};
	const policy = { ...DEFAULT_COMPACTION_POLICY, ...global, ...modelOverrides?.[`${model.provider}/${model.id}`] };
	const blocking = model.contextWindow - policy.reserveTokens;
	return { background: blocking - policy.backgroundTokens, blocking, keep: policy.keepRecentTokens };
}

describe("the compaction soma sets from compactAt and the root model's window", () => {
	test("compactAt 100000 on the 1,000,000 token window: background past 100000, waiting past 132768", () => {
		const models = createModels();
		models.setProvider(anthropicProvider());
		const haiku = models.getModel("anthropic", "claude-haiku-5-5");
		expect(haiku?.contextWindow).toBe(1_000_000);
		const settings = rootCompaction(COMPACT_AT, haiku);

		expect(settings).toEqual({
			modelOverrides: {
				"anthropic/claude-haiku-5-5": { reserveTokens: 867_232, backgroundTokens: 32_768, keepRecentTokens: 7_000 },
			},
		});
		expect(thresholds(settings, { provider: "anthropic", id: "claude-haiku-5-5", contextWindow: 1_000_000 })).toEqual({
			background: 100_000,
			blocking: 132_768,
			keep: 7_000,
		});
	});

	test("set for the root model only: another model keeps pi-durable's defaults", () => {
		const settings = rootCompaction(100_000, {
			provider: "anthropic",
			id: "claude-haiku-5-5",
			contextWindow: 1_000_000,
		});
		expect(thresholds(settings, { provider: "faux", id: "faux-1", contextWindow: 128_000 })).toEqual({
			background: 128_000 - 16_384 - 32_768,
			blocking: 128_000 - 16_384,
			keep: 20_000,
		});
	});

	test("a window too small for compactAt leaves pi-durable's defaults unchanged", () => {
		// 100000 + 32768 is not below 128000 - 16384.
		expect(rootCompaction(100_000, { provider: "faux", id: "faux-1", contextWindow: 128_000 })).toBeUndefined();
		// At the edge: a blocking threshold equal to the window less 16384 is not below it.
		expect(rootCompaction(100_000, { provider: "faux", id: "faux-1", contextWindow: 149_152 })).toBeUndefined();
		expect(rootCompaction(100_000, { provider: "faux", id: "faux-1", contextWindow: 149_153 })).toEqual({
			modelOverrides: { "faux/faux-1": { reserveTokens: 16_385, backgroundTokens: 32_768, keepRecentTokens: 7_000 } },
		});
	});

	test("a model the catalog does not know leaves pi-durable's defaults unchanged", () => {
		expect(rootCompaction(100_000, undefined)).toBeUndefined();
	});
});
