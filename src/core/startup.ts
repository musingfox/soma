import type { Harness } from "@earendil-works/pi-durable";

/**
 * Opens the HumanPort, then resumes `harness`'s tasks and runs `starts` (the root's own background tasks) in order.
 * The HumanPort passes on only the commits made after it began to watch, and a task the last process left may commit
 * a notice as soon as it runs, as a deferral whose agent left while soma was down does. Opening the HumanPort needs
 * no task to have run: its commits and watches start no scheduling.
 */
export async function startCore<H>(
	harness: Pick<Harness, "resume">,
	openHuman: () => Promise<H>,
	starts: readonly (() => Promise<void>)[] = [],
): Promise<H> {
	const human = await openHuman();
	harness.resume();
	for (const start of starts) await start();
	return human;
}
