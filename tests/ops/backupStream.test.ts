// THE BACKUP AND THE RESTORE AS STREAMS: A RESTORE THAT CANNOT BE READ COMPLETELY CHANGES NOTHING, A BACKUP THAT FAILS WHILE IT IS
// WRITTEN LEAVES NO ARCHIVE, AND A BACKUP OF 200 MB OF FILES STAYS FAR BELOW THAT IN MEMORY (THE SMALL SERVER RAN OUT OF IT).

// IMPORTED TYPES
import type { Storage } from '../../src/lib/server/adapters/storage';
// IMPORTED DEP-MODULES
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
// IMPORTED MODULES
import {
	diskStorage,
	memoryStorage,
	sweepPartialFiles
} from '../../src/lib/server/adapters/storage';
import { adminFromExecutor } from '../../src/lib/server/backup/admin';
import { BackupError, writeArchive } from '../../src/lib/server/backup/archive';
import { exportOrg } from '../../src/lib/server/backup/dump';
import { restoreAll, restoreOrg } from '../../src/lib/server/backup/restore';
import { runBackup } from '../../src/lib/server/backup/run';
import { backupRun } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import { addAttachment } from '../../src/lib/server/ops/attachments';
import { createItem } from '../../src/lib/server/ops/items';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const KEY = 'a-backup-key-of-more-than-32-characters!!';
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5]);
const MB = 1024 * 1024;
/** Eight files of 25 MB each: 200 MB that cannot be compressed. */
const BIG_FILES = 8;
const BIG_SIZE = 25 * MB;
/** What the streamed backup may add in memory while it runs (the data itself is 200 MB, and one file is held at a time). */
const MEMORY_CAP = 150 * MB;

// -- FUNCTIONS -- //

/** The largest rise of the process's external memory (buffers) while `work` runs. */
async function peakExternal<T>(work: () => Promise<T>): Promise<{ result: T; growth: number }> {
	const base = process.memoryUsage().external;
	let peak = base;
	const timer = setInterval(() => {
		peak = Math.max(peak, process.memoryUsage().external);
	}, 10);
	try {
		const result = await work();
		peak = Math.max(peak, process.memoryUsage().external);
		return { result, growth: peak - base };
	} finally {
		clearInterval(timer);
	}
}

describe('backups and restores that stream', () => {
	let src: TestDb;
	let w: World;
	const folders: string[] = [];
	let files: Storage;
	let attachmentKey = '';
	const admin = () => adminFromExecutor(src.admin);
	const folder = async () => {
		const dir = await mkdtemp(join(tmpdir(), 'afb-stream-'));
		folders.push(dir);
		return dir;
	};
	const rowsOf = (orgId: string) =>
		withTenant(src, { orgId }, (tx) =>
			tx.select().from(backupRun).where(eq(backupRun.orgId, orgId))
		);

	beforeAll(async () => {
		src = await makePostgres();
		w = await makeWorld(src);
		files = diskStorage(await folder(), 'storage-secret-for-tests-0123456789');
		const ctx = { ...w.ctx('member'), services: { storage: files, baseUrl: 'http://x' } };
		const made = await createItem(ctx, { project: w.projectKey, title: 'Streamed item', ...PLAN });
		await addAttachment(
			ctx,
			{
				item: made.ref,
				filename: 'shot.png',
				caption: 'Shot',
				kind: 'ui-shot',
				visibility: 'private',
				refs: []
			},
			PNG
		);
		const { frames } = await exportOrg(admin(), files, w.orgId);
		attachmentKey = (frames.find((f) => f.type === 'file')!.json as { key: string }).key;
	}, 240_000);
	afterAll(async () => {
		await src?.stop();
		for (const dir of folders) await rm(dir, { recursive: true, force: true });
	});

	it('a restore that cannot be read completely leaves the database and the storage as they were', async () => {
		const good = writeArchive((await exportOrg(admin(), files, w.orgId)).frames, KEY);
		const dst = await makePostgres();
		try {
			const target = adminFromExecutor(dst.admin);
			const restoredFiles = memoryStorage('storage-secret-for-tests-0123456789');
			await restoreOrg(good, KEY, target, { storage: restoredFiles });
			await target.query(
				`update "item" set "title" = 'Changed after the backup' where "org_id" = $1`,
				[w.orgId]
			);
			const state = async () =>
				JSON.stringify(
					await target.query(`select "title" from "item" where "org_id" = $1 order by "id"`, [
						w.orgId
					])
				);
			const before = await state();
			const fileCount = restoredFiles.files.size;
			const cutTail = good.subarray(0, good.length - 5);
			// Cut after its table frames: the header counts a file the archive no longer holds
			const noFiles = writeArchive(
				(await exportOrg(admin(), files, w.orgId)).frames.filter((f) => f.type !== 'file'),
				KEY
			);
			const cases: [Uint8Array, string][] = [
				[cutTail, KEY],
				[good, 'wrong-key-wrong-key-wrong-key-wrong-key'],
				[noFiles, KEY]
			];
			for (const [archive, key] of cases) {
				await expect(
					restoreOrg(archive, key, target, { storage: restoredFiles, replace: true })
				).rejects.toThrow(BackupError);
				expect(await state()).toBe(before);
				expect(restoredFiles.files.size).toBe(fileCount);
			}
			// A full restore with one bad archive among good ones writes nothing at all
			const empty = await makePostgres();
			try {
				await expect(
					restoreAll([good, cutTail], KEY, adminFromExecutor(empty.admin))
				).rejects.toThrow(BackupError);
				expect((await empty.admin.query(`select 1 from "org"`)).length).toBe(0);
			} finally {
				await empty.stop();
			}
		} finally {
			await dst.stop();
		}
	}, 240_000);

	it('a backup that fails while it is being written leaves no archive and no partial file, and says why', async () => {
		const dir = await folder();
		const backups = diskStorage(dir, 'backups-secret-for-tests-0123456789');
		// This org's archives only: the test database holds other orgs, whose backups go well
		const mine = (names: string[]) => names.filter((n) => n.includes(w.orgId));
		const listing = async () =>
			mine(await readdir(dir, { recursive: true })).filter((n) => n.includes('.afbbak'));
		// The file is read a second time for the frames: it has changed since the check, and in the other run it has gone
		for (const [day, mode] of [
			['2026-11-01', 'changed'],
			['2026-11-02', 'gone']
		] as const) {
			let reads = 0;
			const unsteady: Storage = {
				...files,
				async get(key) {
					const bytes = await files.get(key);
					if (key !== attachmentKey || !bytes || ++reads > 1) return bytes;
					return mode === 'gone' ? null : new Uint8Array([...bytes].reverse());
				}
			};
			const result = await runBackup(
				{ handle: src, admin: admin(), storage: unsteady, backups, key: KEY },
				{ now: new Date(`${day}T02:00:00Z`) }
			);
			expect(result.find((r) => r.orgId === w.orgId)).toMatchObject({
				state: 'failed',
				error: expect.stringMatching(
					mode === 'gone' ? /disappeared while the backup/ : /changed while the backup/
				)
			});
			expect(await listing()).toEqual([]);
		}
		const failed = (await rowsOf(w.orgId)).filter((r) => r.state === 'failed');
		expect(failed.length).toBeGreaterThanOrEqual(2);
		// A run that goes well afterwards writes one archive, renamed into place, with no partial file beside it
		const good = await runBackup(
			{ handle: src, admin: admin(), storage: files, backups, key: KEY },
			{ now: new Date('2026-11-03T02:00:00Z') }
		);
		expect(good.find((r) => r.orgId === w.orgId)?.state).toBe('done');
		const names = await readdir(dir, { recursive: true });
		expect(mine(names).filter((n) => n.endsWith('.afbbak'))).toHaveLength(1);
		expect(names.some((n) => n.endsWith('.partial'))).toBe(false);
		// Runs killed long ago still say running: the next run marks them failed
		await src.admin.exec(
			`insert into backup_run (org_id, state, created_at) values ('${w.orgId}', 'running', '2026-10-01T00:00:00Z')`
		);
		await runBackup(
			{ handle: src, admin: admin(), storage: files, backups, key: KEY },
			{ now: new Date('2026-11-04T02:00:00Z') }
		);
		const stale = (await rowsOf(w.orgId)).find((r) =>
			r.createdAt.toISOString().startsWith('2026-10-01')
		);
		expect(stale).toMatchObject({ state: 'failed' });
		expect(stale?.error).toMatch(/interrupted/);
	}, 240_000);

	it('a failed streamed put leaves nothing at its key, and the start-up sweep removes only old partial files and staging folders', async () => {
		const dir = await folder();
		const store = diskStorage(dir, 'backups-secret-for-tests-0123456789');
		async function* broken(): AsyncGenerator<Uint8Array> {
			yield new Uint8Array([1, 2, 3]);
			throw new Error('the source failed');
		}
		await expect(store.putStream('a/b.afbbak', broken(), 'x')).rejects.toThrow(/source failed/);
		expect(await store.get('a/b.afbbak')).toBeNull();
		expect((await readdir(dir, { recursive: true })).some((n) => n.endsWith('.partial'))).toBe(
			false
		);
		// A good put is renamed into place and reports its size
		async function* good(): AsyncGenerator<Uint8Array> {
			yield new Uint8Array([1, 2]);
			yield new Uint8Array([3]);
		}
		expect(await store.putStream('a/c.afbbak', good(), 'x')).toBe(3);
		expect(await store.size('a/c.afbbak')).toBe(3);
		// Old leftovers of a killed run go, a recent one and a real archive stay
		await mkdir(join(dir, 'a'), { recursive: true });
		await mkdir(join(dir, 'afb-put-old'), { recursive: true });
		await writeFile(join(dir, 'a', 'old.afbbak.partial'), 'x');
		await writeFile(join(dir, 'a', 'new.afbbak.partial'), 'x');
		const old = new Date(Date.now() - 3 * 3_600_000);
		await utimes(join(dir, 'a', 'old.afbbak.partial'), old, old);
		await utimes(join(dir, 'afb-put-old'), old, old);
		expect(await sweepPartialFiles(dir)).toBe(2);
		const left = await readdir(dir, { recursive: true });
		expect(left.some((n) => n.endsWith('old.afbbak.partial'))).toBe(false);
		expect(left).not.toContain('afb-put-old');
		expect(left.some((n) => n.endsWith('new.afbbak.partial'))).toBe(true);
		expect(left.some((n) => n.endsWith('c.afbbak'))).toBe(true);
	});

	it('a backup of 200 MB of files stays far below that in memory, and the buffered way does not', async () => {
		const backups = diskStorage(await folder(), 'backups-secret-for-tests-0123456789');
		// One note holds the files, put in storage and listed with their checksums
		const [note] = await src.admin.query<{ id: string }>(
			`insert into note (org_id, project_id, number, title) values ('${w.orgId}', '${w.projectId}', 7, 'Big files') returning id`
		);
		for (let i = 0; i < BIG_FILES; i++) {
			const bytes = randomBytes(BIG_SIZE);
			const key = `notes/memory/${i}.png`;
			await files.put(key, bytes, 'image/png');
			await src.admin.exec(
				`insert into note_file (org_id, project_id, note_id, storage_key, mime, size, checksum) values ('${w.orgId}', '${w.projectId}', '${note.id}', '${key}', 'image/png', ${BIG_SIZE}, '${createHash('sha256').update(bytes).digest('hex')}')`
			);
		}
		const streamed = await peakExternal(() =>
			runBackup(
				{ handle: src, admin: admin(), storage: files, backups, key: KEY },
				{ now: new Date('2026-11-10T02:00:00Z') }
			)
		);
		expect(streamed.result.find((r) => r.orgId === w.orgId)?.state).toBe('done');
		// The buffered way holds every file, and copies of the whole archive, at once
		const buffered = await peakExternal(async () =>
			writeArchive((await exportOrg(admin(), files, w.orgId)).frames, KEY)
		);
		expect(buffered.growth).toBeGreaterThan(MEMORY_CAP);
		expect(streamed.growth).toBeLessThan(MEMORY_CAP);
	}, 600_000);
});
