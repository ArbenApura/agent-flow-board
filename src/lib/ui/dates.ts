// CALENDAR HELPERS FOR THE DATE AND TIME PICKERS. ALL DATES ARE LOCAL "YYYY-MM-DD" STRINGS, NEVER TIMESTAMPS.

// -- TYPES -- //

export type Day = { iso: string; day: number; inMonth: boolean; weekday: number };

// -- FUNCTIONS -- //

const pad = (n: number) => String(n).padStart(2, '0');

export const toIso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** Parses "YYYY-MM-DD" and refuses a date that does not exist (2026-02-31). */
export function parseIso(value: string): { y: number; m: number; d: number } | null {
	const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!hit) return null;
	const [y, m, d] = [Number(hit[1]), Number(hit[2]) - 1, Number(hit[3])];
	const check = new Date(y, m, d);
	return check.getFullYear() === y && check.getMonth() === m && check.getDate() === d
		? { y, m, d }
		: null;
}

/** Six weeks of days for a month grid, Monday first. */
export function monthGrid(year: number, month: number): Day[] {
	const first = new Date(year, month, 1);
	const offset = (first.getDay() + 6) % 7;
	const start = new Date(year, month, 1 - offset);
	return Array.from({ length: 42 }, (_, i) => {
		const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
		return {
			iso: toIso(d.getFullYear(), d.getMonth(), d.getDate()),
			day: d.getDate(),
			inMonth: d.getMonth() === month,
			weekday: i % 7
		};
	});
}

export function shiftMonth(
	year: number,
	month: number,
	by: number
): { year: number; month: number } {
	const d = new Date(year, month + by, 1);
	return { year: d.getFullYear(), month: d.getMonth() };
}

export const MONTHS = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
];
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "HH:MM" 24 hour time, refusing anything else. */
export function parseTime(value: string): { h: number; m: number } | null {
	const hit = /^(\d{2}):(\d{2})$/.exec(value);
	if (!hit) return null;
	const [h, m] = [Number(hit[1]), Number(hit[2])];
	return h < 24 && m < 60 ? { h, m } : null;
}

export const formatTime = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

export function formatLong(iso: string): string {
	const p = parseIso(iso);
	return p ? `${p.d} ${MONTHS[p.m]} ${p.y}` : '';
}
