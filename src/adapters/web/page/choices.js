// The options of a question soma asked, as buttons in the fox's bubble. A press says that option once: every button
// is disabled at once, and the question settles on the label the core says was chosen, here or on another interface.

/** A box of one button per option; the first press calls `onChoose` with the option's id, and later ones do nothing. */
export function renderChoices(options, onChoose, doc = document) {
	const box = doc.createElement("div");
	box.className = "choices";
	for (const { id, label } of options) {
		const button = doc.createElement("button");
		button.type = "button";
		button.textContent = label;
		button.addEventListener("click", (event) => {
			// A tap on the bubble lets it go; a tap on an option must not.
			event.stopPropagation();
			if (box.dataset.state) return;
			box.dataset.state = "pressed";
			for (const each of box.querySelectorAll("button")) each.disabled = true;
			onChoose(id);
		});
		box.append(button);
	}
	return box;
}

/** The question is answered: one disabled button with the label chosen. */
export function settleChoices(box, label, doc = document) {
	const button = doc.createElement("button");
	button.type = "button";
	button.disabled = true;
	button.textContent = `已選：${label}`;
	box.replaceChildren(button);
	box.dataset.state = "said";
}

/**
 * What the page does with the answer to the human's words: a bubble, and a ring. A round that asked a question (`asked`)
 * rang with the question, which is the reply: its answer does not ring, and one with no text shows no bubble.
 */
export const answerShown = ({ text, asked = false }) => {
	const bubble = !asked || text.trim() !== "";
	return { bubble, ring: !asked };
};

/** Whether the box still waits for a press, so its bubble should not fade on its own. */
export const waiting = (box) => box !== undefined && !box.dataset.state;
