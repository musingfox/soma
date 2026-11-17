import { parseHTML } from "linkedom";
import { expect, test } from "vitest";
import { renderChoices, settleChoices, waiting } from "../../../src/adapters/web/page/choices.js";

const { document, Event } = parseHTML("<!doctype html><html><body></body></html>");
const options = [
	{ id: "1", label: "好" },
	{ id: "2", label: "不用" },
];
const buttons = (box: Element) =>
	[...box.querySelectorAll("button")].map((button) => [button.textContent, (button as HTMLButtonElement).disabled]);
const press = (box: Element, index: number) =>
	box.querySelectorAll("button")[index]?.dispatchEvent(new Event("click", { bubbles: true }));

test("a question's options are one button each, and the first press says one option and disables them all", () => {
	const chosen: string[] = [];
	const box = renderChoices(options, (option: string) => chosen.push(option), document);
	let bubbled = 0;
	const bubble = document.createElement("div");
	bubble.append(box);
	bubble.addEventListener("click", () => bubbled++);
	expect(buttons(box)).toEqual([
		["好", false],
		["不用", false],
	]);
	expect(waiting(box)).toBe(true);

	press(box, 1);
	press(box, 0);
	expect(chosen).toEqual(["2"]);
	expect(buttons(box)).toEqual([
		["好", true],
		["不用", true],
	]);
	// The bubble's own tap, which lets it go, never sees a press.
	expect(bubbled).toBe(0);
	expect(waiting(box)).toBe(false);
});

test("a settled question shows one disabled button with the label said, and a press on it says nothing", () => {
	const chosen: string[] = [];
	const box = renderChoices(options, (option: string) => chosen.push(option), document);
	settleChoices(box, "不用", document);
	expect(buttons(box)).toEqual([["已選：不用", true]]);
	press(box, 0);
	expect(chosen).toEqual([]);
	expect(waiting(box)).toBe(false);
	expect(waiting(undefined)).toBe(false);
});
