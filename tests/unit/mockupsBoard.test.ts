// THE BROWSER SIDE HELPERS OF THE MOCKUP SCREENS: THE FILTERS, THE SCALE AND THE ONE MESSAGE A MOCKUP MAY SEND

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	boxPlace,
	filterMockups,
	focusMessage,
	frameColour,
	inPinFilter,
	isReadyMessage,
	onDevice,
	parsePinClick,
	parsePinKey,
	parsePinMessage,
	parsePinMove,
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
	const point = { x: 12.345, y: 99, clientX: 120, clientY: 340, viewW: 1280, viewH: 800 };
	const ok = { type: 'afb-mockup-pin', hint: 'button.save "Save"', ...point };

	it('accepts exactly the agreed shape from the preview frame and rounds the percent', () => {
		expect(parsePinMessage(ok, frame, frame)).toEqual({
			...point,
			x: 12.35,
			hint: 'button.save "Save"'
		});
	});
	it('ignores another window, no window, extra or missing keys, a wrong type, and numbers out of range or not numbers', () => {
		expect(parsePinMessage(ok, {}, frame)).toBeNull();
		expect(parsePinMessage(ok, undefined, undefined)).toBeNull();
		expect(parsePinMessage({ ...ok, body: 'text' }, frame, frame)).toBeNull();
		expect(parsePinMessage({ x: 1, y: 1, hint: '' }, frame, frame)).toBeNull();
		const { viewW: _gone, ...missing } = ok;
		expect(parsePinMessage(missing, frame, frame)).toBeNull();
		expect(parsePinMessage({ ...ok, type: 'afb-pin' }, frame, frame)).toBeNull();
		for (const bad of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY, '5'])
			expect(parsePinMessage({ ...ok, x: bad }, frame, frame)).toBeNull();
		expect(parsePinMessage({ ...ok, y: 101 }, frame, frame)).toBeNull();
		expect(parsePinMessage({ ...ok, viewW: 0 }, frame, frame)).toBeNull();
		expect(parsePinMessage({ ...ok, clientY: -5 }, frame, frame)).toBeNull();
		expect(parsePinMessage({ ...ok, hint: 5 }, frame, frame)).toBeNull();
		expect(parsePinMessage(null, frame, frame)).toBeNull();
		expect(parsePinMessage([ok], frame, frame)).toBeNull();
		expect(parsePinMessage('afb-mockup-pin', frame, frame)).toBeNull();
	});
	it('reads a drag, a pin click and a key in their own exact shapes, and nothing forged', () => {
		const move = { type: 'afb-pin-move', ...point };
		expect(parsePinMove(move, frame, frame)).toMatchObject({ x: 12.35, clientY: 340 });
		expect(parsePinMove({ ...move, hint: 'x' }, frame, frame)).toBeNull();
		expect(parsePinMove(move, {}, frame)).toBeNull();
		expect(parsePinMove(ok, frame, frame)).toBeNull();
		const id = '5b1f3c2a-1111-4222-8333-444455556666';
		expect(parsePinClick({ type: 'afb-pin-click', id }, frame, frame)).toBe(id);
		for (const bad of ['', 'x', `${id}<`, '../etc', 5, null])
			expect(parsePinClick({ type: 'afb-pin-click', id: bad }, frame, frame)).toBeNull();
		expect(parsePinClick({ type: 'afb-pin-click', id, body: 'x' }, frame, frame)).toBeNull();
		expect(parsePinClick({ type: 'afb-pin-click', id }, {}, frame)).toBeNull();
		expect(parsePinKey({ type: 'afb-pin-key', key: 'c' }, frame, frame)).toBe('c');
		expect(parsePinKey({ type: 'afb-pin-key', key: 'Escape' }, frame, frame)).toBe('Escape');
		for (const bad of ['x', 'C', 'Enter', 5])
			expect(parsePinKey({ type: 'afb-pin-key', key: bad }, frame, frame)).toBeNull();
		expect(parsePinKey({ type: 'afb-pin-key', key: 'c' }, {}, frame)).toBeNull();
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
			device: null,
			resolved: false,
			resolvedBy: null,
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
	const id = '5b1f3c2a-1111-4222-8333-444455556666';
	it('sends the pin mode and then only the place, number and state of each pin, never its text', () => {
		const pins = [
			{ id, x: 1, y: 2, n: 3, done: false, body: 'secret', author: 'Ann' } as {
				id: string;
				x: number;
				y: number;
				n: number;
				done: boolean;
			}
		];
		const [mode, list] = pinMessages(true, pins, {
			draft: { x: 5, y: 6 },
			accent: '#2563eb',
			ink: '#ffffff',
			reduced: true
		});
		expect(mode).toEqual({ type: 'afb-pin-mode', on: true });
		expect(list).toEqual({
			type: 'afb-pins',
			pins: [{ id, x: 1, y: 2, n: 3, done: false }],
			draft: { x: 5, y: 6 },
			accent: '#2563eb',
			ink: '#ffffff',
			reduced: true
		});
		expect(JSON.stringify(list)).not.toMatch(/secret|Ann/);
		expect(pinMessages(false, [])[1]).toEqual({
			type: 'afb-pins',
			pins: [],
			draft: null,
			accent: null,
			ink: null,
			reduced: false
		});
	});
	it('gives the frame a colour only when it is exactly #rrggbb', () => {
		expect(frameColour(' #2563EB ')).toBe('#2563EB');
		for (const bad of [
			'red',
			'#fff',
			'red;background:url(x)',
			'rgb(1,2,3)',
			'#12345g',
			'',
			null,
			undefined
		])
			expect(frameColour(bad)).toBeNull();
		expect(pinMessages(false, [], { accent: 'expression(alert(1))' })[1]).toMatchObject({
			accent: null
		});
	});
	it('asks the frame to show a pin by id', () => {
		expect(focusMessage(id, false)).toEqual({ type: 'afb-pin-focus', id, reduced: false });
	});
});

describe('comments by device and state', () => {
	it('shows an older pin with no device on every device, and a pin of a device only there', () => {
		expect(onDevice({ device: null }, 'phone')).toBe(true);
		expect(onDevice({ device: 'phone' }, 'phone')).toBe(true);
		expect(onDevice({ device: 'phone' }, 'laptop')).toBe(false);
	});
	it('filters open, resolved and all', () => {
		expect(inPinFilter({ resolved: false }, 'open')).toBe(true);
		expect(inPinFilter({ resolved: true }, 'open')).toBe(false);
		expect(inPinFilter({ resolved: true }, 'done')).toBe(true);
		expect(inPinFilter({ resolved: false }, 'done')).toBe(false);
		expect(inPinFilter({ resolved: true }, 'all')).toBe(true);
	});
});

describe('where the comment box goes', () => {
	const stage = { width: 1000, height: 700 };
	const box = { width: 380, height: 200 };
	const frame = { left: 100, top: 40, width: 800, height: 500 };
	it('sits to the right of the pin, scaled by the frame rectangle', () => {
		const at = boxPlace(
			{ clientX: 200, clientY: 100, viewW: 1600, viewH: 1000 },
			frame,
			stage,
			box
		);
		// The pin is at 100 + 200/1600*800 = 200, 40 + 100/1000*500 = 90
		expect(at).toEqual({ left: 222, top: 70 });
	});
	it('flips to the left near the right edge and stays inside the stage', () => {
		const right = boxPlace(
			{ clientX: 1500, clientY: 100, viewW: 1600, viewH: 1000 },
			frame,
			stage,
			box
		);
		expect(right.left + box.width).toBeLessThanOrEqual(stage.width - 8);
		expect(right.left).toBeLessThan(850);
		const low = boxPlace(
			{ clientX: 10, clientY: 990, viewW: 1600, viewH: 1000 },
			frame,
			stage,
			box
		);
		expect(low.top + box.height).toBeLessThanOrEqual(stage.height - 8);
		expect(low.left).toBeGreaterThanOrEqual(8);
	});
	it('shrinks the box to a narrow stage', () => {
		const at = boxPlace(
			{ clientX: 50, clientY: 50, viewW: 100, viewH: 100 },
			{ left: 0, top: 0, width: 300, height: 300 },
			{ width: 320, height: 400 },
			box
		);
		expect(at.left).toBeGreaterThanOrEqual(8);
		expect(at.left).toBeLessThanOrEqual(320 - 304 - 8 + 8);
	});
});
