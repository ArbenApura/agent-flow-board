// THE BROWSER SIDE HELPERS OF THE MOCKUP SCREENS: THE FILTERS, THE SCALE AND THE ONE MESSAGE A MOCKUP MAY SEND

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	filterMockups,
	isReadyMessage,
	parsePinMessage,
	pinMessages,
	pinsOf,
	readFilters,
	scaleFor,
	scopeCounts,
	screensOf,
	type PinRow
} from '../../src/lib/board/mockups';

// -- FUNCTIONS -- //

describe('pin messages', () => {
	const frame = {};
	const ok = { type: 'afb-mockup-pin', x: 12.345, y: 99, hint: 'button.save "Save"' };

	it('accepts exactly the agreed shape from the preview frame and rounds the numbers', () => {
		expect(parsePinMessage(ok, frame, frame)).toEqual({
			x: 12.35,
			y: 99,
			hint: 'button.save "Save"'
		});
	});
	it('ignores another window, no window, extra keys, a wrong type, and numbers out of range or not numbers', () => {
		expect(parsePinMessage(ok, {}, frame)).toBeNull();
		expect(parsePinMessage(ok, undefined, undefined)).toBeNull();
		expect(parsePinMessage({ ...ok, body: 'text' }, frame, frame)).toBeNull();
		expect(parsePinMessage({ x: 1, y: 1, hint: '' }, frame, frame)).toBeNull();
		expect(parsePinMessage({ ...ok, type: 'afb-pin' }, frame, frame)).toBeNull();
		for (const bad of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY, '5'])
			expect(parsePinMessage({ ...ok, x: bad }, frame, frame)).toBeNull();
		expect(parsePinMessage({ ...ok, y: 101 }, frame, frame)).toBeNull();
		expect(parsePinMessage({ ...ok, hint: 5 }, frame, frame)).toBeNull();
		expect(parsePinMessage(null, frame, frame)).toBeNull();
		expect(parsePinMessage([ok], frame, frame)).toBeNull();
		expect(parsePinMessage('afb-mockup-pin', frame, frame)).toBeNull();
	});
	it('strips control characters from the hint and cuts it to 120', () => {
		const r = parsePinMessage({ ...ok, hint: `a\u0000b\u001fc${'x'.repeat(200)}` }, frame, frame)!;
		expect(r.hint.startsWith('abc')).toBe(true);
		expect(r.hint).toHaveLength(120);
	});
	it('knows the ready message and nothing else', () => {
		expect(isReadyMessage({ type: 'afb-mockup-ready' }, frame, frame)).toBe(true);
		expect(isReadyMessage({ type: 'afb-mockup-ready', extra: 1 }, frame, frame)).toBe(false);
		expect(isReadyMessage({ type: 'afb-mockup-ready' }, {}, frame)).toBe(false);
	});
});

describe('the list', () => {
	const rows = [
		{ title: 'Settings page', plan: { ref: 'AFB-1', title: 'Add settings' } },
		{ title: 'Landing', plan: null },
		{ title: 'Room booking', plan: { ref: 'AFB-2', title: 'Rooms' } }
	];
	it('reads its filters from the address and falls back to the defaults', () => {
		expect(readFilters(new URLSearchParams('q=hello&scope=plan&view=list'))).toEqual({
			q: 'hello',
			scope: 'plan',
			view: 'list'
		});
		expect(readFilters(new URLSearchParams('scope=nope&view=grid'))).toEqual({
			q: '',
			scope: 'all',
			view: 'cards'
		});
		expect(readFilters(new URLSearchParams(`q=${'a'.repeat(300)}`)).q).toHaveLength(200);
	});
	it('filters by search over title, reference and plan title, and by scope', () => {
		expect(filterMockups(rows, { q: '', scope: 'all' })).toHaveLength(3);
		expect(filterMockups(rows, { q: 'afb-2', scope: 'all' }).map((r) => r.title)).toEqual([
			'Room booking'
		]);
		expect(filterMockups(rows, { q: 'SETTINGS', scope: 'all' })).toHaveLength(1);
		expect(filterMockups(rows, { q: '', scope: 'alone' }).map((r) => r.title)).toEqual(['Landing']);
		expect(filterMockups(rows, { q: 'room', scope: 'alone' })).toEqual([]);
		expect(scopeCounts(rows)).toEqual({ all: 3, plan: 2, alone: 1 });
	});
});

describe('screens and scale', () => {
	it('keeps the project order and never offers none', () => {
		expect(screensOf(['phone', 'wide'])).toEqual(['wide', 'phone']);
		expect(screensOf([])).toEqual(['wide', 'laptop', 'tablet', 'phone']);
		expect(screensOf(null)).toHaveLength(4);
		expect(screensOf(['huge'])).toHaveLength(4);
	});
	it('shrinks a wide mockup to the stage and never enlarges one', () => {
		expect(scaleFor(800, 1600)).toBe(0.5);
		expect(scaleFor(2000, 1280)).toBe(1);
		expect(scaleFor(0, 1280)).toBe(1);
		expect(scaleFor(Number.NaN, 1280)).toBe(1);
	});
	it('numbers the pins of one version in the order they were made', () => {
		const pin = (id: string, version: number, at: string): PinRow => ({
			id,
			version,
			x: 1,
			y: 1,
			hint: '',
			author: 'a',
			body: 'b',
			createdAt: at
		});
		const list = [
			pin('b', 1, '2026-11-07T10:05:00Z'),
			pin('c', 2, '2026-11-07T10:01:00Z'),
			pin('a', 1, '2026-11-07T10:00:00Z')
		];
		expect(pinsOf(list, 1).map((p) => p.id)).toEqual(['a', 'b']);
		expect(pinsOf(list, 3)).toEqual([]);
	});
});

describe('pin messages sent to the frame', () => {
	it('sends the pin mode and then only the positions of the pins, every time the frame is ready', () => {
		const pins = [{ x: 1, y: 2, body: 'secret' } as { x: number; y: number }];
		expect(pinMessages(true, pins)).toEqual([
			{ type: 'afb-pin-mode', on: true },
			{ type: 'afb-pins', pins: [{ x: 1, y: 2 }] }
		]);
		expect(pinMessages(false, [])[1]).toEqual({ type: 'afb-pins', pins: [] });
	});
});
