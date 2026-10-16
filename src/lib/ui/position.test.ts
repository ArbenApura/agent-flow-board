import { describe, expect, it } from 'vitest';
import { place } from './position';

const view = { width: 800, height: 600 };
const panel = { width: 200, height: 150 };

describe('floating position', () => {
	it('opens below the anchor when there is room', () => {
		const p = place({ left: 100, top: 100, width: 80, height: 40 }, panel, view, 'bottom-start');
		expect(p.placement).toBe('bottom-start');
		expect(p.y).toBe(146);
		expect(p.x).toBe(100);
	});

	it('flips above when the bottom is too tight', () => {
		const p = place({ left: 100, top: 540, width: 80, height: 40 }, panel, view, 'bottom-start');
		expect(p.placement.startsWith('top')).toBe(true);
		expect(p.y).toBeLessThan(540);
	});

	it('keeps the panel inside the right edge and aligns to the end', () => {
		const p = place({ left: 760, top: 100, width: 30, height: 40 }, panel, view, 'bottom-start');
		expect(p.x + panel.width).toBeLessThanOrEqual(view.width - 8);
		const end = place({ left: 300, top: 100, width: 80, height: 40 }, panel, view, 'bottom-end');
		expect(end.x).toBe(300 + 80 - 200);
	});
});
