// NOTE SEARCH: THE GENERATED VECTOR, THE NOTE BRANCH OF searchAll AND WHAT searchBoard SHOWS EACH READER (AFB-20261111-0035, step 6.1)

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { searchAll } from '../../src/lib/server/db/search';
import { run } from '../../src/lib/server/ops/context';
import { searchBoard } from '../../src/lib/server/ops/board';
import { createNote, listNotes, trashNote } from '../../src/lib/server/ops/notes';
import { createFolder, trashFolder } from '../../src/lib/server/ops/noteFolders';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

describe('note search', () => {
	let db: TestDb;
	let w: World;
	const P = () => w.projectKey;
	type Who = keyof World['people'];
	/** The note hits (as references) this person gets for a word. */
	const found = async (who: Who, q: string) =>
		(await searchBoard(w.ctx(who), q, { limit: 50 }))
			.filter((h) => h.kind === 'note')
			.map((h) => h.noteRef)
			.sort();

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		const m = w.ctx('member');
		await createNote(m, { project: P(), title: 'Quasar shared', body: 'a public note' });
		await createNote(m, {
			project: P(),
			title: 'Quasar mine',
			body: 'private',
			visibility: 'private'
		});
		await createNote(w.ctx('admin'), {
			project: P(),
			title: 'Quasar theirs',
			body: 'private of the admin',
			visibility: 'private'
		});
		await createNote(m, { project: P(), title: 'Quasar gone', body: 'will be trashed' });
		await trashNote(m, { project: P(), note: 'N-4' });
		await createNote(m, {
			project: P(),
			title: 'Body match',
			body: 'the word nebulaquartz sits here'
		});
		const folder = await createFolder(m, { project: P(), name: 'Hidden folder' });
		await createNote(m, {
			project: P(),
			title: 'Quasar in a folder',
			body: '',
			folderId: folder.id
		});
		await trashFolder(m, { project: P(), folder: folder.id });
	}, 180_000);
	afterAll(async () => {
		await db?.stop();
	});

	it('the vector covers the title and the body, and the note branch of searchAll returns the hit', async () => {
		const hits = await run(
			w.ctx('member'),
			(tx) => searchAll(tx, 'nebulaquartz', { limit: 10 }),
			w.projectId
		);
		expect(hits.map((h) => `${h.kind}:${h.title}`)).toEqual(['note:N-5 Body match']);
		const byTitle = await run(
			w.ctx('member'),
			(tx) => searchAll(tx, 'quasar', { limit: 20 }),
			w.projectId
		);
		expect(byTitle.every((h) => h.kind === 'note' && h.itemId === null)).toBe(true);
	});

	it('listNotes gives a plain excerpt, the last editor and, for a search, the words around the hit as ranges (AFB-20261111-0805)', async () => {
		const m = w.ctx('member');
		await createNote(m, {
			project: P(),
			title: 'Excerpt check',
			body: '# Excerpt check\n\n**Bold** words and a [link](https://example.com) before the zircontide word.'
		});
		const all = await listNotes(m, { project: P() });
		const row = all.notes.find((n) => n.title === 'Excerpt check');
		expect(row?.excerpt).toBe('Bold words and a link before the zircontide word.');
		expect(row?.match).toBeNull();
		expect(row?.lastEditor).toEqual({ id: w.people.member, name: 'member' });
		const hit = (await listNotes(m, { project: P(), q: 'zircontide' })).notes[0];
		expect(hit?.match?.text).toContain('zircontide');
		const [a, b] = hit?.match?.marks[0] ?? [0, 0];
		expect(hit?.match?.text.slice(a, b)).toBe('zircontide');
	});

	it('a member finds shared notes and their own private ones, not the trash, not another private note', async () => {
		// N-1 shared, N-2 mine; N-3 is the admin's, N-4 trashed, N-6 under a trashed folder
		expect(await found('member', 'quasar')).toEqual(['N-1', 'N-2']);
		expect(await found('admin', 'quasar')).toEqual(['N-1', 'N-3']);
		expect(await found('owner', 'quasar')).toEqual(['N-1']);
		expect(await found('viewer', 'quasar')).toEqual(['N-1']);
		expect(await found('viewer', 'nebulaquartz')).toEqual(['N-5']);
	});

	it('the whole reference finds the note, and a hit leads to it', async () => {
		const hits = await searchBoard(w.ctx('viewer'), 'N-5', { limit: 10 });
		expect(hits[0]).toMatchObject({ kind: 'note', noteRef: 'N-5', projectKey: P(), itemRef: null });
		expect(await found('viewer', 'N-2')).toEqual([]);
		expect(await found('member', 'N-2')).toEqual(['N-2']);
		// Limited to a project key
		expect(await found('member', 'quasar')).toHaveLength(2);
		expect(
			(await searchBoard(w.ctx('member'), 'quasar', { project: 'NOPE' })).filter(
				(h) => h.kind === 'note'
			)
		).toEqual([]);
	});

	it('a guest finds no note, nor does anyone whose role on the project is guest', async () => {
		await db.admin.exec(
			`INSERT INTO project_member (org_id, project_id, user_id, role) VALUES ('${w.orgId}', '${w.projectId}', '${w.people.guest}', 'guest'), ('${w.orgId}', '${w.projectId}', '${w.people.viewer}', 'guest')`
		);
		try {
			expect(await found('guest', 'quasar')).toEqual([]);
			expect(await found('guest', 'nebulaquartz')).toEqual([]);
			// A viewer of the organisation who is only a guest of this project is a guest here
			expect(await found('viewer', 'quasar')).toEqual([]);
			expect(await found('member', 'quasar')).toEqual(['N-1', 'N-2']);
		} finally {
			await db.admin.exec(`DELETE FROM project_member WHERE project_id = '${w.projectId}'`);
		}
	});
});
