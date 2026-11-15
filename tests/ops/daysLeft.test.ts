import { describe, expect, it } from 'vitest';
import { daysLeft } from '../../src/lib/connect/daysLeft';

const now = new Date('2026-11-15T07:00:00Z');
const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);

describe('days left of a connection', () => {
	it('says how many days are left and keeps success while a week or more remains', () => {
		const r = daysLeft(inDays(28.2), inDays(-1.8), now)!;
		expect(r.days).toBe(28);
		expect(r.label).toBe('28 days left');
		expect(r.tone).toBe('success');
		expect(r.percent).toBe(94);
	});
	it('turns to a warning under a week', () => {
		const r = daysLeft(inDays(6.5), inDays(-23.5), now)!;
		expect(r.tone).toBe('warning');
		expect(r.label).toBe('6 days left');
	});
	it('uses the singular and then says it ends today', () => {
		expect(daysLeft(inDays(1.5), null, now)!.label).toBe('1 day left');
		expect(daysLeft(inDays(0.4), null, now)!.label).toBe('Ends today');
	});
	it('says Ended with a danger tone and an empty bar once the end has passed', () => {
		const r = daysLeft(inDays(-0.1), null, now)!;
		expect(r).toEqual({ days: 0, percent: 0, tone: 'danger', label: 'Ended' });
	});
	it('has nothing to say about a thing that never ends', () => {
		expect(daysLeft(null, null, now)).toBeNull();
	});
	it('takes the share against 90 days when the start is not known and never goes over 100', () => {
		expect(daysLeft(inDays(45), null, now)!.percent).toBe(50);
		expect(daysLeft(inDays(500), null, now)!.percent).toBe(100);
	});
	it('accepts ISO strings as the page data carries them', () => {
		expect(daysLeft(inDays(10).toISOString(), null, now)!.days).toBe(10);
	});
});
