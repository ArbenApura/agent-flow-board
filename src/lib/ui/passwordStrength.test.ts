import { describe, expect, it } from 'vitest';
import { strengthOf } from './passwordStrength';

describe('password strength hint', () => {
	it('says how many characters are missing below the minimum', () => {
		expect(strengthOf('short', 10)).toMatchObject({ score: 1, tone: 'danger' });
		expect(strengthOf('123456789', 10).label).toBe('1 more character to go.');
	});

	it('moves past the length warning exactly at the minimum', () => {
		expect(strengthOf('a'.repeat(9), 10).tone).toBe('danger');
		expect(strengthOf('a'.repeat(10), 10).tone).not.toBe('danger');
	});

	it('accepts a long plain password but advises more', () => {
		expect(strengthOf('abcdefghijkl', 10)).toMatchObject({ score: 2, tone: 'warning' });
	});

	it('counts a long sentence as strong as symbols', () => {
		expect(strengthOf('correct horse battery staple', 10).score).toBeGreaterThanOrEqual(3);
		expect(strengthOf('Tr0ub4dor&3-and-a-long-tail', 10).score).toBe(4);
	});
});
