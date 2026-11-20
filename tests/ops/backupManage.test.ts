// BACKUP MANAGEMENT: AN ADMIN OR OWNER DOWNLOADS AND DELETES THE BACKUPS OF THEIR OWN ORGANISATION. THE ROLE IS CHECKED BY THE VERB,
// ANOTHER ORGANISATION'S BACKUP IS NEVER REACHABLE, A RUNNING BACKUP IS REFUSED, AND A DELETE REMOVES THE STORED FILE BEFORE THE RECORD.

// IMPORTED DEP-MODULES
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
// IMPORTED MODULES
import { diskStorage, memoryStorage } from '../../src/lib/server/adapters/storage';
import { event } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import { backupDelete, backupDownload, orgBackups } from '../../src/lib/server/ops/settings';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

describe('backup management', () => {
	let db: TestDb;
	let w: World;
	const storage = memoryStorage('a-secret-of-more-than-32-characters-long!!');
	const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
	const ids = {
		good: '',
		older: '',
		failed: '',
		running: '',
		gone: '',
		foreign: ''
	};
	const ctx = (who: 'owner' | 'admin' | 'member' | 'viewer' = 'admin') => ({
		...w.ctx(who),
		services: { backups: true, backupStorage: storage }
	});

	const seed = async (
		orgId: string,
		state: string,
		extra: { location?: string; size?: number; error?: string; at: string }
	) => {
		const rows = await db.admin.query<{ id: string }>(
			`insert into backup_run (org_id, state, size, location, error, created_at) values ('${orgId}', '${state}', ${extra.size ?? 'null'}, ${extra.location ? `'${extra.location}'` : 'null'}, ${extra.error ? `'${extra.error}'` : 'null'}, '${extra.at}') returning id`
		);
		return rows[0].id;
	};
	const verbs = async (verb: string) =>
		withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select({ verb: event.verb, after: event.after }).from(event).where(eq(event.verb, verb))
		);

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		await storage.put('k/good', BYTES, 'application/octet-stream');
		await storage.put('k/older', BYTES, 'application/octet-stream');
		await storage.put('k/foreign', BYTES, 'application/octet-stream');
		ids.good = await seed(w.orgId, 'done', {
			location: 'k/good',
			size: 8,
			at: '2026-11-16T03:00:00Z'
		});
		ids.older = await seed(w.orgId, 'done', {
			location: 'k/older',
			size: 8,
			at: '2026-11-15T03:00:00Z'
		});
		ids.gone = await seed(w.orgId, 'done', {
			location: 'k/missing',
			size: 8,
			at: '2026-11-13T03:00:00Z'
		});
		ids.failed = await seed(w.orgId, 'failed', {
			error: 'The run was interrupted',
			at: '2026-11-14T03:00:00Z'
		});
		ids.running = await seed(w.orgId, 'running', { at: '2026-11-16T04:00:00Z' });
		ids.foreign = await seed(w.other.orgId, 'done', {
			location: 'k/foreign',
			size: 8,
			at: '2026-11-16T03:00:00Z'
		});
	}, 240_000);
	afterAll(() => db?.stop());

	it('the page data carries the retention, the total stored and whether files can be handed out, and never a stored path', async () => {
		const r = await orgBackups(ctx());
		expect(r.canDownload).toBe(true);
		expect(r.retention).toEqual({ max: 7 });
		expect(r.autoBackups).toBe(true);
		expect(r.stored).toEqual({ bytes: 24, copies: 3 });
		expect(JSON.stringify(r.runs)).not.toContain('k/good');
		expect(r.runs.find((x) => x.id === ids.good)?.hasFile).toBe(true);
		expect(r.runs.find((x) => x.id === ids.failed)?.hasFile).toBe(false);
		expect((await orgBackups({ ...w.ctx('admin'), services: { backups: true } })).canDownload).toBe(
			false
		);
	});

	it('a member or viewer can neither download nor delete', async () => {
		for (const who of ['member', 'viewer'] as const) {
			await expect(backupDownload(ctx(who), ids.good)).rejects.toMatchObject({ code: 'FORBIDDEN' });
			await expect(backupDelete(ctx(who), { ids: [ids.good] })).rejects.toMatchObject({
				code: 'FORBIDDEN'
			});
		}
		expect(await storage.get('k/good')).not.toBeNull();
	});

	it('a download is the stored bytes with their size, a name, and an audit entry, and only a finished backup of this org', async () => {
		const d = await backupDownload(ctx('owner'), ids.good);
		const got: number[] = [];
		for await (const chunk of d.stream) got.push(...chunk);
		expect(got).toEqual([...BYTES]);
		expect(d.size).toBe(8);
		expect(d.filename).toMatch(/^afb-world-\d+-2026-11-16\.afbbak$/);
		expect((await verbs('backup.download')).length).toBeGreaterThan(0);
		await expect(backupDownload(ctx(), ids.failed)).rejects.toMatchObject({ code: 'INVALID' });
		await expect(backupDownload(ctx(), ids.running)).rejects.toMatchObject({ code: 'INVALID' });
		await expect(backupDownload(ctx(), ids.gone)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(backupDownload(ctx(), ids.foreign)).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('a delete refuses a running backup and another organisation, and changes nothing', async () => {
		await expect(backupDelete(ctx(), { ids: [ids.older, ids.running] })).rejects.toMatchObject({
			code: 'CONFLICT'
		});
		await expect(backupDelete(ctx(), { ids: [ids.older, ids.foreign] })).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		await expect(backupDelete(ctx(), { ids: [] })).rejects.toThrow();
		await expect(backupDelete(ctx(), { ids: ['not-an-id'] })).rejects.toThrow();
		expect(await storage.get('k/older')).not.toBeNull();
		expect(await storage.get('k/foreign')).not.toBeNull();
		expect((await orgBackups(ctx())).runs.some((r) => r.id === ids.older)).toBe(true);
	});

	it('a delete removes the stored file and then the record, once, with an audit entry', async () => {
		const r = await backupDelete(ctx('admin'), { ids: [ids.older, ids.older, ids.failed] });
		// Only a backup with a stored file frees bytes: the failed run had none
		expect(r).toEqual({ deleted: 2, failed: 0, freedBytes: 8 });
		expect(await storage.get('k/older')).toBeNull();
		const left = (await orgBackups(ctx())).runs.map((x) => x.id);
		expect(left).not.toContain(ids.older);
		expect(left).not.toContain(ids.failed);
		expect(left).toContain(ids.good);
		const logged = await verbs('backup.delete');
		expect(logged).toHaveLength(1);
		expect(logged[0].after).toEqual({ deleted: 2, failed: 0, freedBytes: 8 });
		// The other organisation's backup and file are untouched
		expect(await storage.get('k/foreign')).not.toBeNull();
	});

	it('a file that cannot be removed keeps its record and is counted as failed', async () => {
		const stuck = {
			...storage,
			delete: async () => {
				throw new Error('The storage refused.');
			}
		};
		const r = await backupDelete(
			{ ...w.ctx('admin'), services: { backups: true, backupStorage: stuck } },
			{ ids: [ids.good] }
		);
		expect(r).toEqual({ deleted: 0, failed: 1, freedBytes: 0 });
		expect((await orgBackups(ctx())).runs.some((x) => x.id === ids.good)).toBe(true);
	});

	it('a delete that reports success but leaves the file behind is not trusted: the record stays and it counts as failed', async () => {
		// A storage whose delete does nothing, so the file is still there when it is looked up again
		const lingering = { ...storage, delete: async () => undefined };
		const r = await backupDelete(
			{ ...w.ctx('admin'), services: { backups: true, backupStorage: lingering } },
			{ ids: [ids.good] }
		);
		expect(r).toEqual({ deleted: 0, failed: 1, freedBytes: 0 });
		expect(await storage.get('k/good')).not.toBeNull();
		expect((await orgBackups(ctx())).runs.some((x) => x.id === ids.good)).toBe(true);
	});

	it('on a disk storage a delete really removes the file from the folder, and the folder listing shows it gone', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'afb-backup-delete-'));
		try {
			const disk = diskStorage(dir, 'a-secret-of-more-than-32-characters-long!!');
			const folder = `backups/${w.orgId}`;
			const keyA = `${folder}/2026-11-10T02-00-00-000Z.afbbak`;
			const keyB = `${folder}/2026-11-11T02-00-00-000Z.afbbak`;
			await disk.put(keyA, BYTES, 'application/octet-stream');
			await disk.put(keyB, BYTES, 'application/octet-stream');
			// A half written file of a run that is still going is never listed
			await disk.putStream(
				`${folder}/x.afbbak`,
				(async function* () {})(),
				'application/octet-stream'
			);
			await mkdir(join(dir, folder), { recursive: true });
			await writeFile(join(dir, folder, 'live.afbbak.partial'), BYTES);
			expect((await disk.list(folder)).sort()).toEqual([keyA, keyB, `${folder}/x.afbbak`].sort());
			expect(await disk.list(`backups/${w.other.orgId}`)).toEqual([]);
			const a = await seed(w.orgId, 'done', {
				location: keyA,
				size: 8,
				at: '2026-11-10T02:00:00Z'
			});
			const r = await backupDelete(
				{ ...w.ctx('admin'), services: { backups: true, backupStorage: disk } },
				{ ids: [a] }
			);
			expect(r).toEqual({ deleted: 1, failed: 0, freedBytes: 8 });
			expect(await disk.size(keyA)).toBeNull();
			expect(await disk.get(keyA)).toBeNull();
			expect((await disk.list(folder)).sort()).toEqual([keyB, `${folder}/x.afbbak`].sort());
			expect(await readdir(join(dir, folder))).not.toContain('2026-11-10T02-00-00-000Z.afbbak');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
