// NOTE PICTURES AND LINK TARGETS: UPLOAD LIMITS, THE READER CHECKED AGAINST THE PICTURE'S OWN NOTE, CLEAN UP, PURGE (AFB-20261111-0035, steps 4.4 and 4.5)

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { memoryStorage, type Storage } from '../../src/lib/server/adapters/storage';
import { bodyLimit, readBodyCapped } from '../../src/lib/server/api/body';
import { handleApi, type ApiDeps } from '../../src/lib/server/api/dispatch';
import { OpError, type Ctx } from '../../src/lib/server/ops/context';
import { purgeTrash } from '../../src/lib/server/ops/history';
import { createItem } from '../../src/lib/server/ops/items';
import { createTask } from '../../src/lib/server/ops/docs';
import { createFolder } from '../../src/lib/server/ops/noteFolders';
import {
	createNote,
	readNoteFile,
	searchLinkTargets,
	trashNote,
	updateNote,
	uploadNoteFile
} from '../../src/lib/server/ops/notes';
import { serveNoteFile } from '../../src/lib/server/web/noteFile';
import { NOTE_LIMITS } from '../../src/lib/shared/notes';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
const SECRET = 'note-file-secret-0123456789abcdef';

// -- FUNCTIONS -- //

describe('note pictures', () => {
	let db: TestDb;
	let w: World;
	let store: ReturnType<typeof memoryStorage>;
	let n = 0;
	const P = () => w.projectKey;
	const as = (who: keyof World['people'], storage: Storage = store): Ctx => ({
		...w.ctx(who),
		services: { storage }
	});
	const codeOf = async (p: Promise<unknown>) => {
		try {
			await p;
			return 'OK';
		} catch (e) {
			return e instanceof OpError ? e.code : String(e);
		}
	};
	const mk = async (who: keyof World['people'], visibility: 'public' | 'private' = 'public') =>
		(await createNote(w.ctx(who), { project: P(), title: `Note ${++n}`, visibility })).ref;
	const put = (who: keyof World['people'], note: string, bytes = PNG, storage?: Storage) =>
		uploadNoteFile(as(who, storage), { project: P(), note }, bytes);
	const rows = () =>
		db.admin.query<{ id: string; storage_key: string }>(
			`select id, storage_key from note_file where org_id = '${w.orgId}'`
		);

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		store = memoryStorage(SECRET);
	}, 180_000);
	afterAll(async () => {
		await db?.stop();
	});

	it('stores a picture by its first bytes and a reader who may see the note reads it back', async () => {
		const ref = await mk('member');
		const up = await put('member', ref, PNG);
		expect(up.mime).toBe('image/png');
		expect(up.markdown).toBe(`![](afb:file/${up.id})`);
		const [row] = await rows();
		expect(store.files.get(row.storage_key)?.mime).toBe('image/png');
		expect(row.storage_key.startsWith('notes/')).toBe(true);
		for (const who of ['viewer', 'admin', 'owner'] as const) {
			const read = await readNoteFile(as(who), up.id);
			expect(read.mime).toBe('image/png');
			expect(Array.from(read.bytes)).toEqual(Array.from(PNG));
		}
		expect((await put('member', ref, JPG)).mime).toBe('image/jpeg');
	});

	it('refuses a wrong type, an empty body, SVG and a picture over the limit, storing nothing', async () => {
		const ref = await mk('member');
		const before = store.files.size;
		for (const bad of [SVG, new Uint8Array(), new TextEncoder().encode('GIF89 not really')])
			expect(await codeOf(put('member', ref, bad))).toBe('INVALID');
		const big = new Uint8Array(NOTE_LIMITS.pictureBytes + 1);
		big.set(PNG);
		expect(await codeOf(put('member', ref, big))).toBe('INVALID');
		expect(store.files.size).toBe(before);
		// A viewer cannot add pictures, a guest does not even see the note
		expect(await codeOf(put('viewer', ref))).toBe('FORBIDDEN');
		expect(await codeOf(put('guest', ref))).toBe('NOT_FOUND');
	});

	it('cuts a body over the cap while it streams in, from the declared size first', async () => {
		expect(bodyLimit('POST', `/orgs/acme/projects/P/notes/N-1/files`)).toBeGreaterThan(
			NOTE_LIMITS.pictureBytes
		);
		expect(bodyLimit('POST', `/orgs/acme/projects/P/notes/N-1/files`)).toBeLessThan(
			NOTE_LIMITS.pictureBytes + 1024 * 1024
		);
		const limit = 1000;
		const declared = new Request('http://x/', {
			method: 'POST',
			headers: { 'content-length': '5000' },
			body: new Uint8Array(10)
		});
		expect(await readBodyCapped(declared, limit)).toBeNull();
		// No honest length: the running total stops the read
		const stream = new ReadableStream<Uint8Array>({
			pull(c) {
				c.enqueue(new Uint8Array(400));
			}
		});
		const lying = new Request('http://x/', {
			method: 'POST',
			body: stream,
			// @ts-expect-error duplex is required for a streaming body in Node
			duplex: 'half'
		});
		expect(await readBodyCapped(lying, limit)).toBeNull();
	});

	it('refuses more than 200 MB of pictures on one note', async () => {
		const ref = await mk('member');
		const [{ id }] = await db.admin.query<{ id: string }>(
			`select id from note where org_id = '${w.orgId}' and number = ${Number(ref.slice(2))}`
		);
		await db.admin.exec(
			`insert into note_file (org_id, project_id, note_id, storage_key, mime, size, checksum) values ('${w.orgId}', '${w.projectId}', '${id}', 'notes/fake/${id}.png', 'image/png', ${NOTE_LIMITS.notePictureBytes - 5}, 'x')`
		);
		expect(await codeOf(put('member', ref, PNG))).toBe('INVALID');
		await db.admin.exec(`delete from note_file where note_id = '${id}'`);
		expect(await codeOf(put('member', ref, PNG))).toBe('OK');
	});

	it('allows two uploads at once per person and refuses the third', async () => {
		const refs = [await mk('admin'), await mk('admin'), await mk('admin')];
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let waiting = 0;
		const slow: Storage = {
			...store,
			kind: 'memory',
			async put(key, bytes, mime) {
				waiting++;
				await gate;
				return store.put(key, bytes, mime);
			}
		};
		const a = put('admin', refs[0], PNG, slow);
		const b = put('admin', refs[1], PNG, slow);
		a.catch(() => undefined);
		b.catch(() => undefined);
		// The test database has one connection for the app, so the second upload may still be waiting for it: it holds its slot already
		for (let i = 0; i < 400 && waiting < 1; i++) await new Promise((r) => setTimeout(r, 25));
		try {
			expect(waiting).toBeGreaterThanOrEqual(1);
			expect(await codeOf(put('admin', refs[2], PNG, slow))).toBe('RATE_LIMITED');
		} finally {
			release();
		}
		await Promise.all([a, b]);
		// The slots are free again
		expect(await codeOf(put('admin', refs[2]))).toBe('OK');
	});

	it('leaves no stored file behind when the second put fails or the row write fails', async () => {
		const ref = await mk('member');
		const before = store.files.size;
		const rowsBefore = (await rows()).length;
		let calls = 0;
		const flaky: Storage = {
			...store,
			kind: 'memory',
			async put(key, bytes, mime) {
				if (++calls === 2) throw new Error('disk full');
				return store.put(key, bytes, mime);
			}
		};
		expect(await codeOf(put('member', ref, PNG, flaky))).toBe('OK');
		expect(await codeOf(put('member', ref, PNG, flaky))).toContain('disk full');
		expect(store.files.size).toBe(before + 1);
		expect((await rows()).length).toBe(rowsBefore + 1);
		// The row write fails after the file was stored: the file is removed again
		await db.admin.exec(
			`alter table note_file add constraint tmp_refuse check (size < 0) not valid`
		);
		try {
			expect(await codeOf(put('member', ref, PNG))).not.toBe('OK');
		} finally {
			await db.admin.exec(`alter table note_file drop constraint tmp_refuse`);
		}
		expect(store.files.size).toBe(before + 1);
		expect((await rows()).length).toBe(rowsBefore + 1);
	});

	it('checks the reader against the picture own note, not the note whose text names it', async () => {
		const secret = await mk('member', 'private');
		const up = await put('member', secret, PNG);
		// The creator reads it, nobody else on the project does, a guest and another org never do
		expect((await readNoteFile(as('member'), up.id)).mime).toBe('image/png');
		for (const who of ['admin', 'owner', 'viewer', 'guest'] as const)
			expect(await codeOf(readNoteFile(as(who), up.id)), who).toBe('NOT_FOUND');
		// Its id written into a shared note by someone else shows nothing to anyone but the creator
		const shared = await mk('admin');
		await updateNote(w.ctx('admin'), {
			project: P(),
			note: shared,
			body: `![](afb:file/${up.id})`
		});
		expect(await codeOf(readNoteFile(as('owner'), up.id))).toBe('NOT_FOUND');
		expect(await codeOf(readNoteFile(as('admin'), up.id))).toBe('NOT_FOUND');
		// The same answer as an id that does not exist
		expect(await codeOf(readNoteFile(as('admin'), '00000000-0000-4000-a000-00000000ffff'))).toBe(
			'NOT_FOUND'
		);
		expect(await codeOf(readNoteFile(as('admin'), 'not-an-id'))).toBe('NOT_FOUND');
		// A note in the trash shows no pictures either
		const gone = await mk('member');
		const pic = await put('member', gone, PNG);
		await trashNote(w.ctx('member'), { project: P(), note: gone });
		expect(await codeOf(readNoteFile(as('member'), pic.id))).toBe('NOT_FOUND');
	});

	it('serves the picture with the isolating headers, 401 without a person and 404 for every refusal', async () => {
		const ref = await mk('member');
		const up = await put('member', ref, PNG);
		const deps = { handle: db, storage: store };
		const person = (who: keyof World['people']) => ({ id: w.people[who], name: who });
		const slug = `world-${w.projectKey.slice(3)}`;
		const ok = await serveNoteFile(deps, person('viewer'), slug, up.id);
		expect(ok.status).toBe(200);
		expect(ok.headers.get('content-type')).toBe('image/png');
		expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
		expect(ok.headers.get('content-security-policy')).toContain('sandbox');
		expect(ok.headers.get('cache-control')).toContain('private');
		const etag = ok.headers.get('etag')!;
		expect((await serveNoteFile(deps, person('viewer'), slug, up.id, etag)).status).toBe(304);
		expect((await serveNoteFile(deps, null, slug, up.id)).status).toBe(401);
		expect((await serveNoteFile(deps, person('guest'), slug, up.id)).status).toBe(404);
		// A person of another org, and the right person with the wrong org
		const stranger = { id: w.other.userId, name: 'other' };
		expect((await serveNoteFile(deps, stranger, slug, up.id)).status).toBe(404);
		expect((await serveNoteFile(deps, stranger, `other-${slug.slice(6)}`, up.id)).status).toBe(404);
		expect((await serveNoteFile(deps, person('viewer'), slug, 'nope')).status).toBe(404);
		expect(
			(await serveNoteFile({ handle: db, storage: null }, person('viewer'), slug, up.id)).status
		).toBe(404);
	});

	it('takes a picture through the REST route and finds link targets through it', async () => {
		const deps: ApiDeps = { handle: db, storage: store, baseUrl: 'http://localhost:5180' };
		const slug = `world-${w.projectKey.slice(3)}`;
		const ref = await mk('member');
		const res = await handleApi(
			{
				method: 'POST',
				path: `/orgs/${slug}/projects/${P()}/notes/${ref}/files`,
				query: {},
				headers: new Headers(),
				body: PNG,
				session: { id: w.people.member, name: 'member' }
			},
			deps
		);
		expect(res.status).toBe(200);
		expect((res.body as { markdown: string }).markdown).toMatch(/^!\[\]\(afb:file\//);
		const found = await handleApi(
			{
				method: 'GET',
				path: `/orgs/${slug}/projects/${P()}/notes/link-targets`,
				query: { q: 'Note' },
				headers: new Headers(),
				body: new Uint8Array(),
				session: { id: w.people.member, name: 'member' }
			},
			deps
		);
		expect(found.status).toBe(200);
		expect((found.body as { targets: unknown[] }).targets.length).toBeGreaterThan(0);
	});

	it('offers link targets the caller may see, a few of each kind, and nothing to a guest', async () => {
		const tag = `zq${++n}`;
		await createItem(w.ctx('member'), { project: P(), title: `${tag} open plan`, ...PLAN });
		await createItem(w.ctx('admin'), {
			project: P(),
			title: `${tag} secret plan`,
			visibility: 'private',
			...PLAN
		});
		await createTask(w.ctx('member'), { project: P(), title: `${tag} a task` });
		await createNote(w.ctx('member'), { project: P(), title: `${tag} open note` });
		await createNote(w.ctx('admin'), {
			project: P(),
			title: `${tag} secret note`,
			visibility: 'private'
		});
		await db.admin.exec(
			`insert into mockup (org_id, project_id, title, visibility, created_by) values
			 ('${w.orgId}', '${w.projectId}', '${tag} open mockup', 'public', '${w.people.admin}'),
			 ('${w.orgId}', '${w.projectId}', '${tag} secret mockup', 'private', '${w.people.admin}')`
		);
		const titles = async (who: keyof World['people'], q = tag) =>
			(await searchLinkTargets(w.ctx(who), { project: P(), q })).targets.map((t) => t.title).sort();
		expect(await titles('member')).toEqual([
			`${tag} a task`,
			`${tag} open mockup`,
			`${tag} open note`,
			`${tag} open plan`
		]);
		// The person who wrote the private ones is offered them; nobody else, an owner included
		expect(await titles('admin')).toEqual([
			`${tag} a task`,
			`${tag} open mockup`,
			`${tag} open note`,
			`${tag} open plan`,
			`${tag} secret mockup`,
			`${tag} secret note`,
			`${tag} secret plan`
		]);
		expect(await titles('owner')).not.toContain(`${tag} secret note`);
		expect(await titles('owner')).not.toContain(`${tag} secret plan`);
		expect(await titles('owner')).not.toContain(`${tag} secret mockup`);
		// A guest has no role on the project at all: the project itself is not there for them
		expect(await codeOf(titles('guest'))).toBe('NOT_FOUND');
		const kinds = (await searchLinkTargets(w.ctx('member'), { project: P(), q: tag })).targets;
		expect(kinds.map((t) => t.kind).sort()).toEqual(['item', 'mockup', 'note', 'task']);
		expect(kinds.find((t) => t.kind === 'task')?.ref).toMatch(/^T-\d+$/);
		expect(kinds.find((t) => t.kind === 'note')?.ref).toMatch(/^N-\d+$/);
		// A search for % finds titles with a percent sign, not everything
		expect(await titles('member', '%')).toEqual([]);
	});

	it('returns at most ten targets in all, from every kind in turn', async () => {
		const tag = `many${++n}`;
		for (let i = 0; i < 12; i++)
			await createNote(w.ctx('member'), { project: P(), title: `${tag} note ${i}` });
		await createTask(w.ctx('member'), { project: P(), title: `${tag} task` });
		const { targets } = await searchLinkTargets(w.ctx('member'), { project: P(), q: tag });
		expect(targets.length).toBe(10);
		expect(targets.some((t) => t.kind === 'task')).toBe(true);
	});

	it('does not offer targets of another project or organisation', async () => {
		const tag = `elsewhere${++n}`;
		await db.admin.exec(
			`insert into note (org_id, project_id, number, title, created_by) values ('${w.other.orgId}', '${w.other.projectId}', 1, '${tag}', '${w.other.userId}')`
		);
		expect((await searchLinkTargets(w.ctx('member'), { project: P(), q: tag })).targets).toEqual(
			[]
		);
		expect(await codeOf(searchLinkTargets(w.ctx('member'), { project: 'NOPE', q: tag }))).toBe(
			'NOT_FOUND'
		);
	});

	it('the purge collects the picture keys before the rows go and deletes the stored files', async () => {
		const ref = await mk('member');
		const up = await put('member', ref, PNG);
		const [row] = (await rows()).filter((r) => r.id === up.id);
		await trashNote(w.ctx('member'), { project: P(), note: ref });
		await db.admin.exec(
			`update note set deleted_at = now() - interval '40 days' where org_id = '${w.orgId}' and number = ${Number(ref.slice(2))}`
		);
		// A note under a folder that has been in the trash for long goes with the folder
		const folder = await createFolder(w.ctx('member'), { project: P(), name: `Old ${n}` });
		const inside = await createNote(w.ctx('member'), {
			project: P(),
			title: 'Inside',
			folderId: (folder as { id: string }).id
		});
		const pic2 = await put('member', inside.ref, JPG);
		const [row2] = (await rows()).filter((r) => r.id === pic2.id);
		await db.admin.exec(
			`update note_folder set deleted_at = now() - interval '40 days' where id = '${(folder as { id: string }).id}'`
		);
		expect(store.files.has(row.storage_key)).toBe(true);
		expect(store.files.has(row2.storage_key)).toBe(true);
		await purgeTrash(as('admin'));
		expect(store.files.has(row.storage_key)).toBe(false);
		expect(store.files.has(row2.storage_key)).toBe(false);
		expect((await rows()).some((r) => r.id === up.id || r.id === pic2.id)).toBe(false);
	});
});
