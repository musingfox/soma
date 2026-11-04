import { defineDoc } from "@earendil-works/pi-durable";
import type { Deferred } from "../../domain/defer.ts";

/**
 * Pending deferrals by task id; one leaves in the commit that ends its task. `sending` is set in the commit before its
 * prompt, while its job's reclaim waits. Its own module, so the reclaim can read it without importing the extension.
 */
export const Deferrals = defineDoc<{ items: Record<string, Deferred & { sending?: boolean }> }>({
	kind: "soma.defer.items",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: {} }),
	checkpointWhen: () => false,
});
