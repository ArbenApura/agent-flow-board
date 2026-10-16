import { describe, expect, it } from 'vitest';
import { formatLong, formatTime, monthGrid, parseIso, parseTime, shiftMonth } from './dates';

describe('calendar helpers', () => {
	it('parses a real date and refuses one that does not exist', () => {
		expect(parseIso('2026-10-15')).toEqual({ y: 2026, m: 9, d: 15 });
		expect(parseIso('2026-02-31')).toBeNull();
		expect(parseIso('15/10/2026')).toBeNull();
	});

	it('builds a six week grid starting on a Monday', () => {
		const grid = monthGrid(2026, 9);
		expect(grid).toHaveLength(42);
		expect(grid[0].weekday).toBe(0);
		expect(grid.find((d) => d.iso === '2026-10-01')?.inMonth).toBe(true);
		expect(grid.filter((d) => d.inMonth)).toHaveLength(31);
	});

	it('moves across a year boundary', () => {
		expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
		expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
	});

	it('parses and formats times', () => {
		expect(parseTime('09:05')).toEqual({ h: 9, m: 5 });
		expect(parseTime('24:00')).toBeNull();
		expect(formatTime(7, 3)).toBe('07:03');
		expect(formatLong('2026-10-15')).toBe('15 October 2026');
	});
});
