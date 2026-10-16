import { describe, expect, it } from 'vitest';
import {
	adjustForContrast,
	checkPalette,
	contrast,
	generatePalette,
	hexToOklch,
	oklchToHex
} from './palette';

describe('palette generator', () => {
	it('round trips a colour through OKLCH', () => {
		expect(oklchToHex(hexToOklch('#2563eb')).toLowerCase()).toBe('#2563eb');
	});

	it('measures black on white as 21:1', () => {
		expect(Math.round(contrast('#000000', '#ffffff'))).toBe(21);
	});

	it('every generated pair passes AA in light and dark for a range of seeds', () => {
		const seeds = [
			'#2563eb',
			'#ff0000',
			'#00ff00',
			'#ffff00',
			'#ffffff',
			'#000000',
			'#7c3aed',
			'#14b8a6',
			'#fde047',
			'#e11d48',
			'#888888',
			'#0f766e'
		];
		for (const seed of seeds) {
			const failing = checkPalette(generatePalette(seed)).filter((c) => !c.pass);
			expect(failing, `seed ${seed}`).toEqual([]);
		}
	});

	it('adjusts a low contrast seed (pale yellow) and says so', () => {
		const p = generatePalette('#fde047');
		expect(p.adjusted).toBe(true);
		expect(contrast(p.light.accent, '#ffffff')).toBeGreaterThanOrEqual(3);
		expect(contrast(p.light.accentInk, p.light.accent)).toBeGreaterThanOrEqual(4.5);
	});

	it('leaves a passing colour untouched', () => {
		expect(adjustForContrast('#16181d', ['#ffffff'], 4.5, 'darker')).toBe('#16181d');
	});

	it('refuses a value that is not a hex colour', () => {
		expect(() => generatePalette('blue')).toThrow(/Not a hex colour/);
	});
});
