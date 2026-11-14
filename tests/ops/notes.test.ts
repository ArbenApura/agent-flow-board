// NOTE VERBS: ROLES, PRIVACY, VERSIONS, STALE WRITES, TRASH AND FAVOURITES (AFB-20261111-0035, step 2.1)

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { OpError } from '../../src/lib/server/ops/context';
import { createFolder, trashFolder } from '../../src/lib/server/ops/noteFolders';
import {
	createNote,
	getNote,
	listNotes,
	noteCauseOf,
	restoreNote,
	setFavourite,
	trashNote,
	updateNote
} from '../../src/lib/server/ops/notes';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

/** The error code a call fails with, or 'ok'. */
async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return 'ok';
	} catch (e) {
		if (e instanceof OpError) return e.code;
		throw e;
	}
}

describe('note verbs', () => {
	let db: TestDb;
	let w: World;
	const P = () => w.projectKey;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 180_000);
	afterAll(async () => {
		await db?.stop();
	});

	it('the cause comes from the caller and the door, never from the payload', () => {
		const person = { userId: 'u', kind: 'person' as const };
		expect(noteCauseOf(person, 'web')).toBe('typing');
		expect(noteCauseOf(person, 'api')).toBe('typing');
		expect(noteCauseOf({ ...person, tokenId: 't' }, 'api')).toBe('api');
		expect(noteCauseOf({ userId: 'u', kind: 'agent' }, 'api')).toBe('api');
		expect(noteCauseOf(person, 'mcp')).toBe('agent');
	});

	it('a member, an admin and an owner create notes; a viewer and a guest cannot', async () => {
		const first = await createNote(w.ctx('member'), { project: P(), title: 'First', body: 'One' });
		expect(first.ref).toBe('N-1');
		expect(first.version).toBe(1);
		expect((await createNote(w.ctx('admin'), { project: P(), title: 'Second' })).ref).toBe('N-2');
		expect((await createNote(w.ctx('owner'), { project: P(), title: 'Third' })).ref).toBe('N-3');
		expect(await codeOf(createNote(w.ctx('viewer'), { project: P(), title: 'No' }))).toBe(
			'FORBIDDEN'
		);
		// A guest has no role on the project at all
		expect(await codeOf(createNote(w.ctx('guest'), { project: P(), title: 'No' }))).toBe(
			'NOT_FOUND'
		);
		// The answer of a write never carries the body
		expect(JSON.stringify(first)).not.toContain('One');
	});

	it('a read gives the body in pages to a tool and whole to a screen, and says who wrote it', async () => {
		const long = 'x'.repeat(13_000);
		const n = await createNote(w.ctx('member'), { project: P(), title: 'Long', body: long });
		const page1 = await getNote(w.ctx('viewer'), { project: P(), note: n.ref });
		expect(page1.body.text.length).toBe(6000);
		expect(page1.body.next).toBe(6000);
		expect(page1.body.total).toBe(13_000);
		const page3 = await getNote(w.ctx('viewer'), { project: P(), note: n.ref, offset: 12_000 });
		expect(page3.body.text.length).toBe(1000);
		expect(page3.body.next).toBe(null);
		const whole = await getNote(w.ctx('member'), { project: P(), note: n.ref, full: true });
		expect(whole.body.text.length).toBe(13_000);
		expect(whole.author).toBe('member');
		// A shared note is untrusted for everyone, its writer included; only a private note of the reader's own is theirs
		expect(whole.untrusted).toBe(true);
		expect(page1.untrusted).toBe(true);
		const own = await createNote(w.ctx('member'), {
			project: P(),
			title: 'Own private',
			visibility: 'private'
		});
		expect((await getNote(w.ctx('member'), { project: P(), note: own.ref })).untrusted).toBe(false);
		// A page past the end is empty, with no next page
		const past = await getNote(w.ctx('viewer'), { project: P(), note: n.ref, offset: 99_999 });
		expect(past.body).toMatchObject({ text: '', total: 13_000, next: null });
		expect([page1.canWrite, whole.canWrite]).toEqual([false, true]);
		// By id works as well as by reference
		expect((await getNote(w.ctx('member'), { project: P(), note: n.id })).note.ref).toBe(n.ref);
	});

	it('a private note is found, read and changed by its creator only: not a member, not an admin, not the owner', async () => {
		const n = await createNote(w.ctx('member'), {
			project: P(),
			title: 'My scratchpad',
			body: 'secret words',
			visibility: 'private'
		});
		for (const who of ['admin', 'owner', 'viewer'] as const) {
			expect(await codeOf(getNote(w.ctx(who), { project: P(), note: n.ref })), who).toBe(
				'NOT_FOUND'
			);
			const list = await listNotes(w.ctx(who), { project: P() });
			expect(list.notes.map((x) => x.ref)).not.toContain(n.ref);
			const found = await listNotes(w.ctx(who), { project: P(), q: 'secret' });
			expect(found.notes).toHaveLength(0);
		}
		expect(
			await codeOf(updateNote(w.ctx('admin'), { project: P(), note: n.ref, body: 'taken over' }))
		).toBe('NOT_FOUND');
		expect(await codeOf(trashNote(w.ctx('owner'), { project: P(), note: n.ref }))).toBe(
			'NOT_FOUND'
		);
		const mine = await listNotes(w.ctx('member'), { project: P(), q: 'secret' });
		expect(mine.notes.map((x) => x.ref)).toEqual([n.ref]);
		expect((await getNote(w.ctx('member'), { project: P(), note: n.ref })).mine).toBe(true);
	});

	it('only the creator switches a note between shared and private, and going private drops the public link', async () => {
		const n = await createNote(w.ctx('member'), { project: P(), title: 'Shared for now' });
		expect(
			await codeOf(updateNote(w.ctx('admin'), { project: P(), note: n.ref, visibility: 'private' }))
		).toBe('FORBIDDEN');
		await db.admin.exec(
			`UPDATE note SET public_enabled = true, public_token_hash = '${'a'.repeat(64)}' WHERE id = '${n.id}'`
		);
		await updateNote(w.ctx('member'), { project: P(), note: n.ref, visibility: 'private' });
		const [row] = await db.admin.query<{ public_enabled: boolean; public_token_hash: string }>(
			`select public_enabled, public_token_hash from note where id = '${n.id}'`
		);
		expect(row).toEqual({ public_enabled: false, public_token_hash: null });
	});

	it('a guest gets no list, and a viewer reads but cannot change', async () => {
		expect(await codeOf(listNotes(w.ctx('guest'), { project: P() }))).toBe('NOT_FOUND');
		await db.admin.exec(
			`INSERT INTO project_member (org_id, project_id, user_id, role) VALUES ('${w.orgId}', '${w.projectId}', '${w.people.guest}', 'guest')`
		);
		expect(await codeOf(listNotes(w.ctx('guest'), { project: P() }))).toBe('FORBIDDEN');
		expect(await codeOf(getNote(w.ctx('guest'), { project: P(), note: 'N-1' }))).toBe('NOT_FOUND');
		await db.admin.exec(`DELETE FROM project_member WHERE project_id = '${w.projectId}'`);
		expect((await listNotes(w.ctx('viewer'), { project: P() })).notes.length).toBeGreaterThan(0);
		expect(
			await codeOf(updateNote(w.ctx('viewer'), { project: P(), note: 'N-1', title: 'Mine now' }))
		).toBe('FORBIDDEN');
		expect(await codeOf(trashNote(w.ctx('viewer'), { project: P(), note: 'N-1' }))).toBe(
			'FORBIDDEN'
		);
	});

	it('a token can only narrow: read only cannot create, and another project is not reached', async () => {
		const readOnly = w.ctx('member', { tokenId: 'tok-1', tokenCaps: ['read'] });
		expect(await codeOf(createNote(readOnly, { project: P(), title: 'No' }))).toBe('FORBIDDEN');
		expect((await getNote(readOnly, { project: P(), note: 'N-1' })).note.ref).toBe('N-1');
		const elsewhere = w.ctx('member', { tokenId: 'tok-2', tokenProjects: [w.other.projectId] });
		expect(await codeOf(getNote(elsewhere, { project: P(), note: 'N-1' }))).toBe('NOT_FOUND');
	});

	it('a stale version is refused, and a change with nothing new changes nothing', async () => {
		const n = await createNote(w.ctx('member'), { project: P(), title: 'Versioned', body: 'a' });
		const next = await updateNote(w.ctx('member'), {
			project: P(),
			note: n.ref,
			body: 'b',
			expectVersion: 1
		});
		expect(next.version).toBe(2);
		expect(
			await codeOf(
				updateNote(w.ctx('admin'), { project: P(), note: n.ref, body: 'c', expectVersion: 1 })
			)
		).toBe('STALE_VERSION');
		const same = await updateNote(w.ctx('member'), { project: P(), note: n.ref, body: 'b' });
		expect(same).toMatchObject({ changed: false, version: 2 });
	});

	it('an agent or API write keeps the earlier text first and starts a new epoch; typing keeps one version in ten minutes', async () => {
		const n = await createNote(w.ctx('member'), { project: P(), title: 'History', body: 'v1' });
		const versions = () =>
			db.admin.query<{ number: number; body: string; cause: string }>(
				`select number, body, cause from note_version where note_id = '${n.id}' order by number`
			);
		// Typing: the first change keeps the text, the next within ten minutes does not
		await updateNote(w.ctx('member'), { project: P(), note: n.ref, body: 'v2' }, 'typing');
		await updateNote(w.ctx('member'), { project: P(), note: n.ref, body: 'v3' }, 'typing');
		expect(await versions()).toEqual([{ number: 1, body: 'v1', cause: 'typing' }]);
		// A live update of the old epoch is waiting when the agent writes
		await db.admin.exec(
			`INSERT INTO note_update (org_id, project_id, note_id, epoch, seq, update) VALUES ('${w.orgId}', '${w.projectId}', '${n.id}', 1, 1, '\\x00')`
		);
		const byAgent = await updateNote(
			w.ctx('member', { kind: 'agent' }),
			{ project: P(), note: n.ref, body: 'agent text' },
			'agent'
		);
		expect(byAgent.epoch).toBe(2);
		expect((await versions()).at(-1)).toEqual({ number: 2, body: 'v3', cause: 'agent' });
		const left = await db.admin.query(`select 1 from note_update where note_id = '${n.id}'`);
		expect(left).toHaveLength(0);
		await updateNote(w.ctx('member'), { project: P(), note: n.ref, body: 'api text' }, 'api');
		expect((await versions()).at(-1)).toEqual({ number: 3, body: 'agent text', cause: 'api' });
		// Typing does not start a new epoch
		const typed = await updateNote(w.ctx('member'), { project: P(), note: n.ref, body: 'typed' });
		expect(typed.epoch).toBe(3);
	});

	it('typing writes no event; a title change and an agent write do, and never with the body', async () => {
		const n = await createNote(w.ctx('member'), { project: P(), title: 'Quiet', body: 'start' });
		const events = () =>
			db.admin.query<{ verb: string; after: unknown; before: unknown }>(
				`select verb, after, before from event where target_id = '${n.id}' order by id`
			);
		await updateNote(w.ctx('member'), { project: P(), note: n.ref, body: 'typed words' });
		expect((await events()).map((e) => e.verb)).toEqual(['note.create']);
		await updateNote(w.ctx('member'), { project: P(), note: n.ref, title: 'Loud' });
		await updateNote(w.ctx('member'), { project: P(), note: n.ref, body: 'agent words' }, 'agent');
		const all = await events();
		expect(all.map((e) => e.verb)).toEqual(['note.create', 'note.update', 'note.update']);
		expect(JSON.stringify(all)).not.toMatch(/typed words|agent words|start/);
	});

	it('a retried write is done once, and the request log holds no body', async () => {
		const body = 'a body that must not be stored twice';
		const ctx = () => w.ctx('member', { requestId: 'note-retry-1' });
		const a = await createNote(ctx(), { project: P(), title: 'Retry', body });
		const b = await createNote(ctx(), { project: P(), title: 'Retry', body });
		expect(b.id).toBe(a.id);
		await updateNote(w.ctx('member', { requestId: 'note-retry-2' }), {
			project: P(),
			note: a.ref,
			body: `${body} and more`
		});
		const logs = await db.admin.query<{ result: unknown }>(
			`select result from request_log where request_id like 'note-retry-%'`
		);
		expect(logs).toHaveLength(2);
		expect(JSON.stringify(logs)).not.toContain('must not be stored');
	});

	it('a note moves to a folder and back to the top, and never into a folder of the trash or of another project', async () => {
		const fid = '00000000-0000-4000-b000-000000000001';
		const gone = '00000000-0000-4000-b000-000000000002';
		const foreign = '00000000-0000-4000-b000-000000000003';
		await db.admin.exec(
			`INSERT INTO note_folder (id, org_id, project_id, name, deleted_at) VALUES ('${fid}', '${w.orgId}', '${w.projectId}', 'Research', null), ('${gone}', '${w.orgId}', '${w.projectId}', 'Old', now()), ('${foreign}', '${w.other.orgId}', '${w.other.projectId}', 'Theirs', null)`
		);
		const n = await createNote(w.ctx('member'), { project: P(), title: 'Mover', folderId: fid });
		expect(n.folderId).toBe(fid);
		expect((await listNotes(w.ctx('member'), { project: P(), folderId: fid })).notes).toHaveLength(
			1
		);
		for (const bad of [gone, foreign])
			expect(
				await codeOf(updateNote(w.ctx('member'), { project: P(), note: n.ref, folderId: bad }))
			).toBe('NOT_FOUND');
		const top = await updateNote(w.ctx('member'), { project: P(), note: n.ref, folderId: null });
		expect(top.folderId).toBe(null);
		const atTop = await listNotes(w.ctx('member'), { project: P(), folderId: null });
		expect(atTop.notes.map((x) => x.ref)).toContain(n.ref);
	});

	it('a trashed note leaves the list, loses its public link, and comes back with a restore', async () => {
		const n = await createNote(w.ctx('member'), { project: P(), title: 'Throwaway' });
		await db.admin.exec(
			`UPDATE note SET public_enabled = true, public_token_hash = '${'b'.repeat(64)}' WHERE id = '${n.id}'`
		);
		await trashNote(w.ctx('admin'), { project: P(), note: n.ref });
		expect(await codeOf(getNote(w.ctx('member'), { project: P(), note: n.ref }))).toBe('NOT_FOUND');
		expect(
			await codeOf(updateNote(w.ctx('member'), { project: P(), note: n.ref, title: 'Still here' }))
		).toBe('NOT_FOUND');
		await restoreNote(w.ctx('member'), { project: P(), note: n.ref });
		const back = await getNote(w.ctx('member'), { project: P(), note: n.ref });
		expect(back.note.publicEnabled).toBe(false);
		// A second restore finds nothing in the trash
		expect(await codeOf(restoreNote(w.ctx('member'), { project: P(), note: n.ref }))).toBe(
			'NOT_FOUND'
		);
	});

	it('a favourite is one person’s own', async () => {
		await setFavourite(w.ctx('member'), { project: P(), note: 'N-1', on: true });
		await setFavourite(w.ctx('member'), { project: P(), note: 'N-1', on: true });
		const mine = await listNotes(w.ctx('member'), { project: P(), favourites: true });
		expect(mine.notes.map((x) => x.ref)).toEqual(['N-1']);
		expect((await listNotes(w.ctx('admin'), { project: P(), favourites: true })).notes).toEqual([]);
		expect((await getNote(w.ctx('viewer'), { project: P(), note: 'N-1' })).favourite).toBe(false);
		await setFavourite(w.ctx('member'), { project: P(), note: 'N-1', on: false });
		expect((await listNotes(w.ctx('member'), { project: P(), favourites: true })).notes).toEqual(
			[]
		);
	});

	it('typing keeps a new version again once ten minutes have passed since the last one', async () => {
		const n = await createNote(w.ctx('member'), { project: P(), title: 'Slow', body: 'v1' });
		const versions = () =>
			db.admin.query<{ number: number; body: string }>(
				`select number, body from note_version where note_id = '${n.id}' order by number`
			);
		await updateNote(w.ctx('member'), { project: P(), note: n.ref, body: 'v2' });
		await updateNote(w.ctx('member'), { project: P(), note: n.ref, body: 'v3' });
		expect(await versions()).toEqual([{ number: 1, body: 'v1' }]);
		await db.admin.exec(
			`UPDATE note_version SET created_at = now() - interval '11 minutes' WHERE note_id = '${n.id}'`
		);
		await updateNote(w.ctx('member'), { project: P(), note: n.ref, body: 'v4' });
		expect(await versions()).toEqual([
			{ number: 1, body: 'v1' },
			{ number: 2, body: 'v3' }
		]);
	});

	it('a note restored from the trash comes back at the top when its folder is in the trash too', async () => {
		const f = await createFolder(w.ctx('member'), { project: P(), name: 'Doomed' });
		const n = await createNote(w.ctx('member'), {
			project: P(),
			title: 'In doomed',
			folderId: f.id
		});
		await trashNote(w.ctx('member'), { project: P(), note: n.ref });
		await trashFolder(w.ctx('member'), { project: P(), folder: f.id });
		const back = await restoreNote(w.ctx('member'), { project: P(), note: n.ref });
		expect(back.folderId).toBe(null);
		// With a live folder it goes back where it was
		const g = await createFolder(w.ctx('member'), { project: P(), name: 'Alive' });
		const m = await createNote(w.ctx('member'), {
			project: P(),
			title: 'In alive',
			folderId: g.id
		});
		await trashNote(w.ctx('member'), { project: P(), note: m.ref });
		expect((await restoreNote(w.ctx('member'), { project: P(), note: m.ref })).folderId).toBe(g.id);
	});

	it('a list comes in pages that join up, and a search treats % and _ as plain characters', async () => {
		for (let i = 1; i <= 5; i++)
			await createNote(w.ctx('member'), { project: P(), title: `Pagetest ${i}` });
		const refs: string[] = [];
		const nexts: (number | null)[] = [];
		let offset = 0;
		for (;;) {
			const page = await listNotes(w.ctx('member'), {
				project: P(),
				q: 'Pagetest',
				limit: 2,
				offset
			});
			refs.push(...page.notes.map((x) => x.ref));
			nexts.push(page.next);
			if (page.next === null) break;
			offset = page.next;
		}
		expect(nexts).toEqual([2, 4, null]);
		expect(new Set(refs).size).toBe(5);
		await createNote(w.ctx('member'), { project: P(), title: '50% off' });
		await createNote(w.ctx('member'), { project: P(), title: 'fifty off' });
		await createNote(w.ctx('member'), { project: P(), title: 'a_b' });
		await createNote(w.ctx('member'), { project: P(), title: 'axb' });
		const titles = async (q: string) =>
			(await listNotes(w.ctx('member'), { project: P(), q })).notes.map((x) => x.title);
		expect(await titles('%')).toEqual(['50% off']);
		expect(await titles('_')).toEqual(['a_b']);
		expect(await titles('50%')).toEqual(['50% off']);
	});

	it('another organisation finds nothing by reference or by id', async () => {
		const other = {
			handle: db,
			orgId: w.other.orgId,
			actor: { userId: w.other.userId, kind: 'person' as const }
		};
		const [n1] = await db.admin.query<{ id: string }>(
			`select id from note where project_id = '${w.projectId}' and number = 1`
		);
		expect(await codeOf(getNote(other, { project: P(), note: 'N-1' }))).toBe('NOT_FOUND');
		const theirs = `OTH${w.projectKey.replace('WRL', '')}`;
		expect(await codeOf(getNote(other, { project: theirs, note: n1.id }))).toBe('NOT_FOUND');
	});
});
