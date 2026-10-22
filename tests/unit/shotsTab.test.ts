// THE STATES OF THE UI SHOTS TAB: ONE PLAIN SENTENCE AND AT MOST ONE ACTION EACH

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	SLOW_MINUTES,
	TOOL_OFFLINE_SENTENCE,
	sameLook,
	screensOf,
	shotsTabState,
	since,
	viewOptions,
	viewportLabel,
	type ShotResultLite,
	type ShotsRunLite
} from '../../src/lib/shared/shotsTab';

// -- CONSTANTS -- //

const NOW = Date.parse('2026-10-22T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const run = (extra: Partial<ShotsRunLite> = {}): ShotsRunLite => ({
	id: `r${Math.random()}`,
	state: 'done',
	screens: 0,
	notes: [],
	reason: null,
	createdAt: ago(3),
	...extra
});
const ask = (runs: ShotsRunLite[], extra = {}) =>
	shotsTabState({
		runs,
		canWrite: true,
		toolOnline: true,
		canSeePictures: true,
		now: NOW,
		...extra
	});

// -- FUNCTIONS -- //

describe('the UI shots tab', () => {
	it('says how long ago in the same words as the rest of the board', () => {
		expect(since(ago(0.2), NOW)).toBe('just now');
		expect(since(ago(5), NOW)).toBe('5 min ago');
		expect(since(ago(180), NOW)).toBe('3 h ago');
		expect(since(ago(60 * 24 * 3), NOW)).toBe('3 d ago');
	});

	it('with nothing captured says what to do first, and offers the one button', () => {
		const s = ask([]);
		expect(s.key).toBe('none');
		expect(s.sentence).toMatch(/Nothing captured yet.*press Capture screens/);
		expect(s.button).toEqual({ show: true, disabled: false, reason: null });
		expect(s.shown).toBeNull();
	});

	it('shows no button to a person who may not write, and no instruction they cannot follow', () => {
		const s = ask([], { canWrite: false });
		expect(s.sentence).toBe('Nothing captured yet.');
		expect(s.button.show).toBe(false);
	});

	it('disables the button with the reason beside it when no tool is online, and keeps the pictures that exist', () => {
		const first = run({ screens: 4, createdAt: ago(60) });
		const s = ask([first], { toolOnline: false });
		expect(s.key).toBe('done');
		expect(s.button).toEqual({ show: true, disabled: true, reason: TOOL_OFFLINE_SENTENCE });
		expect(s.shown).toBe(first);
		expect(TOOL_OFFLINE_SENTENCE).not.toMatch(/runner|environment|protocol/i);
	});

	it('says a capture that nobody took is waiting for the tool, never "taking pictures"', () => {
		const s = ask([run({ state: 'queued', createdAt: ago(1) })]);
		expect(s.key).toBe('waiting');
		expect(s.sentence).toMatch(/^Waiting for the capture tool/);
		expect(s.button.disabled).toBe(true);
		expect(s.button.reason).toBe('A capture is already on its way.');
	});

	it('says when a capture is taking pictures, and when it has taken longer than usual', () => {
		const fresh = ask([run({ state: 'running', createdAt: ago(2) })]);
		expect(fresh.key).toBe('running');
		expect(fresh.sentence).toMatch(/^Taking pictures\. Started 2 min ago\.$/);
		expect(fresh.slow).toBe(false);
		const slow = ask([run({ state: 'running', createdAt: ago(SLOW_MINUTES + 1) })]);
		expect(slow.slow).toBe(true);
		expect(slow.sentence).toMatch(/longer than usual/);
		expect(slow.button.disabled).toBe(true);
	});

	it('explains a failure in one sentence and offers the same one action', () => {
		const s = ask([run({ state: 'failed', reason: 'The build failed.\nline two\nline three' })]);
		expect(s.key).toBe('failed');
		expect(s.sentence).toBe(
			'The last capture did not finish: The build failed. Press Capture screens to try again.'
		);
		expect(s.button.disabled).toBe(false);
		const bare = ask([run({ state: 'failed', reason: null })]);
		expect(bare.sentence).toBe(
			'The last capture did not finish. Press Capture screens to try again.'
		);
		const long = ask([run({ state: 'failed', reason: 'x'.repeat(400) })]);
		expect(long.sentence.length).toBeLessThan(260);
	});

	it('never tells a person to press a button that is disabled', () => {
		const failed = ask([run({ state: 'failed', reason: 'The build failed.' })], {
			toolOnline: false
		});
		expect(failed.button.disabled).toBe(true);
		expect(failed.sentence).toBe('The last capture did not finish: The build failed.');
		expect(failed.button.reason).toBe(TOOL_OFFLINE_SENTENCE);
		const late = ask([run({ state: 'timeout' })], { toolOnline: false });
		expect(late.sentence).not.toMatch(/Press Capture screens/);
	});

	it('tells a stopped-waiting capture apart: no tool, or not taken in time', () => {
		const offline = ask([run({ state: 'unavailable' })], { toolOnline: false });
		expect(offline.key).toBe('offline');
		expect(offline.sentence).toBe(TOOL_OFFLINE_SENTENCE);
		const late = ask([run({ state: 'timeout' })]);
		expect(late.sentence).toMatch(/not taken in time/);
		expect(late.button.disabled).toBe(false);
	});

	it('says no screen changed, and says up to date with the time of the capture it repeats', () => {
		const none = ask([run({ notes: ['No screen changed in this item.'] })]);
		expect(none.key).toBe('unchanged');
		expect(none.sentence).toBe('No screen changed in this item.');
		expect(none.button.disabled).toBe(false);
		const pictures = run({ screens: 3, createdAt: ago(90) });
		const repeat = run({ notes: ['Nothing changed since the last capture.'], createdAt: ago(2) });
		const up = ask([repeat, pictures]);
		expect(up.key).toBe('up-to-date');
		expect(up.sentence).toBe('Up to date. Nothing changed since the capture 2 h ago.');
		expect(up.shown).toBe(pictures);
	});

	it('shows the newest capture and at most two earlier ones, and counts screens in plain words', () => {
		const a = run({ screens: 1, createdAt: ago(0.2) });
		const b = run({ screens: 5, createdAt: ago(60) });
		const c = run({ screens: 2, createdAt: ago(120) });
		const d = run({ screens: 2, createdAt: ago(180) });
		const s = ask([a, run({ state: 'failed' }), b, c, d]);
		expect(s.key).toBe('done');
		expect(s.sentence).toBe('1 screen captured just now.');
		expect(s.shown).toBe(a);
		expect(s.earlier).toEqual([b, c]);
		expect(ask([b]).sentence).toBe('5 screens captured 1 h ago.');
	});

	it('gives a reader who may not see pictures the count and the reason, and no button', () => {
		const s = ask([run({ screens: 4, createdAt: ago(5) })], {
			canSeePictures: false,
			canWrite: false
		});
		expect(s.key).toBe('private');
		expect(s.sentence).toBe(
			'4 screens captured 5 min ago. Pictures are for members of this project.'
		);
		expect(s.shown).toBeNull();
		expect(s.earlier).toEqual([]);
		expect(s.button.show).toBe(false);
		expect(ask([], { canSeePictures: false, canWrite: false }).sentence).toBe(
			'Pictures are for members of this project.'
		);
	});

	describe('the screens of a capture', () => {
		const r = (
			page: string,
			side: string,
			theme: string,
			viewport: number,
			image?: string
		): ShotResultLite => ({
			page,
			state: '',
			theme,
			viewport,
			side,
			image
		});
		const results = [
			r('/a', 'after', 'dark', 390, 'a-dark-390'),
			r('/a', 'after', 'light', 1440, 'a-light-1440'),
			r('/a', 'before', 'light', 1440, 'b-light-1440'),
			r('/a', 'sibling', 'light', 1440, 'sib'),
			r('/b', 'after', 'light', 1440, 'c-light-1440'),
			r('/a', 'after', 'light', 390, 'a-light-390')
		];

		it('lists the colours and widths with light before dark and desktop before phone', () => {
			expect(viewOptions(results)).toEqual({ themes: ['light', 'dark'], viewports: [1440, 390] });
			expect(viewportLabel(1440)).toBe('Desktop');
			expect(viewportLabel(390)).toBe('Phone');
			expect(viewportLabel(768)).toBe('768 wide');
		});

		it('pairs each new picture with its old one, leaves siblings out and gives a new screen no Before', () => {
			expect(screensOf(results, { theme: 'light', viewport: 1440 })).toEqual([
				{ key: '/a|', page: '/a', state: '', after: 'a-light-1440', before: 'b-light-1440' },
				{ key: '/b|', page: '/b', state: '', after: 'c-light-1440', before: null }
			]);
			expect(screensOf(results, { theme: 'dark', viewport: 1440 })).toEqual([]);
		});

		it('lists a page once even when a row was repeated', () => {
			const twice = [...results, r('/a', 'after', 'light', 1440, 'again')];
			expect(screensOf(twice, { theme: 'light', viewport: 1440 }).map((s) => s.key)).toEqual([
				'/a|',
				'/b|'
			]);
		});

		it('says a screen looks the same only when both pictures have the very same checksum', () => {
			const [a, b] = screensOf(results, { theme: 'light', viewport: 1440 });
			expect(sameLook(a, { 'a-light-1440': 'x', 'b-light-1440': 'x' })).toBe(true);
			expect(sameLook(a, { 'a-light-1440': 'x', 'b-light-1440': 'y' })).toBe(false);
			expect(sameLook(a, {})).toBe(false);
			expect(sameLook(b, { 'c-light-1440': 'x' })).toBe(false);
		});
	});
});
