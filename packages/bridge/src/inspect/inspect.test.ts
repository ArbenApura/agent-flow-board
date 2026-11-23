// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { redactSignedAddress } from './inspect.js';
import { parseMockupRef } from './mockupTarget.js';

// -- FUNCTIONS -- //

describe('redactSignedAddress (rule R1)', () => {
	it('removes exp and sig from a signed mockup address wherever it appears in an error text', () => {
		const text =
			'goto https://mockups.example.test/mf/o/p/m/1/page?exp=1700000000&sig=abcDEF123 failed; also ?sig=zzz&exp=5';
		const out = redactSignedAddress(text);
		expect(out).not.toMatch(/sig=|exp=/);
		expect(out).toContain('mockups.example.test');
	});

	it('leaves a text with no signed address as it is', () => {
		expect(redactSignedAddress('Timeout 30000ms exceeded.')).toBe('Timeout 30000ms exceeded.');
	});
});

describe('parseMockupRef', () => {
	it('reads an id and an optional version after @', () => {
		const id = '3f1c2d4e-0000-4000-8000-000000000001';
		expect(parseMockupRef(id)).toEqual({ id, raw: id });
		expect(parseMockupRef(`${id}@3`)).toMatchObject({ id, version: 3 });
	});

	it('refuses a version that is not a whole number from 1 up', () => {
		const id = '3f1c2d4e-0000-4000-8000-000000000001';
		expect(() => parseMockupRef(`${id}@0`)).toThrow(/whole number/);
		expect(() => parseMockupRef(`${id}@x`)).toThrow(/whole number/);
	});
});
