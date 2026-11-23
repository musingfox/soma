import { expect, test, vi } from "vitest";
import { macNotifier } from "../../src/adapters/macos-notification/index.ts";

test("the notification's text goes to osascript as an argument, never into the script", async () => {
	const run = vi.fn(async () => ({}));
	const text = 'Telegram "down" " & do shell script "echo no';

	await macNotifier(run)(text);

	expect(run).toHaveBeenCalledOnce();
	expect(run).toHaveBeenCalledWith(
		"osascript",
		["-e", "on run argv", "-e", 'display notification (item 1 of argv) with title "soma"', "-e", "end run", text],
		expect.objectContaining({ timeout: expect.any(Number) }),
	);
});

test("a notification osascript fails on rejects, for the caller to report", async () => {
	const notify = macNotifier(async () => {
		throw new Error("osascript: not found");
	});

	await expect(notify("Telegram")).rejects.toThrow("osascript: not found");
});
