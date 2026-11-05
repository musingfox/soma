import type { Delivery } from "../src/ports/human.ts";

/** The one interface a push rings on, or undefined when it rings nowhere. */
export const ringing = ({ delivery }: { readonly delivery?: Readonly<Record<string, Delivery>> }) =>
	Object.entries(delivery ?? {}).find(([, how]) => how === "ring")?.[0];
