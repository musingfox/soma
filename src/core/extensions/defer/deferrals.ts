import { defineDoc } from "@earendil-works/pi-durable";
import type { Deferred } from "../../domain/defer.ts";
import type { Reclaim } from "../../domain/dispatch.ts";

/**
 * Pending deferrals by task id; one leaves in the commit that ends its task, or in the commit of its job's move, which
 * cancels it and whose task then ends when it next wakes. `sending` is set in the commit before its
 * prompt, while its job's reclaim waits; `resuming` while it holds its job `resuming`, starting the agent again, with
 * `before` the reclaim the job had until then, absent when it had none. Its own module, so the reclaim can read it
 * without importing the extension.
 */
export const Deferrals = defineDoc<{
	items: Record<string, Deferred & { sending?: boolean; resuming?: boolean; before?: Reclaim }>;
}>({
	kind: "soma.defer.items",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: {} }),
	checkpointWhen: () => false,
});
