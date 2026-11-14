// WHEN A MOCKUP CARD MAY LOAD ITS PICTURE, WHICH ADDRESS IT KEEPS, THE LIVE FRAME SLOTS, AND WHICH FILE A CARD ASKS FOR

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { cardGrant } from '../../src/lib/server/mockups/thumbs';
import {
	MAX_LIVE_FRAMES,
	MIN_SECONDS_LEFT,
	addressToShow,
	expiryOf,
	fileKey,
	mayLoad,
	planSlot,
	secondsLeft
} from '../../src/lib/board/thumbLoad';

// -- CONSTANTS -- //

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const at = (secondsFromNow: number, sig = 'abc') =>
	`/mf/o/p/m/1/thumb?exp=${Math.floor(NOW / 1000) + secondsFromNow}&sig=${sig}`;

// -- FUNCTIONS -- //

describe('the address of a card', () => {
	it('names the file by the part before the question mark', () => {
		expect(fileKey(at(300, 'one'))).toBe('/mf/o/p/m/1/thumb');
		expect(fileKey(at(10, 'two'))).toBe(fileKey(at(300, 'one')));
		expect(fileKey('/plain')).toBe('/plain');
	});
	it('reads the expiry and counts the seconds left', () => {
		expect(expiryOf(at(300))).toBe(Math.floor(NOW / 1000) + 300);
		expect(expiryOf('/mf/x?exp=abc')).toBeNull();
		expect(expiryOf('/mf/x')).toBeNull();
		expect(secondsLeft(at(45), NOW)).toBe(45);
		expect(secondsLeft(at(-5), NOW)).toBe(-5);
		expect(secondsLeft('/mf/x', NOW)).toBe(Number.POSITIVE_INFINITY);
	});
	it('may load only with at least 30 seconds left', () => {
		expect(MIN_SECONDS_LEFT).toBe(30);
		expect(mayLoad(at(300), NOW)).toBe(true);
		expect(mayLoad(at(30), NOW)).toBe(true);
		expect(mayLoad(at(29), NOW)).toBe(false);
		expect(mayLoad(at(-1), NOW)).toBe(false);
	});
	it('keeps the address it loaded with for the same file, and takes the new one for another file', () => {
		const first = at(300, 'first');
		const second = at(300, 'second');
		expect(addressToShow(null, first)).toBe(first);
		expect(addressToShow(first, second)).toBe(first);
		const other = '/mf/o/p/m/2/thumb?exp=1&sig=z';
		expect(addressToShow(first, other)).toBe(other);
	});
});

describe('live frame slots', () => {
	const slots = (n: number) => new Map(Array.from({ length: n }, (_, i) => [`c${i}`, 100 + i]));
	it('grants a slot while there is room, and again to a card that already has one', () => {
		expect(planSlot(slots(3), 'new', 500)).toEqual({ grant: true, evict: null });
		expect(planSlot(slots(MAX_LIVE_FRAMES), 'c4', 9999)).toEqual({ grant: true, evict: null });
	});
	it('gives a nearer card the place of the farthest one when all slots are used', () => {
		const full = slots(MAX_LIVE_FRAMES);
		expect(MAX_LIVE_FRAMES).toBe(12);
		expect(planSlot(full, 'near', 10)).toEqual({ grant: true, evict: 'c11' });
	});
	it('refuses a card that is farther than every live one', () => {
		expect(planSlot(slots(MAX_LIVE_FRAMES), 'far', 5000)).toEqual({ grant: false, evict: null });
	});
});

describe('which file a card asks for', () => {
	const m = { id: 'm1', projectId: 'p1', currentVersion: 3, hasShot: false };
	it('asks for the screenshot when the current version has one', () => {
		expect(cardGrant('o1', { ...m, hasShot: true })).toEqual({
			grant: { orgId: 'o1', projectId: 'p1', mockupId: 'm1', version: 3, kind: 'shot' },
			live: false
		});
	});
	it('asks for the live preview page when it has none', () => {
		expect(cardGrant('o1', m)).toEqual({
			grant: { orgId: 'o1', projectId: 'p1', mockupId: 'm1', version: 3, kind: 'thumb' },
			live: true
		});
	});
});
