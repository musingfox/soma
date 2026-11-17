export function renderChoices(
	options: readonly { readonly id: string; readonly label: string }[],
	onChoose: (option: string) => unknown,
	doc?: Document,
): HTMLElement;
export function settleChoices(box: HTMLElement, label: string, doc?: Document): void;
export function waiting(box: HTMLElement | undefined): boolean;
