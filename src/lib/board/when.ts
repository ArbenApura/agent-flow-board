// DATES FOR THE SETTINGS PAGES. EVERYTHING IS UTC AND DONE BY HAND, SO THE SERVER AND THE BROWSER WRITE THE SAME TEXT AND THE PAGE HYDRATES WITHOUT A JUMP

// -- CONSTANTS -- //

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;

// -- FUNCTIONS -- //

/** The UTC calendar day of a moment, as 2026-10-17. */
export const utcDay = (value: string | Date | number) => new Date(value).toISOString().slice(0, 10);

/** A date written for people, in UTC: 15 Jan 2027. */
export function formatUtcDate(value: string | Date | number): string {
	const d = new Date(value);
	return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The heading of a day group: Today, Yesterday, or the date. */
export function dayLabel(value: string | Date | number, now: number = Date.now()): string {
	const day = utcDay(value);
	if (day === utcDay(now)) return 'Today';
	if (day === utcDay(now - DAY_MS)) return 'Yesterday';
	return formatUtcDate(value);
}

/** The moment `days` days after `from`. */
export const addDays = (from: number, days: number) => from + days * DAY_MS;

/** Whole days between a moment and now. Negative once it has passed. */
export const daysUntil = (value: string | Date | number, now: number = Date.now()) =>
	Math.ceil((new Date(value).getTime() - now) / DAY_MS) || 0;

/** Groups events (newest first) by UTC day, keeping their order. */
export function groupByDay<T>(
	items: T[],
	when: (item: T) => string | Date | number,
	now: number = Date.now()
): { key: string; label: string; items: T[] }[] {
	const groups: { key: string; label: string; items: T[] }[] = [];
	for (const item of items) {
		const key = utcDay(when(item));
		const last = groups[groups.length - 1];
		if (last && last.key === key) last.items.push(item);
		else groups.push({ key, label: dayLabel(when(item), now), items: [item] });
	}
	return groups;
}
