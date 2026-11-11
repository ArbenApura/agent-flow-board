// WHICH WINDOWS EDIT LIVE (AFB-20261111-0035, 8.6): ONLY A PERSON WHO CAN WRITE OPENS A SESSION, SO ONLY THEY GET A PROVIDER

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { liveSnapshot, nextSession, sessionKey } from './session';

// -- FUNCTIONS -- //

const note = { id: 'n1', epoch: 2, version: 5, title: 'T' };

describe('liveSnapshot', () => {
	it('gives a writer a snapshot and a reader, or a note that is gone, nothing', () => {
		expect(liveSnapshot(note, true, 'text')).toEqual({
			noteId: 'n1',
			epoch: 2,
			version: 5,
			title: 'T',
			markdown: 'text'
		});
		expect(liveSnapshot(note, false, 'text')).toBeNull();
		expect(liveSnapshot(null, true, '')).toBeNull();
		expect(liveSnapshot(undefined, true, '')).toBeNull();
	});

	it('opens no session for a reader, so no provider is ever created for one', () => {
		expect(nextSession(null, liveSnapshot(note, false, 'text'))).toBeNull();
	});

	it('keeps a session through new page data of the same epoch and opens a new one for a new epoch', () => {
		const first = nextSession(null, liveSnapshot(note, true, 'a'));
		expect(first?.kind).toBe('open');
		if (first?.kind !== 'open') return;
		expect(nextSession(first.session, liveSnapshot({ ...note, version: 9 }, true, 'b'))?.kind).toBe(
			'keep'
		);
		const replaced = nextSession(first.session, liveSnapshot({ ...note, epoch: 3 }, true, 'c'));
		expect(replaced?.kind).toBe('open');
		expect(replaced?.session.key).toBe(sessionKey({ noteId: 'n1', epoch: 3 }));
	});
});
