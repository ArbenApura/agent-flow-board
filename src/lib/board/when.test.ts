import { describe, expect, it } from 'vitest';
import { addDays, dayLabel, daysUntil, formatUtcDate, groupByDay, utcDay } from './when';

// 17 October 2026, late in the evening in UTC
const NOW = Date.UTC(2026, 9, 17, 23, 30);

describe('UTC dates', () => {
	it('writes a date the same way on every machine', () => {
		expect(formatUtcDate('2027-01-15T10:00:00Z')).toBe('15 Jan 2027');
		expect(formatUtcDate(Date.UTC(2026, 11, 1))).toBe('1 Dec 2026');
	});

	it('names today, yesterday and older days', () => {
		expect(dayLabel('2026-10-17T00:05:00Z', NOW)).toBe('Today');
		expect(dayLabel('2026-10-16T23:59:00Z', NOW)).toBe('Yesterday');
		expect(dayLabel('2026-10-01T12:00:00Z', NOW)).toBe('1 Oct 2026');
	});

	it('adds days and counts them back', () => {
		expect(formatUtcDate(addDays(NOW, 90))).toBe('15 Jan 2027');
		expect(daysUntil(addDays(NOW, 7), NOW)).toBe(7);
		expect(daysUntil(NOW - 1000, NOW)).toBe(0);
		expect(daysUntil(NOW - 3 * 86_400_000, NOW)).toBeLessThan(0);
	});

	it('groups newest first events by day and keeps their order', () => {
		const events = [
			{ id: 1, at: '2026-10-17T20:00:00Z' },
			{ id: 2, at: '2026-10-17T01:00:00Z' },
			{ id: 3, at: '2026-10-16T22:00:00Z' },
			{ id: 4, at: '2026-10-10T08:00:00Z' }
		];
		const groups = groupByDay(events, (e) => e.at, NOW);
		expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', '10 Oct 2026']);
		expect(groups[0].items.map((e) => e.id)).toEqual([1, 2]);
		expect(groups.map((g) => g.key)).toEqual(['2026-10-17', '2026-10-16', '2026-10-10']);
		expect(utcDay(events[0].at)).toBe('2026-10-17');
	});
});
