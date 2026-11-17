export function renderChoices(
	options: readonly { readonly id: string; readonly label: string }[],
	onChoose: (option: string) => unknown,
	doc?: Document,
): HTMLElement;
export function reopenChoices(box: HTMLElement): void;
export function settleChoices(box: HTMLElement, label: string, doc?: Document): void;
export function answerShown(answer: { readonly text: string; readonly asked?: boolean }): {
	bubble: boolean;
	ring: boolean;
};
export function waiting(box: HTMLElement | undefined): boolean;
