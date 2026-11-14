// IMPORTED DEP-MODULES
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// IMPORTED MODULES
import { createOptimistic } from './optimistic.svelte.js';

// -- TESTS -- //

describe('optimistic tick state', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('shows the clicked value and spins only while the request is in flight', () => {
		const o = createOptimistic();
		const t = o.start('M1', 'done');
		expect(o.stateOf('M1', 'open')).toBe('done');
		expect(o.saving('M1')).toBe(true);
		o.settle('M1', t);
		expect(o.stateOf('M1', 'open')).toBe('done');
		expect(o.saving('M1')).toBe(false);
	});

	it('keeps a held value when the server data is still the old one, and drops it when it matches', () => {
		const o = createOptimistic();
		o.settle('M1', o.start('M1', 'done'));
		o.confirm({ M1: 'open' });
		expect(o.stateOf('M1', 'open')).toBe('done');
		o.confirm({ M1: 'done' });
		expect(o.stateOf('M1', 'open')).toBe('open');
		expect(o.has('M1')).toBe(false);
	});

	it('never drops a value that is still in flight, even when the data matches', () => {
		const o = createOptimistic();
		o.start('M1', 'done');
		o.confirm({ M1: 'done' });
		expect(o.saving('M1')).toBe(true);
	});

	it('the safety timer of an older click does not drop a newer click', () => {
		const o = createOptimistic(5000);
		o.settle('M1', o.start('M1', 'done'));
		vi.advanceTimersByTime(3000);
		const second = o.start('M1', 'open');
		vi.advanceTimersByTime(2500);
		expect(o.stateOf('M1', 'done')).toBe('open');
		expect(o.saving('M1')).toBe(true);
		o.settle('M1', second);
		vi.advanceTimersByTime(5000);
		expect(o.has('M1')).toBe(false);
	});

	it('a failure of an older click does not undo a newer click', () => {
		const o = createOptimistic();
		const first = o.start('M1', 'done');
		const second = o.start('M1', 'open');
		o.fail('M1', first);
		expect(o.stateOf('M1', 'done')).toBe('open');
		o.fail('M1', second);
		expect(o.stateOf('M1', 'done')).toBe('done');
	});

	it('gives up on a held value the server never confirms', () => {
		const o = createOptimistic(5000);
		o.settle('M2', o.start('M2', 'done'));
		vi.advanceTimersByTime(5001);
		expect(o.stateOf('M2', 'open')).toBe('open');
	});

	it('keeps keys apart', () => {
		const o = createOptimistic();
		o.settle('M1', o.start('M1', 'done'));
		o.start('1.1', 'waived');
		o.confirm({ M1: 'done', '1.1': 'waived' });
		expect(o.has('M1')).toBe(false);
		expect(o.has('1.1')).toBe(true);
	});
});
