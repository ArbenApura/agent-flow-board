// ONE SHARED READER OF THE LIST FLAGS (rule R2, AFB-20261114-0611), AND THE LISTS THAT ARE NEVER CONVERTED

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { listFlag, strictList, HOSTNAME_PATTERN } from './listFlags.js';

// -- FUNCTIONS -- //

describe('the shared list flag helper', () => {
	it('takes one word, a comma list and separate words alike (rule R2)', () => {
		expect(listFlag(['--widths', '1280'], '--widths')).toBe('1280');
		expect(listFlag(['--widths', '1280,1600'], '--widths')).toBe('1280,1600');
		expect(listFlag(['--widths', '1280', '1600'], '--widths')).toBe('1280,1600');
		expect(listFlag(['--widths', '1280 1600'], '--widths')).toBe('1280,1600');
		// The flag is absent
		expect(listFlag(['--json'], '--widths')).toBeUndefined();
		// Another flag ends the list
		expect(listFlag(['--widths', '1280', '--json'], '--widths')).toBe('1280');
	});

	it('refuses a stray extra word on a strict list and checks every entry (rule R2)', () => {
		expect(strictList(['--keys', 'A_B,C2'], '--keys', /^[A-Z][A-Z0-9_]*$/, 'env keys')).toEqual([
			'A_B',
			'C2'
		]);
		// A quoted list is still comma-separated: a space in a key is refused, never split silently
		expect(() =>
			strictList(['--keys', 'A_B C2'], '--keys', /^[A-Z][A-Z0-9_]*$/, 'env keys')
		).toThrow(/not "A_B C2"/);
		// A trailing positional is never swallowed
		expect(() =>
			strictList(['--keys', 'A,B', 'C'], '--keys', /^[A-Z][A-Z0-9_]*$/, 'env keys')
		).toThrow(/extra word "C"/);
		// An entry that does not match the pattern is named
		expect(() =>
			strictList(['--keys', 'lower'], '--keys', /^[A-Z][A-Z0-9_]*$/, 'env keys')
		).toThrow(/not "lower"/);
		// The flag is absent
		expect(strictList(['--json'], '--keys', /^[A-Z][A-Z0-9_]*$/, 'env keys')).toBeUndefined();
	});

	it('keeps the host name pattern honest', () => {
		expect(HOSTNAME_PATTERN.test('localhost')).toBe(true);
		expect(HOSTNAME_PATTERN.test('afb.arbenger.com')).toBe(true);
		expect(HOSTNAME_PATTERN.test('https://afb.arbenger.com')).toBe(false);
		expect(HOSTNAME_PATTERN.test('a b')).toBe(false);
		expect(HOSTNAME_PATTERN.test('-bad-')).toBe(false);
	});
});
