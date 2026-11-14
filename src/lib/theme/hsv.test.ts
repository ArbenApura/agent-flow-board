// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { hexToHsv, hsvToHex } from '#lib/theme/hsv.js';

describe('hsv', () => {
	it('round trips colours', () => {
		for (const hex of ['#e11d48', '#2563eb', '#16a34a', '#000000', '#ffffff', '#64748b']) {
			expect(hsvToHex(hexToHsv(hex))).toBe(hex);
		}
	});

	it('reads the hue of a primary', () => {
		expect(hexToHsv('#ff0000').h).toBe(0);
		expect(hexToHsv('#00ff00').h).toBe(120);
		expect(hexToHsv('#0000ff').h).toBe(240);
	});
});
