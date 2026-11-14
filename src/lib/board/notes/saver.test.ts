// SAVING A NOTE: THE QUIET PERIOD, THE CONFLICT, A FAILED SAVE THAT KEEPS THE TEXT, AND A REFRESH THAT CHANGES NOTHING

// IMPORTED DEP-MODULES
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// IMPORTED MODULES
import { Saver, saveLine, type SaveRequest, type SaveStatus } from './saver.js';
import { nextSession, sessionKey, type NoteSnapshot } from './session.js';

// -- FUNCTIONS -- //

class Conflict extends Error {}

function setup(
	over: { send?: (r: SaveRequest) => Promise<{ version: number }>; online?: boolean } = {}
) {
	const sent: SaveRequest[] = [];
	const statuses: SaveStatus[] = [];
	const state = { online: over.online ?? true, version: 5 };
	const send =
		over.send ??
		(async (r: SaveRequest) => {
			sent.push(r);
			state.version++;
			return { version: state.version };
		});
	const saver = new Saver(
		{
			version: 5,
			send: async (r) => {
				const out = await send(r);
				return out;
			},
			isConflict: (e) => e instanceof Conflict,
			isOnline: () => state.online,
			onStatus: (s) => statuses.push(s)
		},
		{ markdown: 'start', title: 'T' }
	);
	return { saver, sent, statuses, state };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// -- TESTS -- //

describe('the quiet period', () => {
	it('sends two seconds after the last change, once, with the version and the title', async () => {
		const { saver, sent } = setup();
		saver.change({ markdown: 'a' });
		await vi.advanceTimersByTimeAsync(1500);
		saver.change({ markdown: 'ab' });
		await vi.advanceTimersByTimeAsync(1500);
		expect(sent).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(600);
		expect(sent).toEqual([{ markdown: 'ab', title: 'T', expectVersion: 5 }]);
		expect(saver.status).toBe('saved');
		expect(saver.currentVersion).toBe(6);
	});

	it('uses the new version for the next save', async () => {
		const { saver, sent } = setup();
		saver.change({ markdown: 'one' });
		await vi.advanceTimersByTimeAsync(2000);
		saver.change({ title: 'New title' });
		await vi.advanceTimersByTimeAsync(2000);
		expect(sent.map((s) => s.expectVersion)).toEqual([5, 6]);
		expect(sent[1].title).toBe('New title');
	});

	it('does not send when the text is back to the saved text', async () => {
		const { saver, sent } = setup();
		saver.change({ markdown: 'x' });
		saver.change({ markdown: 'start' });
		await vi.advanceTimersByTimeAsync(5000);
		expect(sent).toHaveLength(0);
		expect(saver.status).toBe('saved');
	});

	it('text typed while a save is on its way goes out in the next one', async () => {
		let release: (v: { version: number }) => void = () => {};
		const seen: SaveRequest[] = [];
		const { saver } = setup({
			send: (r) => {
				seen.push(r);
				return new Promise((res) => (release = res));
			}
		});
		saver.change({ markdown: 'one' });
		await vi.advanceTimersByTimeAsync(2000);
		expect(saver.status).toBe('saving');
		saver.change({ markdown: 'one two' });
		release({ version: 6 });
		await vi.advanceTimersByTimeAsync(0);
		expect(saver.status).toBe('pending');
		await vi.advanceTimersByTimeAsync(2000);
		release({ version: 7 });
		await vi.advanceTimersByTimeAsync(0);
		expect(seen.map((s) => s.markdown)).toEqual(['one', 'one two']);
		expect(seen[1].expectVersion).toBe(6);
		expect(saver.status).toBe('saved');
	});

	it('flush sends at once', async () => {
		const { saver, sent } = setup();
		saver.change({ markdown: 'now' });
		await saver.flush();
		expect(sent).toHaveLength(1);
	});
});

describe('a conflict', () => {
	it('stops, keeps the text and asks, and keeping mine saves over the newer version', async () => {
		let calls = 0;
		const seen: SaveRequest[] = [];
		const { saver, statuses } = setup({
			send: async (r) => {
				seen.push(r);
				if (calls++ === 0) throw new Conflict('stale');
				return { version: 11 };
			}
		});
		saver.change({ markdown: 'mine' });
		await vi.advanceTimersByTimeAsync(2000);
		expect(saver.status).toBe('conflict');
		expect(saver.markdown).toBe('mine');
		// No retry happens by itself, and more typing does not send either
		saver.change({ markdown: 'mine more' });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(seen).toHaveLength(1);
		saver.keepMine(10);
		await vi.advanceTimersByTimeAsync(0);
		expect(seen[1]).toEqual({ markdown: 'mine more', title: 'T', expectVersion: 10 });
		expect(saver.status).toBe('saved');
		expect(statuses).toContain('conflict');
	});

	it('taking their version replaces the text and is saved state', async () => {
		const { saver } = setup({
			send: async () => {
				throw new Conflict('stale');
			}
		});
		saver.change({ markdown: 'mine' });
		await vi.advanceTimersByTimeAsync(2000);
		saver.takeTheirs({ version: 9, markdown: 'theirs', title: 'Theirs' });
		expect(saver.status).toBe('saved');
		expect(saver.markdown).toBe('theirs');
		expect(saver.unsaved).toBe(false);
		expect(saver.currentVersion).toBe(9);
	});
});

describe('a failed save', () => {
	it('keeps the text and retries with a growing wait until it works', async () => {
		let calls = 0;
		const { saver } = setup({
			send: async () => {
				if (++calls < 3) throw new Error('network');
				return { version: 6 };
			}
		});
		saver.change({ markdown: 'precious' });
		await vi.advanceTimersByTimeAsync(2000);
		expect(saver.status).toBe('error');
		expect(saver.markdown).toBe('precious');
		expect(saver.unsaved).toBe(true);
		await vi.advanceTimersByTimeAsync(3000);
		expect(calls).toBe(2);
		expect(saver.status).toBe('error');
		await vi.advanceTimersByTimeAsync(5900);
		expect(calls).toBe(2);
		await vi.advanceTimersByTimeAsync(200);
		expect(calls).toBe(3);
		expect(saver.status).toBe('saved');
		expect(saver.unsaved).toBe(false);
	});

	it('offline waits for the connection and then sends', async () => {
		const { saver, sent, state } = setup({ online: false });
		saver.change({ markdown: 'typed offline' });
		await vi.advanceTimersByTimeAsync(2000);
		expect(saver.status).toBe('offline');
		expect(sent).toHaveLength(0);
		state.online = true;
		saver.online();
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(1);
		expect(saver.status).toBe('saved');
	});

	it('says what is happening in plain words', () => {
		expect(saveLine('saved')).toBe('Saved');
		expect(saveLine('saving')).toBe('Saving...');
		expect(saveLine('error')).toMatch(/^Could not save/);
	});
});

describe('page data that is read again', () => {
	const snap = (over: Partial<NoteSnapshot> = {}): NoteSnapshot => ({
		noteId: 'n1',
		epoch: 1,
		version: 5,
		title: 'T',
		markdown: 'start',
		...over
	});

	it('changes nothing for the same note and epoch, even when the text or version moved', () => {
		const first = nextSession(null, snap());
		expect(first?.kind).toBe('open');
		const again = nextSession(
			first?.session ?? null,
			snap({ version: 9, markdown: 'someone else typed' })
		);
		expect(again?.kind).toBe('keep');
		expect(again?.session).toBe(first?.session);
		expect(again?.session.snapshot.markdown).toBe('start');
	});

	it('opens a new session for a new epoch or another note', () => {
		const first = nextSession(null, snap())?.session ?? null;
		expect(nextSession(first, snap({ epoch: 2, markdown: 'replaced' }))?.kind).toBe('open');
		expect(nextSession(first, snap({ noteId: 'n2' }))?.kind).toBe('open');
		expect(sessionKey(snap({ epoch: 2 }))).toBe('n1:2');
		expect(nextSession(first, null)).toBeNull();
	});
});
