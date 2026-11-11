// NOTE HISTORY AND THE PUBLIC LINK: THE CUT RULES, RESTORE (ALSO ON AN OPEN NOTE), THE SAME ANSWER FOR EVERY KIND OF REFUSED LINK, PICTURES UNDER A LINK (AFB-20261111-0035, 7.1 AND 7.2)

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { handleApi, type ApiDeps } from '../../src/lib/server/api/dispatch';
import { OpError, type Ctx } from '../../src/lib/server/ops/context';
import { createFolder, trashFolder } from '../../src/lib/server/ops/noteFolders';
import { createNote, trashNote, updateNote, uploadNoteFile } from '../../src/lib/server/ops/notes';
import {
	getNoteVersion,
	listNoteVersions,
	restoreNoteVersion,
	setNotePublicLink
} from '../../src/lib/server/ops/noteVersions';
import { findPublicNote, servePublicNoteFile } from '../../src/lib/server/web/notePublic';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

// -- FUNCTIONS -- //

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return 'ok';
	} catch (e) {
		if (e instanceof OpError) return e.code;
		throw e;
	}
}

describe('note history and public link', () => {
	let db: TestDb;
	let w: World;
	let store: ReturnType<typeof memoryStorage>;
	let n = 0;
	const P = () => w.projectKey;
	const as = (who: keyof World['people'], extra: Parameters<World['ctx']>[1] = {}): Ctx => ({
		...w.ctx(who, extra),
		services: { storage: store, baseUrl: 'https://board.example' }
	});
	const mk = async (body = 'v1', visibility: 'public' | 'private' = 'public') =>
		createNote(w.ctx('member'), { project: P(), title: `Note ${++n}`, body, visibility });
	const versions = (id: string) =>
		db.admin.query<{ number: number; title: string; body: string; cause: string }>(
			`select number, title, body, cause from note_version where note_id = '${id}' order by number`
		);
	const rowOf = async (id: string) =>
		(
			await db.admin.query<{
				body: string;
				title: string;
				epoch: number;
				version: number;
				update_seq: number;
				public_enabled: boolean;
				public_token_hash: string | null;
			}>(
				`select body, title, epoch, version, update_seq, public_enabled, public_token_hash from note where id = '${id}'`
			)
		)[0];
	const on = async (ref: string) => {
		const res = await setNotePublicLink(as('admin'), { project: P(), note: ref, on: true });
		return res.token as string;
	};

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		store = memoryStorage('note-version-secret-0123456789abcdef');
	}, 180_000);
	afterAll(async () => {
		await db?.stop();
	});

	// -- HISTORY -- //

	it('keeps a version for an agent and the API, once in ten minutes while typing, and never an empty text', async () => {
		const a = await mk('v1');
		await updateNote(w.ctx('member'), { project: P(), note: a.ref, body: 'v2' }, 'typing');
		await updateNote(w.ctx('member'), { project: P(), note: a.ref, body: 'v3' }, 'typing');
		expect(await versions(a.id)).toEqual([
			{ number: 1, title: a.title, body: 'v1', cause: 'typing' }
		]);
		await updateNote(w.ctx('member'), { project: P(), note: a.ref, body: 'v4' }, 'agent');
		await updateNote(w.ctx('member'), { project: P(), note: a.ref, body: 'v5' }, 'api');
		expect((await versions(a.id)).map((v) => [v.body, v.cause])).toEqual([
			['v1', 'typing'],
			['v3', 'agent'],
			['v4', 'api']
		]);
		// An empty text is not worth a version while people type
		const e = await mk('');
		await updateNote(w.ctx('member'), { project: P(), note: e.ref, body: 'first' }, 'typing');
		expect(await versions(e.id)).toEqual([]);
		// Ten minutes later typing keeps one again
		await db.admin.exec(
			`UPDATE note_version SET created_at = now() - interval '11 minutes' WHERE note_id = '${a.id}'`
		);
		await updateNote(w.ctx('member'), { project: P(), note: a.ref, body: 'v6' }, 'typing');
		expect((await versions(a.id)).at(-1)).toMatchObject({ number: 4, body: 'v5', cause: 'typing' });
	});

	it('lists versions newest first without text, reads one whole, and a reader cannot restore', async () => {
		const a = await mk('one');
		await updateNote(w.ctx('member'), { project: P(), note: a.ref, body: 'two' }, 'agent');
		await updateNote(w.ctx('member'), { project: P(), note: a.ref, body: 'three' }, 'agent');
		const list = await listNoteVersions(as('viewer'), { project: P(), note: a.ref });
		expect(list.versions.map((v) => v.number)).toEqual([2, 1]);
		expect(list.canRestore).toBe(false);
		expect(JSON.stringify(list)).not.toContain('"body"');
		const one = await getNoteVersion(as('viewer'), { project: P(), note: a.ref, number: 1 });
		expect(one.body).toBe('one');
		expect(
			await codeOf(getNoteVersion(as('viewer'), { project: P(), note: a.ref, number: 9 }))
		).toBe('NOT_FOUND');
		expect(
			await codeOf(restoreNoteVersion(as('viewer'), { project: P(), note: a.ref, number: 1 }))
		).toBe('FORBIDDEN');
		// A private note's history is the same NOT_FOUND to everyone else
		const secret = await mk('mine', 'private');
		expect(await codeOf(listNoteVersions(as('admin'), { project: P(), note: secret.ref }))).toBe(
			'NOT_FOUND'
		);
	});

	it('restore keeps the current text as a version, writes the old one as the newest, and changes no old version', async () => {
		const a = await mk('first');
		await updateNote(
			w.ctx('member'),
			{ project: P(), note: a.ref, title: 'Second', body: 'second' },
			'agent'
		);
		const before = await versions(a.id);
		const res = await restoreNoteVersion(as('member'), { project: P(), note: a.ref, number: 1 });
		expect(res).toMatchObject({ changed: true, restoredFrom: 1 });
		const row = await rowOf(a.id);
		expect(row.body).toBe('first');
		expect(row.title).toBe(a.title);
		const after = await versions(a.id);
		expect(after.slice(0, before.length)).toEqual(before);
		expect(after.at(-1)).toMatchObject({ title: 'Second', body: 'second', cause: 'restore' });
		// Restoring the text that is already there changes nothing
		const again = await restoreNoteVersion(as('member'), { project: P(), note: a.ref, number: 1 });
		expect(again.changed).toBe(false);
		expect(await versions(a.id)).toHaveLength(after.length);
	});

	it('restore on an open note drops the live updates and raises the epoch, like any write from outside', async () => {
		const a = await mk('before');
		await updateNote(w.ctx('member'), { project: P(), note: a.ref, body: 'after' }, 'agent');
		await db.admin.exec(
			`INSERT INTO note_update (org_id, project_id, note_id, epoch, seq, update) VALUES ('${w.orgId}', '${w.projectId}', '${a.id}', 2, 1, '\\x00')`
		);
		await db.admin.exec(`UPDATE note SET update_seq = 1 WHERE id = '${a.id}'`);
		const open = await rowOf(a.id);
		const res = await restoreNoteVersion(as('member'), { project: P(), note: a.ref, number: 1 });
		expect(res.epoch).toBe(open.epoch + 1);
		const row = await rowOf(a.id);
		expect(row.update_seq).toBe(0);
		expect(row.version).toBe(open.version + 1);
		expect(
			await db.admin.query(`select 1 from note_update where note_id = '${a.id}'`)
		).toHaveLength(0);
		// A window still on the old version is refused when it asks for a restore against that version
		expect(
			await codeOf(
				restoreNoteVersion(as('member'), {
					project: P(),
					note: a.ref,
					number: 1,
					expectVersion: open.version
				})
			)
		).toBe('STALE_VERSION');
	});

	// -- PUBLIC LINK -- //

	it('switching on needs manage, makes a new address each time, returns it once and stores a hash only', async () => {
		const a = await mk('public text');
		expect(
			await codeOf(setNotePublicLink(as('member'), { project: P(), note: a.ref, on: true }))
		).toBe('FORBIDDEN');
		expect(
			await codeOf(setNotePublicLink(as('viewer'), { project: P(), note: a.ref, on: true }))
		).toBe('FORBIDDEN');
		const first = await setNotePublicLink(as('admin'), { project: P(), note: a.ref, on: true });
		expect(first.url).toBe(`https://board.example/n/${first.token}`);
		const hash = (await rowOf(a.id)).public_token_hash;
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(hash).not.toContain(first.token as string);
		expect((await findPublicNote(db, first.token as string))?.title).toBe(a.title);
		const second = await setNotePublicLink(as('admin'), { project: P(), note: a.ref, on: true });
		expect(second.token).not.toBe(first.token);
		// The old address stops at once
		expect(await findPublicNote(db, first.token as string)).toBeNull();
		expect((await findPublicNote(db, second.token as string))?.body).toBe('public text');
		// Neither address is in the request log, and the version number did not move
		const logged = await db.admin.query(
			`select 1 from request_log where result::text like '%${second.token}%' or result::text like '%${first.token}%'`
		);
		expect(logged).toHaveLength(0);
		expect((await rowOf(a.id)).version).toBe(a.version);
		const off = await setNotePublicLink(as('admin'), { project: P(), note: a.ref, on: false });
		expect(off.token).toBeNull();
		expect(await findPublicNote(db, second.token as string)).toBeNull();
	});

	it('a private note cannot have a link, and a link ends when the note goes private or to the trash, and a restore does not bring it back', async () => {
		const secret = await mk('x', 'private');
		expect(
			await codeOf(setNotePublicLink(as('admin'), { project: P(), note: secret.ref, on: true }))
		).toBe('NOT_FOUND');
		const a = await mk('x');
		const t1 = await on(a.ref);
		await updateNote(w.ctx('member'), { project: P(), note: a.ref, visibility: 'private' });
		expect(await findPublicNote(db, t1)).toBeNull();
		expect((await rowOf(a.id)).public_enabled).toBe(false);
		const b = await mk('x');
		const t2 = await on(b.ref);
		await trashNote(as('admin'), { project: P(), note: b.ref });
		expect(await findPublicNote(db, t2)).toBeNull();
		expect((await rowOf(b.id)).public_token_hash).toBeNull();
	});

	it('a folder in the trash switches the links under it off', async () => {
		const f = await createFolder(w.ctx('member'), { project: P(), name: `Public ${++n}` });
		const c = await createNote(w.ctx('member'), {
			project: P(),
			title: 'In folder',
			folderId: f.id
		});
		const token = await on(c.ref);
		expect((await findPublicNote(db, token))?.title).toBe('In folder');
		await trashFolder(as('admin'), { project: P(), folder: f.id });
		expect(await findPublicNote(db, token)).toBeNull();
	});

	it('a wrong, off, trashed and private link give the same answer', async () => {
		const live = await mk('live');
		const token = await on(live.ref);
		const wrong = 'A'.repeat(32);
		const off = await mk('off');
		const offToken = await on(off.ref);
		await setNotePublicLink(as('admin'), { project: P(), note: off.ref, on: false });
		const trashed = await mk('trashed');
		const trashedToken = await on(trashed.ref);
		await trashNote(as('admin'), { project: P(), note: trashed.ref });
		const priv = await mk('priv');
		const privToken = await on(priv.ref);
		await updateNote(w.ctx('member'), { project: P(), note: priv.ref, visibility: 'private' });
		expect(await findPublicNote(db, token)).not.toBeNull();
		for (const t of [wrong, offToken, trashedToken, privToken, 'short', '']) {
			expect(await findPublicNote(db, t), t).toBeNull();
		}
	});

	it('a link enabled behind the board’s back still follows the policy: nothing for a trashed or private row', async () => {
		const a = await mk('direct');
		const token = await on(a.ref);
		// Private and trashed rows with the flag still on (the verbs never do this, the policy must hold anyway)
		await db.admin.exec(`UPDATE note SET visibility = 'private' WHERE id = '${a.id}'`);
		expect(await findPublicNote(db, token)).toBeNull();
		await db.admin.exec(
			`UPDATE note SET visibility = 'public', deleted_at = now() WHERE id = '${a.id}'`
		);
		expect(await findPublicNote(db, token)).toBeNull();
	});

	it('serves a picture only under the link of the note that owns it', async () => {
		const mine = await mk('with picture');
		const other = await mk('another note');
		const pic = await uploadNoteFile(as('member'), { project: P(), note: mine.ref }, PNG);
		const otherPic = await uploadNoteFile(as('member'), { project: P(), note: other.ref }, PNG);
		const token = await on(mine.ref);
		const otherToken = await on(other.ref);
		const deps = { handle: db, storage: store };
		const ok = await servePublicNoteFile(deps, token, pic.id);
		expect(ok.status).toBe(200);
		expect(ok.headers.get('content-type')).toBe('image/png');
		expect(ok.headers.get('referrer-policy')).toBe('no-referrer');
		expect(Array.from(new Uint8Array(await ok.arrayBuffer()))).toEqual(Array.from(PNG));
		// The picture of another note is not served under this address, and a wrong address or id serves nothing
		expect((await servePublicNoteFile(deps, token, otherPic.id)).status).toBe(404);
		expect((await servePublicNoteFile(deps, otherToken, pic.id)).status).toBe(404);
		expect((await servePublicNoteFile(deps, 'B'.repeat(32), pic.id)).status).toBe(404);
		expect((await servePublicNoteFile(deps, token, 'not-a-uuid')).status).toBe(404);
		// A link that is off serves no picture
		await setNotePublicLink(as('admin'), { project: P(), note: mine.ref, on: false });
		expect((await servePublicNoteFile(deps, token, pic.id)).status).toBe(404);
	});

	it('the endpoints carry the same rules: history for a reader, manage for the link', async () => {
		const a = await mk('api one');
		await updateNote(w.ctx('member'), { project: P(), note: a.ref, body: 'api two' }, 'agent');
		const deps: ApiDeps = { handle: db, storage: store, baseUrl: 'http://localhost:5180' };
		const slug = `world-${w.projectKey.slice(3)}`;
		const call = (who: keyof World['people'], method: string, path: string, body?: unknown) =>
			handleApi(
				{
					method,
					path: `/orgs/${slug}${path}`,
					query: {},
					headers: new Headers(),
					body:
						body !== undefined ? new TextEncoder().encode(JSON.stringify(body)) : new Uint8Array(),
					session: { id: w.people[who], name: who }
				},
				deps
			);
		const base = `/projects/${P()}/notes/${a.ref}`;
		const list = await call('viewer', 'GET', `${base}/versions`);
		expect(list.status).toBe(200);
		expect((list.body as { versions: unknown[] }).versions.length).toBe(1);
		expect((await call('viewer', 'GET', `${base}/versions/1`)).status).toBe(200);
		expect((await call('viewer', 'GET', `${base}/versions/x`)).status).toBe(400);
		expect((await call('viewer', 'POST', `${base}/versions/1/restore`, {})).status).toBe(403);
		expect((await call('member', 'POST', `${base}/versions/1/restore`, {})).status).toBe(200);
		expect((await call('member', 'POST', `${base}/public-link`, { on: true })).status).toBe(403);
		const link = await call('admin', 'POST', `${base}/public-link`, { on: true });
		expect(link.status).toBe(200);
		expect(String((link.body as { url: string }).url)).toContain('/n/');
	});
});
