// PHASE 8: THE ENCRYPTED ARCHIVE, THE NIGHTLY BACKUP WITH RETENTION, ALERTS AND HEALTH, AND THE RESTORE (FULL, OVER AN ORG, AND
// THROUGH A SCRATCH DATABASE). THIS IS THE CI RESTORE TEST OF L12: IT BACKS UP A REAL ORG, RESTORES IT INTO A FRESH DATABASE
// AND COMPARES EVERY ROW, AND IT CHECKS THE AGE OF THE NEWEST BACKUP.

// IMPORTED DEP-MODULES
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { adminFromExecutor, sameDatabase } from '../../src/lib/server/backup/admin';
import {
	BackupError,
	readArchive,
	readArchiveStream,
	writeArchive,
	writeArchiveStream,
	type Frame
} from '../../src/lib/server/backup/archive';
import { exportOrg, tableOrder } from '../../src/lib/server/backup/dump';
import {
	inspectArchive,
	inspectArchiveStream,
	loadOrg,
	restoreAll,
	restoreOrg
} from '../../src/lib/server/backup/restore';
import {
	DEFAULT_RETENTION,
	LATE_AFTER_HOURS,
	MAX_BACKUPS,
	archiveKey,
	archiveTime,
	backupHealth,
	checkLateBackups,
	runBackup,
	selectRetained,
	sweepOrphanFiles
} from '../../src/lib/server/backup/run';
import { backupRun, event } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import type { Mail, Mailer } from '../../src/lib/server/email/mailer';
import { addAttachment } from '../../src/lib/server/ops/attachments';
import { createTask, upsertDecision, upsertSection } from '../../src/lib/server/ops/docs';
import { createItem } from '../../src/lib/server/ops/items';
import { recordSteps } from '../../src/lib/server/ops/steps';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const KEY = 'a-backup-key-of-more-than-32-characters!!';
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5]);

// -- FUNCTIONS -- //

describe('the encrypted archive', () => {
	const frames: Frame[] = [
		{ type: 'meta', json: { hello: 'world' } },
		{ type: 'table', json: { table: 't', rows: [{ a: 1 }, { a: 2 }] } },
		{ type: 'file', json: { key: 'k.png', mime: 'image/png' }, bytes: PNG }
	];

	it('round trips frames, files included, and nothing readable is left in the bytes', () => {
		const archive = writeArchive(frames, KEY);
		expect(archive.includes(Buffer.from('hello'))).toBe(false);
		expect(archive.includes(Buffer.from('k.png'))).toBe(false);
		const back = readArchive(archive, KEY);
		expect(back).toHaveLength(3);
		expect(back[0]).toEqual(frames[0]);
		expect(back[1]).toEqual(frames[1]);
		expect(back[2].type === 'file' && Array.from(back[2].bytes)).toEqual(Array.from(PNG));
		// Two archives of the same data differ, so nothing can be matched across them
		expect(writeArchive(frames, KEY).equals(archive)).toBe(false);
	});

	it('refuses a wrong key, a changed byte, a truncated file, a reordered block and something that is not a backup', () => {
		const archive = writeArchive(frames, KEY);
		expect(() => readArchive(archive, 'another-key-of-more-than-32-characters!!')).toThrow(
			BackupError
		);
		const flipped = Buffer.from(archive);
		flipped[flipped.length - 20] ^= 1;
		expect(() => readArchive(flipped, KEY)).toThrow(/decrypted/);
		expect(() => readArchive(archive.subarray(0, archive.length - 5), KEY)).toThrow(BackupError);
		expect(() =>
			readArchive(Buffer.from('not a backup at all, just some text bytes'), KEY)
		).toThrow(/not an Agent Flow Board backup/);
		expect(() => writeArchive(frames, 'short')).toThrow(/32 characters/);
		// Several blocks: dropping the last one, or swapping two, is caught
		const big: Frame[] = [
			{ type: 'file', json: { key: 'big' }, bytes: randomBytes(3 * 1024 * 1024 + 123) }
		];
		const multi = writeArchive(big, KEY);
		const blocks: Buffer[] = [];
		let at = 8 + 1 + 16;
		while (at < multi.length) {
			const len = multi.readUInt32BE(at);
			blocks.push(multi.subarray(at, at + 16 + len));
			at += 16 + len;
		}
		expect(blocks.length).toBeGreaterThan(2);
		const head = multi.subarray(0, 8 + 1 + 16);
		expect(() => readArchive(Buffer.concat([head, ...blocks.slice(0, -1)]), KEY)).toThrow(
			BackupError
		);
		expect(() =>
			readArchive(Buffer.concat([head, blocks[1], blocks[0], ...blocks.slice(2)]), KEY)
		).toThrow(BackupError);
		expect(readArchive(multi, KEY)[0].type).toBe('file');
	});
});

describe('the streamed archive', () => {
	const frames: Frame[] = [
		{ type: 'meta', json: { hello: 'world' } },
		{ type: 'table', json: { table: 't', rows: [{ a: 1 }, { a: 2 }] } },
		{ type: 'file', json: { key: 'k.png', mime: 'image/png' }, bytes: PNG }
	];
	const norm = (list: Frame[]) =>
		list.map((f) => (f.type === 'file' ? { ...f, bytes: Array.from(f.bytes) } : f));
	async function* asStream(list: Frame[]): AsyncGenerator<Frame> {
		for (const f of list) yield f;
	}
	const bytesOf = async (it: AsyncIterable<Uint8Array>) => {
		const parts: Buffer[] = [];
		for await (const c of it) parts.push(Buffer.from(c));
		return Buffer.concat(parts);
	};
	const framesOf = async (it: AsyncIterable<Frame>) => {
		const out: Frame[] = [];
		for await (const f of it) out.push(f);
		return out;
	};
	const written = (list: Frame[], block?: number) =>
		bytesOf(writeArchiveStream(asStream(list), KEY, block));
	const readStream = (archive: Uint8Array, key = KEY) =>
		framesOf(readArchiveStream(Readable.from([archive]), key));

	it('has the same format both ways: the buffered reader reads a streamed archive and the stream reader reads a buffered one', async () => {
		const streamed = await written(frames);
		expect(streamed.includes(Buffer.from('hello'))).toBe(false);
		expect(norm(readArchive(streamed, KEY))).toEqual(norm(frames));
		expect(norm(await readStream(writeArchive(frames, KEY)))).toEqual(norm(frames));
		expect(norm(await readStream(streamed))).toEqual(norm(frames));
		// An empty list of frames is still an archive
		expect(readArchive(await written([]), KEY)).toEqual([]);
		expect(await readStream(await written([]))).toEqual([]);
	});

	it('never writes an empty last block, also when the compressed bytes end exactly on a block boundary', async () => {
		let boundary = false;
		for (let n = 1; n <= 700; n++) {
			const payload = new Uint8Array(Array.from({ length: n }, (_, j) => (j * 7919 + n) % 251));
			const list: Frame[] = [{ type: 'file', json: { key: `f${n}` }, bytes: payload }];
			const archive = await written(list, 64);
			let at = 8 + 1 + 16;
			let plain = 0;
			while (at < archive.length) {
				const len = archive.readUInt32BE(at);
				expect(len).toBeGreaterThan(16);
				plain += len - 16;
				at += 16 + len;
			}
			if (plain % 64 === 0) boundary = true;
			expect(norm(readArchive(archive, KEY))).toEqual(norm(list));
			expect(norm(await readStream(archive))).toEqual(norm(list));
		}
		expect(boundary).toBe(true);
	});

	it('refuses what the buffered reader refuses: a wrong key, a changed byte, a cut file, a dropped or swapped block, extra bytes, a damaged length', async () => {
		const archive = await written(frames);
		await expect(readStream(archive, 'another-key-of-more-than-32-characters!!')).rejects.toThrow(
			BackupError
		);
		const flipped = Buffer.from(archive);
		flipped[flipped.length - 20] ^= 1;
		await expect(readStream(flipped)).rejects.toThrow(/decrypted/);
		await expect(readStream(archive.subarray(0, archive.length - 5))).rejects.toThrow(BackupError);
		await expect(
			readStream(Buffer.from('not a backup at all, just some text bytes'))
		).rejects.toThrow(/not an Agent Flow Board backup/);
		// Several blocks: dropping the last one, swapping two, or adding bytes at the end is caught
		const multi = await written(
			[{ type: 'file', json: { key: 'big' }, bytes: randomBytes(200_000) }],
			4096
		);
		const blocks: Buffer[] = [];
		let at = 8 + 1 + 16;
		while (at < multi.length) {
			const len = multi.readUInt32BE(at);
			blocks.push(multi.subarray(at, at + 16 + len));
			at += 16 + len;
		}
		expect(blocks.length).toBeGreaterThan(2);
		const head = multi.subarray(0, 8 + 1 + 16);
		await expect(readStream(Buffer.concat([head, ...blocks.slice(0, -1)]))).rejects.toThrow(
			BackupError
		);
		await expect(
			readStream(Buffer.concat([head, blocks[1], blocks[0], ...blocks.slice(2)]))
		).rejects.toThrow(BackupError);
		await expect(readStream(Buffer.concat([multi, randomBytes(40)]))).rejects.toThrow(BackupError);
		// A damaged length cannot make the reader ask for gigabytes
		const huge = Buffer.concat([head, Buffer.from([0x7f, 0xff, 0xff, 0xff]), randomBytes(64)]);
		await expect(readStream(huge)).rejects.toThrow(/damaged/);
		expect((await readStream(multi))[0].type).toBe('file');
	});

	it('is read completely, counts and checksums, by inspectArchiveStream before anything is restored', async () => {
		const sum = createHash('sha256').update(PNG).digest('hex');
		const meta = {
			format: 'afb-backup',
			version: 1,
			orgId: 'o',
			orgSlug: 'o',
			createdAt: 'now',
			migrations: [],
			tables: { t: { count: 2, columns: ['a'] } },
			files: 1,
			missingFiles: []
		};
		const good: Frame[] = [
			{ type: 'meta', json: meta },
			{ type: 'table', json: { table: 't', rows: [{ a: 1 }, { a: 2 }] } },
			{ type: 'file', json: { key: 'k', mime: 'image/png', checksum: sum }, bytes: PNG }
		];
		const inspect = async (list: Frame[]) =>
			inspectArchiveStream(Readable.from([await written(list)]), KEY);
		expect((await inspect(good)).meta.orgId).toBe('o');
		// Cut after its table frames: the header counts a file that is not there
		await expect(inspect(good.slice(0, 2))).rejects.toThrow(/incomplete: it has 0 of 1 files/);
		// A table cut short, and a file that does not match its checksum
		await expect(inspect([good[0], good[2]])).rejects.toThrow(/incomplete: t has 0 of 2 rows/);
		const damaged: Frame = {
			type: 'file',
			json: { key: 'k', mime: 'image/png', checksum: 'x'.repeat(64) },
			bytes: PNG
		};
		await expect(inspect([good[0], good[1], damaged])).rejects.toThrow(
			/does not match its checksum/
		);
		await expect(inspect([good[1]])).rejects.toThrow(/no header/);
	});

	it('tells whether two connection URLs name the same database', () => {
		expect(sameDatabase('postgres://a:b@db:5432/afb', 'postgres://c:d@db/afb?sslmode=x')).toBe(
			true
		);
		expect(sameDatabase('postgres://a:b@db:5432/afb', 'postgres://a:b@db:5432/afb_scratch')).toBe(
			false
		);
		expect(sameDatabase('postgres://a:b@db:5432/afb', 'postgres://a:b@other:5432/afb')).toBe(false);
		expect(sameDatabase('postgres://a:b@db:5432/afb', 'postgres://a:b@db:5433/afb')).toBe(false);
	});
});

describe('retention', () => {
	it('keeps the newest 7 good backups, whatever their age, and nothing else', () => {
		expect(MAX_BACKUPS).toBe(7);
		expect(DEFAULT_RETENTION).toEqual({ max: 7 });
		// Handed in oldest first on purpose: the order given never matters
		const runs = Array.from({ length: 200 }, (_, i) => ({
			id: `r${i}`,
			createdAt: new Date(Date.UTC(2026, 9, 15) - i * 86_400_000)
		})).reverse();
		const keep = selectRetained(runs, DEFAULT_RETENTION);
		expect(keep.size).toBe(7);
		expect(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6'].every((id) => keep.has(id))).toBe(true);
		expect(keep.has('r7')).toBe(false);
		expect(keep.has('r199')).toBe(false);
		// Fewer than 7 are all kept, none at all keeps none
		expect(selectRetained(runs.slice(0, 3)).size).toBe(3);
		expect(selectRetained([], DEFAULT_RETENTION).size).toBe(0);
		expect(selectRetained(runs, { max: 0 }).size).toBe(0);
	});

	it('reads the time an archive was started from its name, and nothing from a name that is not an archive', () => {
		const at = new Date('2026-11-15T02:31:09.425Z');
		expect(archiveTime(archiveKey('org-1', at))).toBe(at.getTime());
		expect(archiveTime('backups/org-1/readme.txt')).toBeNull();
		expect(archiveTime('backups/org-1/2026-11-15T02-31-09-425Z.afbbak.partial')).toBeNull();
	});
});

describe('backup and restore', () => {
	const make = makePostgres;
	let src: TestDb;
	let dst: TestDb;
	let w: World;
	let w2: World;
	const files = memoryStorage('storage-secret-for-tests-0123456789');
	const backups = memoryStorage('backups-secret-for-tests-0123456789');
	const mails: Mail[] = [];
	const mailer: Mailer = { kind: 'log', send: async (m) => void mails.push(m) };
	const admin = () => adminFromExecutor(src.admin);
	const ctx = (who: keyof World['people'] = 'member') => ({
		...w.ctx(who),
		services: { storage: files, baseUrl: 'http://x' }
	});
	let ref = '';
	const tablesOf = (frames: Frame[]) =>
		frames
			.filter((f) => f.type === 'table')
			.map((f) => f.json as { table: string; rows: unknown[] });

	beforeAll(async () => {
		src = await make();
		dst = await make();
		w = await makeWorld(src);
		w2 = await makeWorld(src);
		const made = await createItem(ctx(), {
			project: w.projectKey,
			title: 'Backed up item',
			...PLAN
		});
		ref = made.ref;
		await recordSteps(ctx(), { item: ref, marks: [{ key: '1.1', mark: 'done' }] });
		await upsertDecision(ctx(), {
			item: ref,
			kind: 'settled',
			title: 'Why',
			answer: 'Because',
			source: 'tests'
		});
		await upsertSection(ctx(), { item: ref, slug: 'spec', title: 'Spec', body: '# Spec' });
		await createTask(ctx(), { project: w.projectKey, title: 'A task to restore' });
		await addAttachment(
			ctx(),
			{
				item: ref,
				filename: 'shot.png',
				caption: 'Shot',
				kind: 'ui-shot',
				visibility: 'private',
				refs: []
			},
			PNG
		);
		await createItem(
			{ ...w2.ctx('member'), services: { storage: files, baseUrl: 'http://x' } },
			{ project: w2.projectKey, title: 'The other org item' }
		);
	}, 240_000);
	afterAll(async () => {
		await src?.stop();
		await dst?.stop();
	});

	it('exports one org only: its rows, its members, their sign in records and its files, with parents before children', async () => {
		const { frames, meta } = await exportOrg(admin(), files, w.orgId);
		expect(meta).toMatchObject({ orgId: w.orgId, files: 1, missingFiles: [] });
		const tables = tablesOf(frames);
		const order = tables.map((t) => t.table);
		expect(order.indexOf('org')).toBeLessThan(order.indexOf('item'));
		expect(order.indexOf('project')).toBeLessThan(order.indexOf('item'));
		expect(order.indexOf('item')).toBeLessThan(order.indexOf('step'));
		const everything = JSON.stringify(tables);
		expect(everything).toContain('Backed up item');
		expect(everything).toContain('A task to restore');
		expect(everything).not.toContain('The other org item');
		expect(everything).not.toContain(w2.orgId);
		// Members' user rows are there, other orgs' people are not
		const users = tables.find((t) => t.table === 'user')!.rows as { id: string }[];
		expect(users.map((u) => u.id).sort()).toEqual(Object.values(w.people).sort());
		// Counters and idempotency records are left out, generated columns are not written
		expect(order).not.toContain('rate_bucket');
		expect(order).not.toContain('request_log');
		expect(meta.tables.item.columns).not.toContain('search_vector');
		expect((await tableOrder(admin(), ['item', 'org', 'project'])).slice(0, 2)).toEqual([
			'org',
			'project'
		]);
		expect(meta.migrations.length).toBeGreaterThan(0);
	});

	it('carries the pictures of notes as files, and reports one that is gone from storage', async () => {
		const bytes = new Uint8Array([7, 7, 7]);
		const sum = createHash('sha256').update(bytes).digest('hex');
		await files.put('notes/backup/pic.png', bytes, 'image/png');
		await src.admin.exec(
			`with n as (insert into note (org_id, project_id, number, title) values ('${w.orgId}', '${w.projectId}', 1, 'With picture') returning id)
			 insert into note_file (org_id, project_id, note_id, storage_key, mime, size, checksum) select '${w.orgId}', '${w.projectId}', id, 'notes/backup/pic.png', 'image/png', 3, '${sum}' from n`
		);
		try {
			const { frames, meta } = await exportOrg(admin(), files, w.orgId);
			expect(meta).toMatchObject({ files: 2, missingFiles: [] });
			const keys = frames
				.filter((f) => f.type === 'file')
				.map((f) => (f.json as { key: string }).key);
			expect(keys).toContain('notes/backup/pic.png');
			await files.delete('notes/backup/pic.png');
			const gone = await exportOrg(admin(), files, w.orgId);
			expect(gone.meta.missingFiles).toEqual(['notes/backup/pic.png']);
		} finally {
			await src.admin.exec(
				`delete from note where org_id = '${w.orgId}' and title = 'With picture'`
			);
			await files.delete('notes/backup/pic.png');
		}
	});

	it('also carries a person who left but is still named by a row, so a restore into an empty database cannot fail on them', async () => {
		await src.admin.exec(
			`insert into "user" (id, name, email, email_verified) values ('left-the-org', 'Left', 'left@example.com', true)`
		);
		await src.admin.exec(
			`update item set assignee_id = 'left-the-org' where org_id = '${w.orgId}'`
		);
		const { frames } = await exportOrg(admin(), files, w.orgId);
		const users = tablesOf(frames).find((t) => t.table === 'user')!.rows as { id: string }[];
		expect(users.map((u) => u.id)).toContain('left-the-org');
	});

	it('restores into a fresh database and every row, file and person matches', async () => {
		const archive = writeArchive((await exportOrg(admin(), files, w.orgId)).frames, KEY);
		const restoredFiles = memoryStorage('storage-secret-for-tests-0123456789');
		const target = adminFromExecutor(dst.admin);
		const [done] = await restoreAll([archive], KEY, target, { storage: restoredFiles });
		expect(done).toMatchObject({ orgId: w.orgId, files: 1 });
		expect(done.tables.item).toBe(1);
		const before = await exportOrg(admin(), files, w.orgId);
		const after = await exportOrg(target, restoredFiles, w.orgId);
		expect(tablesOf(after.frames)).toEqual(tablesOf(before.frames));
		expect(after.meta.tables).toEqual(before.meta.tables);
		// The file came back byte for byte
		const fileFrame = before.frames.find((f) => f.type === 'file')!;
		const key = (fileFrame.json as { key: string }).key;
		expect(Array.from((await restoredFiles.get(key))!)).toEqual(Array.from(PNG));
		// The other org was not carried along
		expect((await target.query(`select 1 from "org" where "id" = $1`, [w2.orgId])).length).toBe(0);
		// The event counter continues after the restored rows, so new activity cannot collide
		const [maxBefore] = await target.query<{ m: string }>(
			`select max("id")::text as m from "event"`
		);
		const made = await createItem(
			{
				...w.ctx('member'),
				handle: dst,
				services: { storage: restoredFiles, baseUrl: 'http://x' }
			},
			{ project: w.projectKey, title: 'Created after the restore' }
		);
		expect(made.ref).not.toBe(ref);
		const [maxAfter] = await target.query<{ m: string }>(
			`select max("id")::text as m from "event"`
		);
		expect(Number(maxAfter.m)).toBeGreaterThan(Number(maxBefore.m));
		const events = await withTenant(dst, { orgId: w.orgId }, (tx) =>
			tx.select({ id: event.id }).from(event)
		);
		expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
	});

	it('refuses to restore over an org that exists unless told to replace it, and a replace puts back what was deleted', async () => {
		const archive = writeArchive((await exportOrg(admin(), files, w.orgId)).frames, KEY);
		const target = adminFromExecutor(dst.admin);
		await expect(restoreOrg(archive, KEY, target)).rejects.toThrow(/already exists/);
		// Damage the org in the target, then replace it from the backup
		await target.query(`delete from "task" where "org_id" = $1`, [w.orgId]);
		await target.query(`update "item" set "title" = 'Vandalised' where "org_id" = $1`, [w.orgId]);
		const restored = await restoreOrg(archive, KEY, target, { replace: true });
		expect(restored.tables.task).toBe(1);
		const titles = await target.query<{ title: string }>(
			`select "title" from "item" where "org_id" = $1 order by "title"`,
			[w.orgId]
		);
		expect(titles.map((t) => t.title)).toEqual(['Backed up item']);
	});

	it('restores through a scratch database first, and a bad archive, a wrong key or another database version stops before the live one is touched', async () => {
		const scratchDb = await make();
		try {
			const archive = writeArchive((await exportOrg(admin(), files, w.orgId)).frames, KEY);
			const live = await make();
			try {
				const liveAdmin = adminFromExecutor(live.admin);
				const scratch = adminFromExecutor(scratchDb.admin);
				const restored = await restoreOrg(archive, KEY, liveAdmin, { scratch });
				expect(restored.tables.item).toBe(1);
				expect((await scratch.query(`select 1 from "item"`)).length).toBe(1);
				// A wrong key never reaches either database
				await expect(
					restoreOrg(
						archive,
						'wrong-key-wrong-key-wrong-key-wrong-key',
						adminFromExecutor((await make()).admin)
					)
				).rejects.toThrow(BackupError);
				// A database of another version is refused with the versions named
				const other = await make();
				try {
					await other.admin.exec(
						`insert into "__afb_migrations" (tag, hash) values ('9999_future', 'x')`
					);
					await expect(restoreOrg(archive, KEY, adminFromExecutor(other.admin))).rejects.toThrow(
						/9999_future/
					);
					expect((await other.admin.query(`select 1 from "org"`)).length).toBe(0);
				} finally {
					await other.stop();
				}
				// An incomplete archive (a table cut out) is noticed by its own header
				const cut = (await exportOrg(admin(), files, w.orgId)).frames.filter(
					(f) => !(f.type === 'table' && (f.json as { table: string }).table === 'step')
				);
				expect(() => inspectArchive(writeArchive(cut, KEY), KEY)).toThrow(/incomplete: step/);
			} finally {
				await live.stop();
			}
		} finally {
			await scratchDb.stop();
		}
	});

	it('the nightly run writes one archive per org, records it, reads it back, and a second run the same night does nothing', async () => {
		const now = new Date('2026-10-15T02:00:00Z');
		const result = await runBackup(
			{ handle: src, admin: admin(), storage: files, backups, key: KEY, mailer },
			{ now }
		);
		const mine = result.find((r) => r.orgId === w.orgId)!;
		expect(mine.state).toBe('done');
		expect(mine.location).toBe(archiveKey(w.orgId, now));
		expect(result.find((r) => r.orgId === w2.orgId)?.state).toBe('done');
		const rows = await withTenant(src, { orgId: w.orgId }, (tx) => tx.select().from(backupRun));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ state: 'done', location: mine.location });
		expect(rows[0].size).toBeGreaterThan(100);
		// What was stored is a real backup of that org
		const inspected = inspectArchive((await backups.get(mine.location!))!, KEY);
		expect(inspected.meta.orgId).toBe(w.orgId);
		// The same night again: skipped
		const again = await runBackup(
			{ handle: src, admin: admin(), storage: files, backups, key: KEY },
			{ now: new Date('2026-10-15T03:00:00Z'), skipIfWithinHours: 20 }
		);
		expect(again.every((r) => r.state === 'skipped')).toBe(true);
		// Health: fresh now, late after the allowance
		const fresh = await backupHealth(src, w.orgId, new Date('2026-10-15T08:00:00Z'));
		expect(fresh).toMatchObject({ ok: true, late: false, lastFailed: false, message: null });
		expect(fresh.ageHours).toBeCloseTo(6, 0);
		const late = await backupHealth(
			src,
			w.orgId,
			new Date(now.getTime() + (LATE_AFTER_HOURS + 1) * 3_600_000)
		);
		expect(late).toMatchObject({ ok: false, late: true });
		expect(late.message).toMatch(/hours old/);
		// The age check CI makes: the newest backup is not older than the allowance
		expect(fresh.ageHours!).toBeLessThan(LATE_AFTER_HOURS);
	});

	it('retention removes old archives and their rows, and keeps only the newest ones', async () => {
		const policy = { max: 2 };
		for (const day of ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19']) {
			await runBackup(
				{ handle: src, admin: admin(), storage: files, backups, key: KEY },
				{ now: new Date(`${day}T02:00:00Z`), retention: policy }
			);
		}
		const rows = await withTenant(src, { orgId: w.orgId }, (tx) =>
			tx.select().from(backupRun).where(eq(backupRun.state, 'done'))
		);
		const days = rows.map((r) => r.createdAt.toISOString().slice(0, 10)).sort();
		expect(days).toContain('2026-10-19');
		expect(days).toContain('2026-10-18');
		expect(days).not.toContain('2026-10-16');
		for (const r of rows) expect(await backups.get(r.location!)).not.toBeNull();
		expect(await backups.get(archiveKey(w.orgId, new Date('2026-10-16T02:00:00Z')))).toBeNull();
	});

	it('the prune removes archive files that no record names, but never a young one, a record named one, another org or a stranger name', async () => {
		const now = new Date('2026-10-19T23:00:00Z');
		const store = (n: string, at: string, org = w.orgId) => ({
			key: n === 'odd' ? `backups/${org}/readme.txt` : archiveKey(org, new Date(at)),
			at
		});
		const old = store('old', '2026-10-18T20:00:00Z');
		const young = store('young', '2026-10-19T21:00:00Z');
		const odd = store('odd', '2026-10-18T20:00:00Z');
		const named = store('named', '2026-10-17T20:00:00Z');
		const foreign = store('foreign', '2026-10-18T20:00:00Z', w2.orgId);
		for (const f of [old, young, odd, named, foreign])
			await backups.put(f.key, new Uint8Array([1, 2, 3]), 'application/octet-stream');
		// A record that names the old file keeps it, however old it is
		await src.admin.exec(
			`insert into backup_run (org_id, state, size, location, created_at) values ('${w.orgId}', 'done', 3, '${named.key}', '${named.at}')`
		);
		const removed = await sweepOrphanFiles({ handle: src, backups }, w.orgId, now);
		expect(removed).toBeGreaterThanOrEqual(1);
		expect(await backups.get(old.key)).toBeNull();
		for (const f of [young, odd, named, foreign]) expect(await backups.get(f.key)).not.toBeNull();
		// Clean up what this test made, so no later test meets it
		await backups.delete(young.key);
		await backups.delete(odd.key);
		await backups.delete(foreign.key);
		await src.admin.exec(`delete from backup_run where location = '${named.key}'`);
		await backups.delete(named.key);
	});

	it('a file that cannot be removed keeps its record and is logged, so the next run tries again', async () => {
		const run = (at: string, store: typeof backups = backups) =>
			runBackup(
				{ handle: src, admin: admin(), storage: files, backups: store, key: KEY },
				{ now: new Date(at), retention: { max: 1 } }
			);
		const doneRows = () =>
			withTenant(src, { orgId: w.orgId }, (tx) =>
				tx.select().from(backupRun).where(eq(backupRun.state, 'done'))
			);
		const first = archiveKey(w.orgId, new Date('2026-10-19T05:00:00Z'));
		await run('2026-10-19T05:00:00Z');
		const flaky: typeof backups = {
			...backups,
			delete: async (key: string) => {
				if (key === first) throw new Error('the disk is busy');
				return backups.delete(key);
			}
		};
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		await run('2026-10-19T06:00:00Z', flaky);
		expect(log).toHaveBeenCalledWith(expect.stringContaining(first), expect.anything());
		log.mockRestore();
		// The file is still there, and so is its record: nothing points at a file that is gone
		expect((await doneRows()).some((r) => r.location === first)).toBe(true);
		expect(await backups.get(first)).not.toBeNull();
		// The next run, with the disk well again, takes both away
		await run('2026-10-19T07:00:00Z');
		const rows = await doneRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].location).toBe(archiveKey(w.orgId, new Date('2026-10-19T07:00:00Z')));
		expect(await backups.get(first)).toBeNull();
		expect(await backups.get(archiveKey(w.orgId, new Date('2026-10-19T06:00:00Z')))).toBeNull();
	});

	it('an org with automatic backups off is left out of the nightly run and never flagged late, but a run by hand still takes it', async () => {
		const ids = [w.orgId, w2.orgId];
		const only = <T extends { orgId: string }>(list: T[]) =>
			list.filter((r) => ids.includes(r.orgId));
		const set = (on: boolean) =>
			src.admin.exec(
				`update "org" set "settings" = coalesce("settings", '{}'::jsonb) || '{"autoBackups": ${on}}'::jsonb where "id" in ('${ids.join("', '")}')`
			);
		await set(false);
		const night = await runBackup(
			{ handle: src, admin: admin(), storage: files, backups, key: KEY },
			{ now: new Date('2026-10-19T08:00:00Z'), onlyAutoBackups: true }
		);
		expect(only(night)).toEqual([]);
		const byHand = await runBackup(
			{ handle: src, admin: admin(), storage: files, backups, key: KEY },
			{ now: new Date('2026-10-19T09:00:00Z') }
		);
		expect(only(byHand).map((r) => r.state)).toEqual(['done', 'done']);
		// Long past the allowance the org would be late, but a paused org is not flagged and nobody is mailed
		const later = new Date('2026-10-22T00:00:00Z');
		expect((await backupHealth(src, w.orgId, later)).late).toBe(true);
		mails.length = 0;
		const flagged = await checkLateBackups({ handle: src, admin: admin(), mailer }, later);
		expect(only(flagged)).toEqual([]);
		expect(mails.filter((m) => m.to.startsWith('owner-'))).toEqual([]);
		await set(true);
		// Switched back on, the nightly run takes both again
		const again = await runBackup(
			{ handle: src, admin: admin(), storage: files, backups, key: KEY },
			{ now: new Date('2026-10-19T10:00:00Z'), onlyAutoBackups: true }
		);
		expect(only(again).map((r) => r.state)).toEqual(['done', 'done']);
	});

	it('a failure is recorded, the owners are mailed, the other orgs still back up, and a late backup is flagged once a day', async () => {
		mails.length = 0;
		// A live attachment whose file is gone from storage is data loss, so that org fails and says which file
		await files.delete(
			(
				await withTenant(src, { orgId: w.orgId }, async (tx) => {
					const { attachment } = await import('../../src/lib/server/db/schema');
					return (await tx.select().from(attachment))[0];
				})
			).storageKey
		);
		const now = new Date('2026-10-20T02:00:00Z');
		const result = await runBackup(
			{ handle: src, admin: admin(), storage: files, backups, key: KEY, mailer },
			{ now }
		);
		expect(result.find((r) => r.orgId === w.orgId)).toMatchObject({
			state: 'failed',
			error: expect.stringMatching(/attachment file is missing/)
		});
		expect(result.find((r) => r.orgId === w2.orgId)?.state).toBe('done');
		const health = await backupHealth(src, w.orgId, new Date(now.getTime() + 1000));
		expect(health).toMatchObject({ ok: false, lastFailed: true });
		expect(health.message).toMatch(/last backup failed/);
		const alert = mails.find((m) => m.to.startsWith('owner-'));
		expect(alert?.subject).toMatch(/Backups of .* need attention/);
		expect(alert?.text).toMatch(/failed/);
		// Silence for a day, and then a late flag exactly once
		mails.length = 0;
		const later = new Date(now.getTime() + 40 * 3_600_000);
		const first = await checkLateBackups({ handle: src, admin: admin(), mailer }, later);
		expect(first.some((f) => f.orgId === w.orgId)).toBe(true);
		expect(mails.length).toBeGreaterThan(0);
		const second = await checkLateBackups(
			{ handle: src, admin: admin(), mailer },
			new Date(later.getTime() + 3_600_000)
		);
		expect(second.some((f) => f.orgId === w.orgId)).toBe(false);
		// Without storage given, files are not part of the backup and nothing is reported missing
		const noFiles = await exportOrg(admin(), null, w.orgId);
		expect(noFiles.meta).toMatchObject({ files: 0, missingFiles: [] });
		expect(loadOrg).toBeTypeOf('function');
	});

	it('a backup carries the mockup version files but leaves out the drawn shots and trees', async () => {
		const html = new TextEncoder().encode('<html>a mockup</html>');
		const sum = createHash('sha256').update(html).digest('hex');
		const key = (n: string) => `${w2.orgId}/mockups/${n}`;
		await files.put(key('v1.html'), html, 'text/html');
		await files.put(key('shot.png'), PNG, 'image/png');
		await files.put(key('tree.json'), new Uint8Array([123, 125]), 'application/json');
		const [m] = await src.admin.query<{ id: string }>(
			`insert into mockup (org_id, project_id, title) values ('${w2.orgId}', '${w2.projectId}', 'A mockup') returning id`
		);
		const derived = {
			schema: 1,
			shots: [
				{
					screen: 'a',
					state: 's',
					width: 390,
					storageKey: key('shot.png'),
					mime: 'image/png',
					size: PNG.length
				}
			],
			trees: [
				{ screen: 'a', state: 's', width: 390, storageKey: key('tree.json'), size: 2, elements: 0 }
			]
		};
		await src.admin.exec(
			`insert into mockup_version (org_id, project_id, mockup_id, number, storage_key, size, checksum, derived) values ('${w2.orgId}', '${w2.projectId}', '${m.id}', 1, '${key('v1.html')}', ${html.length}, '${sum}', '${JSON.stringify(derived)}'::jsonb)`
		);
		const { frames, meta } = await exportOrg(admin(), files, w2.orgId);
		const kept = frames
			.filter((f) => f.type === 'file')
			.map((f) => (f.json as { key: string }).key);
		expect(kept).toContain(key('v1.html'));
		expect(kept).not.toContain(key('shot.png'));
		expect(kept).not.toContain(key('tree.json'));
		// What is left out is not reported missing, and the file count matches what is in the archive
		expect(meta.missingFiles).toEqual([]);
		expect(meta.files).toBe(kept.length);
	});
});
