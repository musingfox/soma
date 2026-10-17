import { expect, test } from "vitest";
import { runSmoke } from "../smoke/driver.ts";

test("a sleeping background task survives SIGKILL and fires once at until", { timeout: 30_000 }, async () => {
	const report = await runSmoke(4_000, 1_500);
	expect(report.wakeups).toBe(1);
	expect(report.firedAt).toBeGreaterThanOrEqual(report.until);
});
