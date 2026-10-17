import { defineExtension, section } from "@earendil-works/pi-durable";

/** `2026-10-18（星期日）14:05，時區 Asia/Taipei（GMT+08:00）`: what "今天" and "現在" mean to the model. */
export function renderNow(at: number, timeZone: string): string {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("zh-TW", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			weekday: "long",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
			timeZoneName: "longOffset",
		})
			.formatToParts(at)
			.map((part) => [part.type, part.value]),
	);
	return `現在是 ${parts.year}-${parts.month}-${parts.day}（${parts.weekday}）${parts.hour}:${parts.minute}，時區 ${timeZone}（${parts.timeZoneName}）。`;
}

export const clock = (now: () => number = Date.now, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) =>
	defineExtension({ name: "soma.clock", sections: [section("clock", () => renderNow(now(), timeZone))] });
