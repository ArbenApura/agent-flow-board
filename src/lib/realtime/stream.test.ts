// A LIVE EDITING NOTICE GOES TO THE NOTE PAGE'S LISTENER AND NEVER TO THE PAGE REFRESH (AFB-20261111-0035, 8.1)

// -- DEP-MODULES -- //
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// -- MODULES -- //
import { connectStream, onNoteLive, type NoteLiveNotice } from './stream.svelte';

// -- TYPES -- //

type Handler = (e: { data?: string }) => void;

// -- FUNCTIONS -- //

/** An EventSource that lets the test fire events by name. */
class FakeSource {
	static last: FakeSource;
	readyState = 1;
	handlers = new Map<string, Handler[]>();
	constructor(readonly url: string) {
		FakeSource.last = this;
	}
	addEventListener(name: string, fn: Handler) {
		this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
	}
	close() {
		this.readyState = 2;
	}
	fire(name: string, data?: unknown) {
		for (const fn of this.handlers.get(name) ?? [])
			fn({ data: data === undefined ? undefined : JSON.stringify(data) });
	}
}

describe('the live stream', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const open = () => {
		const onChange = vi.fn();
		const stop = connectStream(
			'/x',
			{ lost: false },
			onChange,
			FakeSource as unknown as typeof EventSource
		);
		// The first open refetches once; that one is not what these tests look at
		FakeSource.last.fire('open');
		vi.advanceTimersByTime(500);
		onChange.mockClear();
		return { onChange, stop, source: FakeSource.last };
	};

	it('a note notice reaches the note listener and refreshes no page', () => {
		const { onChange, stop, source } = open();
		const got: NoteLiveNotice[] = [];
		const off = onNoteLive((n) => got.push(n));
		source.fire('note', { note: 'n1', epoch: 2, seq: 7 });
		source.fire('presence', { note: 'n1', epoch: 2, data: 'AQID' });
		vi.advanceTimersByTime(1000);
		expect(onChange).not.toHaveBeenCalled();
		expect(got).toEqual([
			{ kind: 'note', note: 'n1', epoch: 2, seq: 7 },
			{ kind: 'presence', note: 'n1', epoch: 2, data: 'AQID' }
		]);
		off();
		source.fire('note', { note: 'n1', epoch: 2, seq: 8 });
		expect(got).toHaveLength(2);
		stop();
	});

	it('a malformed notice is dropped', () => {
		const { onChange, stop, source } = open();
		const got: NoteLiveNotice[] = [];
		const off = onNoteLive((n) => got.push(n));
		source.fire('note', { seq: 1 });
		source.fire('note', 'text');
		vi.advanceTimersByTime(1000);
		expect(got).toEqual([]);
		expect(onChange).not.toHaveBeenCalled();
		off();
		stop();
	});

	it('tells the note listener when the stream comes back after a drop, and not on the first open', () => {
		const onChange = vi.fn();
		const stop = connectStream(
			'/x',
			{ lost: false },
			onChange,
			FakeSource as unknown as typeof EventSource
		);
		const got: NoteLiveNotice[] = [];
		const off = onNoteLive((n) => got.push(n));
		const source = FakeSource.last;
		source.fire('open');
		expect(got).toEqual([]);
		source.fire('error');
		source.fire('open');
		expect(got).toEqual([{ kind: 'reconnected' }]);
		off();
		stop();
	});

	it('an item event still refreshes the page', () => {
		const { onChange, stop, source } = open();
		source.fire('change', { kind: 'event', verb: 'item.update', item: null });
		vi.advanceTimersByTime(500);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(true);
		stop();
	});
});
