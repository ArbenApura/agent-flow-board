// A WRITE FROM OUTSIDE THE EDITOR (AN AGENT OR THE API) TO A NOTE THAT IS OPEN (AFB-20261111-0035, 8.5)
// The server half of "the text was replaced under an open editor": the earlier text is kept in History, the epoch rises, the
// live updates go, the old epoch can write nothing any more, and the open pages hear about it.

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
// -- MODULES -- //
import { createNote, getNote, updateNote } from '../../src/lib/server/ops/notes';
import {
	appendNoteUpdates,
	checkpointNote,
	readNoteUpdates
} from '../../src/lib/server/ops/noteSync';
import { getHub } from '../../src/lib/server/realtime/hub';
import type { Change } from '../../src/lib/server/realtime/notify';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The update that makes a document with this text. */
function typed(text: string) {
	const doc = new Y.Doc();
	let update: Uint8Array = new Uint8Array();
	doc.on('update', (u: Uint8Array) => (update = u));
	doc.getText('t').insert(0, text);
	return update;
}

describe('a write from outside to an open note', () => {
	let db: TestDb;
	let w: World;
	const P = () => w.projectKey;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 180_000);
	afterAll(async () => {
		await (await getHub(db)).close();
		await db?.stop();
	});

	const versions = (id: string) =>
		db.admin.query<{ number: number; body: string; cause: string }>(
			`select number, body, cause from note_version where note_id = '${id}' order by number`
		);

	/** A note that is open: seeded, typed in and checkpointed. */
	async function opened(title: string) {
		const n = await createNote(w.ctx('member'), { project: P(), title, body: 'start' });
		const ctx = w.ctx('member');
		await appendNoteUpdates(ctx, {
			project: P(),
			note: n.ref,
			epoch: n.epoch,
			updates: [b64(typed('start'))],
			seed: true
		});
		await appendNoteUpdates(ctx, {
			project: P(),
			note: n.ref,
			epoch: n.epoch,
			updates: [b64(typed('more'))]
		});
		await checkpointNote(ctx, {
			project: P(),
			note: n.ref,
			epoch: n.epoch,
			sequence: 2,
			title,
			body: 'start and more'
		});
		return n;
	}

	for (const cause of ['agent', 'api'] as const) {
		it(`a ${cause} write keeps the earlier text in history, raises the epoch, clears the updates and refuses the old epoch`, async () => {
			const hub = await getHub(db);
			const seen: Change[] = [];
			const stop = hub.subscribe(w.projectId, (c) => c && seen.push(c));
			const n = await opened(`Replace by ${cause}`);
			const res = await updateNote(
				w.ctx('member'),
				{ project: P(), note: n.ref, body: `new text by ${cause}` },
				cause
			);
			expect(res.epoch).toBe(n.epoch + 1);
			// The text that was saved before is in history, with the cause of the write
			// (the checkpoint before it kept 'start' as a typing version)
			expect(await versions(n.id)).toEqual([
				{ number: 1, body: 'start', cause: 'typing' },
				{ number: 2, body: 'start and more', cause }
			]);
			// The live updates of the old epoch are gone and the new text is the body
			const read = await readNoteUpdates(w.ctx('member'), { project: P(), note: n.ref });
			expect(read).toMatchObject({
				epoch: n.epoch + 1,
				markdown: `new text by ${cause}`,
				last: 0,
				checkpointSeq: 0,
				updates: []
			});
			// An update and a checkpoint of the old epoch are refused and put nothing back
			expect(
				await appendNoteUpdates(w.ctx('member'), {
					project: P(),
					note: n.ref,
					epoch: n.epoch,
					updates: [b64(typed('stale typing'))]
				})
			).toEqual({ ok: false, reason: 'epoch', epoch: n.epoch + 1 });
			expect(
				await checkpointNote(w.ctx('member'), {
					project: P(),
					note: n.ref,
					epoch: n.epoch,
					sequence: 3,
					title: n.title,
					body: 'stale text'
				})
			).toMatchObject({ ok: false, reason: 'epoch', epoch: n.epoch + 1 });
			expect((await getNote(w.ctx('member'), { project: P(), note: n.ref })).body.text).toBe(
				`new text by ${cause}`
			);
			// The open pages are told: an event notice for this note (the page reads the new epoch from it)
			await wait(400);
			stop();
			expect(seen.some((c) => c.k === 'event' && c.n === n.id && c.v === 'note.update')).toBe(true);
		});
	}

	it('typing by a person never raises the epoch', async () => {
		const n = await opened('Typing keeps the epoch');
		const res = await updateNote(w.ctx('member'), { project: P(), note: n.ref, title: 'Renamed' });
		expect(res.epoch).toBe(n.epoch);
		const read = await readNoteUpdates(w.ctx('member'), { project: P(), note: n.ref });
		expect(read.last).toBe(2);
	});
});
