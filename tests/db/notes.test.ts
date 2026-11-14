// NOTE TABLES AT THE DATABASE LEVEL: REGISTRY, COUNTER, SIBLING NAMES, BYTES, ISOLATION, HISTORY GRANTS AND THE PUBLIC READ POLICIES (AFB-20261111-0035)

// IMPORTED DEP-MODULES
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { allocateNoteNumber } from '../../src/lib/server/db/numbering';
import {
	TENANT_TABLES,
	note,
	noteFavourite,
	noteFile,
	noteFolder,
	noteLink,
	noteUpdate,
	noteVersion
} from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import { makePostgres, seedTwoOrgs, type Seed, type TestDb } from '../support/db';

// -- CONSTANTS -- //

const NOTE_TABLES = [
	'note',
	'note_folder',
	'note_version',
	'note_link',
	'note_file',
	'note_favourite',
	'note_update'
];

// -- FUNCTIONS -- //

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const nid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;

describe('note tables', () => {
	let db: TestDb;
	let s: Seed;
	const A = () => ({ orgId: s.orgA, projectId: s.projectA, userId: 'u-a' });
	const B = () => ({ orgId: s.orgB, projectId: s.projectB, userId: 'u-b' });

	beforeAll(async () => {
		db = await makePostgres();
		s = await seedTwoOrgs(db);
		// One note in each org, with one row in every table that hangs on it
		for (const [n, org, project, user] of [
			[1, s.orgA, s.projectA, 'u-a'],
			[2, s.orgB, s.projectB, 'u-b']
		] as const) {
			await db.admin.exec(
				`INSERT INTO note_folder (id, org_id, project_id, name) VALUES ('${nid(n * 10)}', '${org}', '${project}', 'Research')`
			);
			await db.admin.exec(
				`INSERT INTO note (id, org_id, project_id, number, title, body, folder_id, created_by) VALUES ('${nid(n)}', '${org}', '${project}', 50, 'Note ${n}', 'Body', '${nid(n * 10)}', '${user}')`
			);
			await db.admin.exec(
				`INSERT INTO note_version (org_id, project_id, note_id, number, title, body, cause) VALUES ('${org}', '${project}', '${nid(n)}', 1, 'Old', 'Old body', 'agent')`
			);
			await db.admin.exec(
				`INSERT INTO note_link (org_id, project_id, note_id, target_kind, target_id, source) VALUES ('${org}', '${project}', '${nid(n)}', 'item', '${n === 1 ? s.itemA : s.itemB}', 'panel')`
			);
			await db.admin.exec(
				`INSERT INTO note_file (id, org_id, project_id, note_id, storage_key, mime, size, checksum) VALUES ('${nid(n * 100)}', '${org}', '${project}', '${nid(n)}', 'notes/${n}/a.png', 'image/png', 3, 'x')`
			);
			await db.admin.exec(
				`INSERT INTO note_favourite (org_id, project_id, note_id, user_id) VALUES ('${org}', '${project}', '${nid(n)}', '${user}')`
			);
			await db.admin.exec(
				`INSERT INTO note_update (org_id, project_id, note_id, epoch, seq, update) VALUES ('${org}', '${project}', '${nid(n)}', 1, 1, '\\x0102')`
			);
		}
	}, 180_000);
	afterAll(async () => {
		await db?.stop();
	});

	it('all seven tables are in the tenant registry', () => {
		const registered = new Set(TENANT_TABLES.map((t) => t.name));
		for (const name of NOTE_TABLES) expect(registered.has(name), name).toBe(true);
	});

	it('another organisation and another project read nothing from any note table', async () => {
		for (const name of NOTE_TABLES) {
			const own = await withTenant(db, A(), (tx) =>
				tx.execute(sql.raw(`select count(*)::int as n from "${name}"`))
			);
			expect((own as unknown as { rows: { n: number }[] }).rows[0].n, `${name} own`).toBe(1);
			// Org B asks for org A's rows by id and gets none
			const cross = await withTenant(db, B(), (tx) =>
				tx.execute(sql.raw(`select count(*)::int as n from "${name}" where org_id = '${s.orgA}'`))
			);
			expect((cross as unknown as { rows: { n: number }[] }).rows[0].n, `${name} cross org`).toBe(
				0
			);
			// The second project of org A sees nothing of the first
			const otherProject = await withTenant(
				db,
				{ orgId: s.orgA, projectId: s.projectA2, userId: 'u-a' },
				(tx) => tx.execute(sql.raw(`select count(*)::int as n from "${name}"`))
			);
			expect(
				(otherProject as unknown as { rows: { n: number }[] }).rows[0].n,
				`${name} cross project`
			).toBe(0);
		}
	});

	it('the first note of a project with no counter row gets number 1, and the next gets 2', async () => {
		await db.admin.exec(`DELETE FROM project_counter WHERE project_id = '${s.projectA2}'`);
		const tenant = { orgId: s.orgA, projectId: s.projectA2, userId: 'u-a' };
		const first = await withTenant(db, tenant, (tx) => allocateNoteNumber(tx, s.orgA, s.projectA2));
		const second = await withTenant(db, tenant, (tx) =>
			allocateNoteNumber(tx, s.orgA, s.projectA2)
		);
		expect([first, second]).toEqual([1, 2]);
		// A project whose counter row was made before notes existed starts at 1 too
		const seeded = await withTenant(db, A(), (tx) => allocateNoteNumber(tx, s.orgA, s.projectA));
		expect(seeded).toBe(1);
	});

	it('two live folders with the same name are refused at the top level and in a folder, whatever the case', async () => {
		const add = (name: string, parentId: string | null) =>
			withTenant(db, A(), (tx) =>
				tx.insert(noteFolder).values({ orgId: s.orgA, projectId: s.projectA, name, parentId })
			);
		await expect(add('research', null)).rejects.toThrow();
		await add('Child', nid(10));
		await expect(add('CHILD', nid(10))).rejects.toThrow();
		// A folder in the trash does not hold its name
		await withTenant(db, A(), (tx) =>
			tx.update(noteFolder).set({ deletedAt: new Date() }).where(eq(noteFolder.name, 'Child'))
		);
		await add('child', nid(10));
	});

	it('bytes of a live update come back as they went in', async () => {
		const bytes = new Uint8Array([0, 1, 2, 250, 255]);
		await withTenant(db, A(), (tx) =>
			tx.insert(noteUpdate).values({
				orgId: s.orgA,
				projectId: s.projectA,
				noteId: nid(1),
				epoch: 1,
				seq: 2,
				update: bytes
			})
		);
		const [row] = await withTenant(db, A(), (tx) =>
			tx.select({ update: noteUpdate.update }).from(noteUpdate).where(eq(noteUpdate.seq, 2))
		);
		expect([...row.update]).toEqual([...bytes]);
	});

	it('the runtime role can add a version but never change or delete one', async () => {
		await withTenant(db, A(), (tx) =>
			tx.insert(noteVersion).values({
				orgId: s.orgA,
				projectId: s.projectA,
				noteId: nid(1),
				number: 2,
				title: 'T',
				body: 'B',
				cause: 'typing'
			})
		);
		await expect(
			withTenant(db, A(), (tx) => tx.update(noteVersion).set({ body: 'changed' }))
		).rejects.toThrow();
		await expect(withTenant(db, A(), (tx) => tx.delete(noteVersion))).rejects.toThrow();
	});

	it('the public policies read only the note of the address, with its pictures, and nothing when it is off, private or trashed', async () => {
		const token = sha('address-a');
		const viaLink = () =>
			withTenant(db, { noteTokenHash: token }, async (tx) => ({
				notes: await tx.select({ id: note.id }).from(note),
				files: await tx.select({ id: noteFile.id }).from(noteFile),
				versions: await tx.select({ id: noteVersion.id }).from(noteVersion),
				links: await tx.select({ id: noteLink.id }).from(noteLink),
				favourites: await tx.select({ id: noteFavourite.id }).from(noteFavourite)
			}));
		const set = (q: string) => db.admin.exec(`UPDATE note SET ${q} WHERE id = '${nid(1)}'`);
		await set(`public_enabled = true, public_token_hash = '${token}'`);
		const on = await viaLink();
		expect(on.notes.map((n) => n.id)).toEqual([nid(1)]);
		expect(on.files.map((f) => f.id)).toEqual([nid(100)]);
		// Nothing else of the note is readable through the link
		expect([on.versions.length, on.links.length, on.favourites.length]).toEqual([0, 0, 0]);
		// A write through the link is refused
		await expect(
			withTenant(db, { noteTokenHash: token }, (tx) => tx.update(note).set({ title: 'x' }))
		).resolves.toBeDefined();
		const [untouched] = await db.admin.query<{ title: string }>(
			`select title from note where id = '${nid(1)}'`
		);
		expect(untouched.title).toBe('Note 1');
		for (const off of [
			`public_enabled = false`,
			`public_enabled = true, visibility = 'private'`,
			`visibility = 'public', deleted_at = now()`
		]) {
			await set(off);
			const res = await viaLink();
			expect([res.notes.length, res.files.length], off).toEqual([0, 0]);
		}
		await set(`deleted_at = null, public_enabled = false, public_token_hash = null`);
		await expect(withTenant(db, { noteTokenHash: 'not-hex' }, async () => 1)).rejects.toThrow(
			'noteTokenHash'
		);
	});

	it('the public read policy is a read only policy on the note and its pictures alone', async () => {
		const rows = await db.admin.query<{ tablename: string; cmd: string }>(
			`select tablename, cmd from pg_policies where policyname = 'note_public_read' order by tablename`
		);
		expect(rows).toEqual([
			{ tablename: 'note', cmd: 'SELECT' },
			{ tablename: 'note_file', cmd: 'SELECT' }
		]);
	});

	it('deleting a note takes its versions, links, pictures, favourites and updates with it, and a folder takes its notes', async () => {
		await withTenant(db, A(), (tx) => tx.delete(noteFolder).where(eq(noteFolder.id, nid(10))));
		for (const name of NOTE_TABLES) {
			const left = await db.admin.query<{ n: number }>(
				`select count(*)::int as n from "${name}" where org_id = '${s.orgA}'`
			);
			expect(left[0].n, name).toBe(0);
		}
		// Org B is untouched
		const b = await db.admin.query<{ n: number }>(
			`select count(*)::int as n from note_version where org_id = '${s.orgB}'`
		);
		expect(b[0].n).toBe(1);
	});
});
