const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * When `at` falls, in epoch ms: an ISO 8601 date-time, or an ISO 8601 duration from `now` such as `PT2M`.
 * A model cannot turn "in two minutes" into a date-time without knowing the clock, so durations are accepted too.
 */
export function resolveAt(at: string, now: number): number {
	const duration = DURATION.exec(at);
	if (duration !== null && at !== "P" && !at.endsWith("T")) {
		const [days = 0, hours = 0, minutes = 0, seconds = 0] = duration.slice(1).map((part) => Number(part ?? 0));
		return now + (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
	}
	const time = Date.parse(at);
	if (Number.isNaN(time)) throw new RangeError(`at must be an ISO 8601 date-time or duration, got "${at}"`);
	if (time <= now) throw new RangeError(`at is in the past: ${new Date(time).toISOString()}`);
	return time;
}
