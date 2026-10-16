import { describe, expect, it } from 'vitest';
import { safeNext } from './next';

describe('safeNext', () => {
	it('keeps a path on this site', () => {
		expect(safeNext('/acme/items?tab=1')).toBe('/acme/items?tab=1');
		expect(safeNext('/invite/abc.def')).toBe('/invite/abc.def');
	});
	it('refuses another site, a protocol relative address, a backslash and anything not a string', () => {
		for (const bad of [
			'https://evil.example',
			'//evil.example',
			`/${String.fromCharCode(92)}evil.example`,
			'javascript:alert(1)',
			'',
			`/a${String.fromCharCode(10)}b`
		])
			expect(safeNext(bad), bad).toBe('/');
		expect(safeNext(null)).toBe('/');
		expect(safeNext(undefined)).toBe('/');
	});
});
