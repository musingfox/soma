import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { memory } from "./core/extensions/memory/index.ts";
import { sleeper } from "./core/extensions/sleeper/index.ts";
import { openHarness } from "./core/harness.ts";

const context = BACKGROUND_CONTEXT;
const harness = await openHarness(process.env.SOMA_DB ?? "soma.sqlite", [sleeper, memory], context);
await harness.root(context);
harness.resume();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => void harness.close(context).then(() => process.exit(0)));
}
