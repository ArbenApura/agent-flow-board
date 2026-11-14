// LIVE CO-EDITING VERBS: ORDER, EPOCHS, SEEDS, CHECKPOINTS, LIMITS, ACCESS AND NOTICES (AFB-20261111-0035, 8.2)

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ZodError } from 'zod';
// IMPORTED MODULES
import { OpError } from '../../src/lib/server/ops/context';
import { createNote, getNote, updateNote } from '../../src/lib/server/ops/notes';
import {
	appendNoteUpdates,
	checkpointNote,
	compactNote,
	readNoteUpdates,
	sendNotePresence
} from '../../src/lib/server/ops/noteSync';
import { getHub } from '../../src/lib/server/realtime/hub';
import type { Change } from '../../src/lib/server/realtime/notify';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The error code a call fails with, or 'ok'. */
async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return 'ok';
	} catch (e) {
		if (e instanceof OpError) return e.code;
		// A schema refusal (a text too long) is a refusal too; the API answers it as INVALID
		if (e instanceof ZodError) return 'INVALID';
		throw e;
	}
}

/** A document with some text, and the update that made it. */
function typed(text: string, doc = new Y.Doc()) {
	let update: Uint8Array = new Uint8Array();
	const on = (u: Uint8Array) => (update = u);
	doc.on('update', on);
	doc.getText('t').insert(doc.getText('t').length, text);
	doc.off('update', on);
	return { doc, update };
}

describe('live co-editing verbs', () => {
	let db: TestDb;
	let w: World;
	const P = () => w.projectKey;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		await db.admin.exec(
			`INSERT INTO project_member (org_id, project_id, user_id, role) VALUES ('${w.orgId}', '${w.projectId}', '${w.people.guest}', 'guest') ON CONFLICT DO NOTHING`
		);
	}, 180_000);
	afterAll(async () => {
		await (await getHub(db)).close();
		await db?.stop();
	});

	const fresh = async (title = 'Live', visibility: 'public' | 'private' = 'public') =>
		createNote(w.ctx('member'), { project: P(), title, body: 'start', visibility });
	/** Seeds a note with one update and returns its epoch. */
	const seeded = async (title?: string, visibility?: 'public' | 'private') => {
		const n = await fresh(title, visibility);
		const seed = typed('start');
		const a = await appendNoteUpdates(w.ctx('member'), {
			project: P(),
			note: n.ref,
			epoch: n.epoch,
			updates: [b64(seed.update)],
			seed: true
		});
		expect(a).toMatchObject({ ok: true, seqs: [1] });
		return { n, seed };
	};

	it('two documents exchange updates through the verbs and end equal', async () => {
		const { n } = await seeded('Exchange');
		const ref = n.ref;
		const a = new Y.Doc();
		const b = new Y.Doc();
		const first = await readNoteUpdates(w.ctx('member'), { project: P(), note: ref });
		for (const u of first.updates) {
			Y.applyUpdate(a, unb64(u.update));
			Y.applyUpdate(b, unb64(u.update));
		}
		const fromA = typed(' from A', a).update;
		const fromB = typed(' from B', b).update;
		await appendNoteUpdates(w.ctx('member'), {
			project: P(),
			note: ref,
			epoch: n.epoch,
			updates: [b64(fromA)]
		});
		await appendNoteUpdates(w.ctx('admin'), {
			project: P(),
			note: ref,
			epoch: n.epoch,
			updates: [b64(fromB)]
		});
		const sinceA = await readNoteUpdates(w.ctx('member'), { project: P(), note: ref, after: 1 });
		expect(sinceA.updates.map((u) => u.seq)).toEqual([2, 3]);
		for (const u of sinceA.updates) {
			Y.applyUpdate(a, unb64(u.update));
			Y.applyUpdate(b, unb64(u.update));
		}
		expect(a.getText('t').toString()).toBe(b.getText('t').toString());
		expect(a.getText('t').toString()).toContain('from A');
		expect(a.getText('t').toString()).toContain('from B');
		// Reading is allowed to a viewer, who sees the same updates
		const viewer = await readNoteUpdates(w.ctx('viewer'), { project: P(), note: ref });
		expect(viewer.last).toBe(3);
	});

	it('posts at the same moment get different numbers, in commit order with no gaps', async () => {
		const { n } = await seeded('Race');
		const calls = Array.from({ length: 8 }, (_, i) =>
			appendNoteUpdates(w.ctx(i % 2 ? 'member' : 'admin'), {
				project: P(),
				note: n.ref,
				epoch: n.epoch,
				updates: [b64(typed(`x${i}`).update)]
			})
		);
		const answers = await Promise.all(calls);
		const seqs = answers.map((a) => (a.ok ? a.seqs[0] : -1)).sort((x, y) => x - y);
		expect(seqs).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
		const read = await readNoteUpdates(w.ctx('member'), { project: P(), note: n.ref });
		expect(read.updates.map((u) => u.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(read.last).toBe(9);
	});

	it('two seeds at once leave one copy: the loser is told taken and gets the winner updates', async () => {
		const n = await fresh('Seeds');
		const mine = typed('same text');
		const other = typed('same text');
		const [x, y] = await Promise.all([
			appendNoteUpdates(w.ctx('member'), {
				project: P(),
				note: n.ref,
				epoch: n.epoch,
				updates: [b64(mine.update)],
				seed: true
			}),
			appendNoteUpdates(w.ctx('admin'), {
				project: P(),
				note: n.ref,
				epoch: n.epoch,
				updates: [b64(other.update)],
				seed: true
			})
		]);
		expect([x.ok, y.ok].sort()).toEqual([false, true]);
		const loser = x.ok ? y : x;
		expect(loser).toMatchObject({ ok: false, reason: 'taken', last: 1 });
		if (loser.ok || loser.reason !== 'taken') throw new Error('unreachable');
		expect(loser.updates).toHaveLength(1);
		const read = await readNoteUpdates(w.ctx('member'), { project: P(), note: n.ref });
		expect(read.updates).toHaveLength(1);
		const doc = new Y.Doc();
		for (const u of read.updates) Y.applyUpdate(doc, unb64(u.update));
		expect(doc.getText('t').toString()).toBe('same text');
		// A plain update before any seed is refused
		const empty = await fresh('Unseeded');
		expect(
			await codeOf(
				appendNoteUpdates(w.ctx('member'), {
					project: P(),
					note: empty.ref,
					epoch: empty.epoch,
					updates: [b64(typed('x').update)]
				})
			)
		).toBe('INVALID');
	});

	it('an update of an old epoch is refused and a body written from outside raises the epoch', async () => {
		const { n } = await seeded('Epochs');
		await updateNote(
			w.ctx('member'),
			{ project: P(), note: n.ref, body: 'from an agent' },
			'agent'
		);
		const answer = await appendNoteUpdates(w.ctx('member'), {
			project: P(),
			note: n.ref,
			epoch: n.epoch,
			updates: [b64(typed('old').update)]
		});
		expect(answer).toEqual({ ok: false, reason: 'epoch', epoch: n.epoch + 1 });
		const read = await readNoteUpdates(w.ctx('member'), { project: P(), note: n.ref });
		expect(read.epoch).toBe(n.epoch + 1);
		expect(read.updates).toEqual([]);
		expect(read.markdown).toBe('from an agent');
		// A checkpoint of the old epoch cannot put the old text back
		const cp = await checkpointNote(w.ctx('member'), {
			project: P(),
			note: n.ref,
			epoch: n.epoch,
			sequence: 1,
			title: 'Epochs',
			body: 'old text'
		});
		expect(cp).toMatchObject({ ok: false, reason: 'epoch' });
		expect((await getNote(w.ctx('member'), { project: P(), note: n.ref })).body.text).toBe(
			'from an agent'
		);
	});

	it('a checkpoint is taken for a newer sequence only, keeps a version, and follows the text links', async () => {
		const { n } = await seeded('Checkpoint');
		const other = await fresh('Target');
		for (let i = 0; i < 2; i++)
			await appendNoteUpdates(w.ctx('member'), {
				project: P(),
				note: n.ref,
				epoch: n.epoch,
				updates: [b64(typed(`y${i}`).update)]
			});
		const taken = await checkpointNote(w.ctx('member'), {
			project: P(),
			note: n.ref,
			epoch: n.epoch,
			sequence: 3,
			title: 'Checkpoint',
			body: `Now see [it](afb:note/${other.ref})`
		});
		expect(taken).toMatchObject({ ok: true, sequence: 3 });
		const got = await getNote(w.ctx('member'), { project: P(), note: n.ref });
		expect(got.note.checkpointSeq).toBe(3);
		expect(got.body.text).toContain('afb:note/');
		// The same or an older sequence is refused
		for (const sequence of [3, 2]) {
			expect(
				await checkpointNote(w.ctx('member'), {
					project: P(),
					note: n.ref,
					epoch: n.epoch,
					sequence,
					title: 'Checkpoint',
					body: 'older'
				})
			).toMatchObject({ ok: false, reason: 'old', checkpointSeq: 3 });
		}
		// A sequence the server never stored is refused, and so are limits of the schema
		expect(
			await codeOf(
				checkpointNote(w.ctx('member'), {
					project: P(),
					note: n.ref,
					epoch: n.epoch,
					sequence: 99,
					title: 'Checkpoint',
					body: 'x'
				})
			)
		).toBe('INVALID');
		expect(
			await codeOf(
				checkpointNote(w.ctx('member'), {
					project: P(),
					note: n.ref,
					epoch: n.epoch,
					sequence: 4,
					title: 'x'.repeat(201),
					body: 'x'
				})
			)
		).not.toBe('ok');
		const links = await db.admin.query(
			`select target_kind from note_link where note_id = '${n.id}' and source = 'text'`
		);
		expect(links).toHaveLength(1);
	});

	it('garbage, oversized and malformed updates are refused', async () => {
		const { n } = await seeded('Bad input');
		const send = (updates: string[]) =>
			codeOf(
				appendNoteUpdates(w.ctx('member'), { project: P(), note: n.ref, epoch: n.epoch, updates })
			);
		expect(await send([b64(new Uint8Array([255, 255, 255, 255, 9, 9, 9]))])).toBe('INVALID');
		expect(await send(['not base64!!'])).toBe('INVALID');
		expect(await send([''])).toBe('INVALID');
		const big = typed('z'.repeat(300 * 1024)).update;
		expect(big.byteLength).toBeGreaterThan(256 * 1024);
		expect(await send([b64(big)])).toBe('INVALID');
		const read = await readNoteUpdates(w.ctx('member'), { project: P(), note: n.ref });
		expect(read.last).toBe(1);
	});

	it('a viewer, a guest and another person on a private note cannot write', async () => {
		const { n } = await seeded('Access');
		const priv = await seeded('Mine', 'private');
		const body = (ref: string, epoch: number) => ({
			project: P(),
			note: ref,
			epoch,
			updates: [b64(typed('no').update)]
		});
		expect(await codeOf(appendNoteUpdates(w.ctx('viewer'), body(n.ref, n.epoch)))).toBe(
			'FORBIDDEN'
		);
		expect(await codeOf(appendNoteUpdates(w.ctx('guest'), body(n.ref, n.epoch)))).not.toBe('ok');
		expect(await codeOf(appendNoteUpdates(w.ctx('admin'), body(priv.n.ref, priv.n.epoch)))).toBe(
			'NOT_FOUND'
		);
		expect(await codeOf(readNoteUpdates(w.ctx('owner'), { project: P(), note: priv.n.ref }))).toBe(
			'NOT_FOUND'
		);
		expect(await codeOf(readNoteUpdates(w.ctx('guest'), { project: P(), note: n.ref }))).not.toBe(
			'ok'
		);
		expect(
			await codeOf(
				sendNotePresence(w.ctx('viewer'), {
					project: P(),
					note: priv.n.ref,
					data: b64(new Uint8Array([1]))
				})
			)
		).toBe('NOT_FOUND');
	});

	it('merging keeps the highest number and the text, and typing continues after it', async () => {
		const { n } = await seeded('Merge');
		const doc = new Y.Doc();
		for (const u of (await readNoteUpdates(w.ctx('member'), { project: P(), note: n.ref })).updates)
			Y.applyUpdate(doc, unb64(u.update));
		for (let i = 0; i < 4; i++)
			await appendNoteUpdates(w.ctx('member'), {
				project: P(),
				note: n.ref,
				epoch: n.epoch,
				updates: [b64(typed(`.${i}`, doc).update)]
			});
		expect(await compactNote(w.ctx('member'), { project: P(), note: n.ref })).toMatchObject({
			merged: 5
		});
		const read = await readNoteUpdates(w.ctx('member'), { project: P(), note: n.ref });
		expect(read.updates.map((u) => u.seq)).toEqual([5]);
		const again = new Y.Doc();
		Y.applyUpdate(again, unb64(read.updates[0].update));
		expect(again.getText('t').toString()).toBe(doc.getText('t').toString());
		const next = await appendNoteUpdates(w.ctx('member'), {
			project: P(),
			note: n.ref,
			epoch: n.epoch,
			updates: [b64(typed('!', doc).update)]
		});
		expect(next).toMatchObject({ ok: true, seqs: [6] });
	});

	it('a checkpoint without a title keeps a title that was changed elsewhere', async () => {
		const { n } = await seeded('Before rename');
		await updateNote(w.ctx('member'), { project: P(), note: n.ref, title: 'Renamed elsewhere' });
		await appendNoteUpdates(w.ctx('member'), {
			project: P(),
			note: n.ref,
			epoch: n.epoch,
			updates: [b64(typed('more').update)]
		});
		const taken = await checkpointNote(w.ctx('member'), {
			project: P(),
			note: n.ref,
			epoch: n.epoch,
			sequence: 2,
			body: 'start more'
		});
		expect(taken).toMatchObject({ ok: true, sequence: 2 });
		const got = await getNote(w.ctx('member'), { project: P(), note: n.ref });
		expect(got.note.title).toBe('Renamed elsewhere');
		expect(got.body.text).toBe('start more');
	});

	it('merging deleted text shrinks the stored rows: a merge of updates keeps it, a compaction drops it', async () => {
		// The proof: Y.mergeUpdates keeps the deleted text, a document does not
		const probe = new Y.Doc();
		const parts: Uint8Array[] = [];
		probe.on('update', (u: Uint8Array) => parts.push(u));
		probe.getText('t').insert(0, 'q'.repeat(50_000));
		probe.getText('t').delete(0, 50_000);
		probe.getText('t').insert(0, 'ok');
		const merged = Y.mergeUpdates(parts);
		const state = Y.encodeStateAsUpdate(probe);
		expect(merged.byteLength).toBeGreaterThan(40_000);
		expect(state.byteLength).toBeLessThan(1000);
		// The verb stores the small form
		const { n } = await seeded('Compact deleted');
		const doc = new Y.Doc();
		for (const u of (await readNoteUpdates(w.ctx('member'), { project: P(), note: n.ref })).updates)
			Y.applyUpdate(doc, unb64(u.update));
		const send = async (update: Uint8Array) =>
			appendNoteUpdates(w.ctx('member'), {
				project: P(),
				note: n.ref,
				epoch: n.epoch,
				updates: [b64(update)]
			});
		await send(typed('w'.repeat(50_000), doc).update);
		let removed: Uint8Array = new Uint8Array();
		doc.on('update', (u: Uint8Array) => (removed = u));
		doc.getText('t').delete(5, 50_000);
		await send(removed);
		const before = (await readNoteUpdates(w.ctx('member'), { project: P(), note: n.ref })).updates;
		const sum = (list: { update: string }[]) =>
			list.reduce((t, u) => t + unb64(u.update).length, 0);
		expect(await compactNote(w.ctx('member'), { project: P(), note: n.ref })).toMatchObject({
			merged: 3
		});
		const after = (await readNoteUpdates(w.ctx('member'), { project: P(), note: n.ref })).updates;
		expect(sum(after)).toBeLessThan(sum(before) / 10);
		const again = new Y.Doc();
		Y.applyUpdate(again, unb64(after[0].update));
		expect(again.getText('t').toString()).toBe('start');
	});

	it('a live notice names the note and the number, carries no event row, and a private note reaches nobody else', async () => {
		const hub = await getHub(db);
		const seen: Change[] = [];
		const stop = hub.subscribe(w.projectId, (c) => c && seen.push(c));
		const { n } = await seeded('Notice');
		await appendNoteUpdates(w.ctx('member'), {
			project: P(),
			note: n.ref,
			epoch: n.epoch,
			updates: [b64(typed('hello').update)]
		});
		await sendNotePresence(w.ctx('member'), {
			project: P(),
			note: n.ref,
			data: b64(new Uint8Array([1, 2, 3]))
		});
		await wait(400);
		stop();
		const mine = seen.filter((c) => c.n === n.id);
		expect(mine.filter((c) => c.k === 'note').map((c) => [c.s, c.x])).toEqual([
			[1, n.epoch],
			[2, n.epoch]
		]);
		expect(mine.find((c) => c.k === 'presence')).toMatchObject({ s: n.epoch, d: 'AQID' });
		// No event row was written for any of it
		const rows = await db.admin.query(
			`select verb from event where target_id = '${n.id}' and verb not like 'note.create'`
		);
		expect(rows).toEqual([]);
		const priv = await seeded('Private notice', 'private');
		const { mayReceive } = await import('../../src/lib/server/ops/board');
		for (const who of ['owner', 'admin', 'viewer', 'guest'] as const)
			expect(await mayReceive(w.ctx(who), w.projectId, null, priv.n.id), who).toBe(false);
		expect(await mayReceive(w.ctx('member'), w.projectId, null, priv.n.id)).toBe(true);
		expect(await mayReceive(w.ctx('member'), w.projectId, null, crypto.randomUUID())).toBe(false);
	});

	it('a presence message over 1 KB is refused', async () => {
		const { n } = await seeded('Presence');
		expect(
			await codeOf(
				sendNotePresence(w.ctx('member'), {
					project: P(),
					note: n.ref,
					data: b64(new Uint8Array(2000).fill(7))
				})
			)
		).toBe('INVALID');
	});
});
