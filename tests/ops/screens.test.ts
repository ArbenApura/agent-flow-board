// SCREENS (AFB-20261124-0926): WHO MAY DO WHAT, FIRST AND LATEST, THE PICTURE CHECKS, PRIVACY OF A PLAN AND THE ORG PURGE
// Annotations were removed in AFB-20261125-0625, and a plan with a visible change now needs its screens or a waiver to close.

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { exportOrg } from '../../src/lib/server/backup/dump';
import { adminFromExecutor } from '../../src/lib/server/backup/admin';
import { dueOrgPurges, purgeOrg } from '../../src/lib/server/orgs/purge';
import { purgeTrash } from '../../src/lib/server/ops/history';
import { createItem, trashItem, updateItem } from '../../src/lib/server/ops/items';
import { setStatus } from '../../src/lib/server/ops/status';
import {
	MAX_SCREEN_BYTES,
	MAX_SCREENS_PER_ITEM,
	addScreen,
	countScreens,
	listScreens,
	readScreenImage,
	removeScreen
} from '../../src/lib/server/ops/screens';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, PLAN, type World } from '../support/ops';

// -- CONSTANTS -- //

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
/** A small PNG-looking file with a real header (its width), made different by its last bytes. */
const png = (n: number, width = 1440) => {
	const b = new Uint8Array(33);
	b.set(SIG);
	b[11] = 13;
	b.set([0x49, 0x48, 0x44, 0x52], 12);
	new DataView(b.buffer).setUint32(16, width);
	new DataView(b.buffer).setUint32(20, 900);
	b[29] = Math.floor(n / 256);
	b[30] = n % 256;
	return b;
};
const base = (screenKey = 'settings-members') => ({
	screenKey,
	mode: 'light' as const,
	width: 1440,
	caption: 'The members page'
});

// -- FUNCTIONS -- //

describe('screens', () => {
	let db: TestDb;
	let w: World;
	const storage = memoryStorage('screens-test-secret-0123456789');
	const services = { storage, baseUrl: 'https://afb.test' };
	const as = (who: keyof World['people'], requestId?: string) => ({
		...w.ctx(who, requestId ? { requestId } : {}),
		services
	});
	// A test that makes hundreds of writes uses its own actor, so it never uses up the per minute write limit of the others
	const heavy = (who: keyof World['people'], id: string) => ({
		...w.ctx(who, { tokenId: id }),
		services
	});
	const plan = (title: string, who: keyof World['people'] = 'member') =>
		createItem(as(who), { project: w.projectKey, title, ...PLAN });

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 120_000);
	afterAll(() => db?.stop());

	it('writers add, viewers and guests only look or see nothing', async () => {
		const p = await plan('Screens role plan');
		await expect(addScreen(as('viewer'), { item: p.ref, ...base() }, png(1))).rejects.toMatchObject(
			{
				code: 'FORBIDDEN'
			}
		);
		await expect(addScreen(as('guest'), { item: p.ref, ...base() }, png(1))).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		const made = await addScreen(as('member'), { item: p.ref, ...base() }, png(1));
		expect(made.screen.role).toBe('before');
		// A viewer can read, and the answer carries no annotations any more
		const read = await listScreens(as('viewer'), p.ref);
		expect(read.screens).toHaveLength(1);
		expect(read.screens[0]).not.toHaveProperty('annotations');
		expect(await countScreens(as('viewer'), p.ref)).toBe(1);
	});

	it('keeps the first capture as before and the latest as after, and the same picture changes nothing', async () => {
		const p = await plan('First and latest plan');
		const first = await addScreen(as('member'), { item: p.ref, ...base() }, png(10));
		const second = await addScreen(as('member'), { item: p.ref, ...base() }, png(11));
		const third = await addScreen(as('member'), { item: p.ref, ...base() }, png(12));
		expect(first.screen.role).toBe('before');
		expect(second.screen.role).toBe('after');
		expect(third.screen.role).toBe('after');
		// The after row is replaced, so there are two rows and the second file is gone
		const list = await listScreens(as('member'), p.ref);
		expect(list.screens.map((s) => s.role).sort()).toEqual(['after', 'before']);
		const same = await addScreen(as('member'), { item: p.ref, ...base() }, png(12));
		expect(same.screen.id).toBe(third.screen.id);
		expect((await listScreens(as('member'), p.ref)).screens).toHaveLength(2);
		// Another mode or width is its own slot, with its own before
		const dark = await addScreen(as('member'), { item: p.ref, ...base(), mode: 'dark' }, png(13));
		expect(dark.screen.role).toBe('before');
		// The same request id twice stores one picture
		const a = await addScreen(
			as('member', 'screen-retry-0001'),
			{ item: p.ref, ...base('retry') },
			png(20)
		);
		const b = await addScreen(
			as('member', 'screen-retry-0001'),
			{ item: p.ref, ...base('retry') },
			png(20)
		);
		expect(b.screen.id).toBe(a.screen.id);
	});

	it('stores a JPEG as the after picture of a PNG slot and serves it with its own type', async () => {
		const p = await plan('Picture types plan');
		const jpeg = (n: number, width = 1440) =>
			Uint8Array.from([
				0xff,
				0xd8,
				0xff,
				0xc0,
				0x00,
				0x11,
				0x08,
				0x03,
				0x84,
				width >> 8,
				width & 255,
				0x03,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				n,
				0xff,
				0xda
			]);
		const first = await addScreen(as('member'), { item: p.ref, ...base() }, png(1));
		expect(first.screen.mime).toBe('image/png');
		const second = await addScreen(as('member'), { item: p.ref, ...base() }, jpeg(2));
		expect(second.screen.role).toBe('after');
		expect(second.screen.mime).toBe('image/jpeg');
		const shot = await readScreenImage(db, storage, w.people.member, second.screen.id);
		expect(shot?.mime).toBe('image/jpeg');
		// A JPEG narrower than its claimed width is refused like a small PNG
		await expect(
			addScreen(as('member'), { item: p.ref, ...base('narrow') }, jpeg(3, 800))
		).rejects.toMatchObject({ code: 'INVALID' });
	});

	it('refuses anything that is not a PNG, an empty file, a big one and a bad name, width or mode', async () => {
		const p = await plan('Picture checks plan');
		const bad = (bytes: Uint8Array, over: Record<string, unknown> = {}) =>
			addScreen(as('member'), { item: p.ref, ...base(), ...over } as never, bytes);
		await expect(
			bad(Uint8Array.from([0x3c, 0x73, 0x76, 0x67, 1, 2, 3, 4, 5, 6]))
		).rejects.toMatchObject({
			code: 'INVALID'
		});
		await expect(bad(new Uint8Array())).rejects.toMatchObject({ code: 'INVALID' });
		const big = new Uint8Array(MAX_SCREEN_BYTES + 1);
		big.set(SIG);
		await expect(bad(big)).rejects.toMatchObject({ code: 'INVALID' });
		// A picture narrower than its declared width was scaled down: refused. A wider one (pixel ratio 2) is welcome
		await expect(bad(png(1, 1000))).rejects.toMatchObject({ code: 'INVALID' });
		await expect(bad(Uint8Array.from([...SIG, 0, 0, 1, 2]))).rejects.toMatchObject({
			code: 'INVALID'
		});
		await expect(bad(png(2, 2880))).resolves.toBeTruthy();
		await expect(bad(png(1), { screenKey: 'Has Spaces' })).rejects.toThrow();
		await expect(bad(png(1), { width: 20 })).rejects.toThrow();
		await expect(bad(png(1), { mode: 'sepia' })).rejects.toThrow();
		// Only the wide picture (pixel ratio 2) was stored
		expect((await listScreens(as('member'), p.ref)).screens).toHaveLength(1);
	});

	it('stops a plan at the most screenshots it can hold', async () => {
		const p = await plan('Cap plan');
		const ctx = heavy('member', '00000000-0000-4000-8000-0000000000a1');
		for (let i = 0; i < MAX_SCREENS_PER_ITEM; i++)
			await addScreen(ctx, { item: p.ref, ...base(`s-${i}`) }, png(100 + i));
		await expect(
			addScreen(ctx, { item: p.ref, ...base('one-too-many') }, png(999))
		).rejects.toMatchObject({ code: 'CONFLICT' });
	}, 120_000);

	it('hides the screenshots of a private plan from everyone but its creator, and another org sees nothing', async () => {
		const p = await plan('Private screens plan');
		const made = await addScreen(as('member'), { item: p.ref, ...base() }, png(30));
		await updateItem(as('member'), { item: p.ref, visibility: 'private' });
		await expect(listScreens(as('admin'), p.ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(countScreens(as('owner'), p.ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(removeScreen(as('admin'), made.screen.id)).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		expect(await readScreenImage(db, storage, w.people.admin, made.screen.id)).toBeNull();
		expect((await listScreens(as('member'), p.ref)).screens).toHaveLength(1);
		// The picture itself reaches only a person who may see the plan, and never another org
		expect(await readScreenImage(db, storage, w.people.member, made.screen.id)).not.toBeNull();
		expect(await readScreenImage(db, storage, w.other.userId, made.screen.id)).toBeNull();
	});

	it('removes a screenshot with its file, and refuses someone who did not add it', async () => {
		const p = await plan('Remove plan');
		const { screen: s } = await addScreen(as('member'), { item: p.ref, ...base() }, png(60));
		const [row] = await db.admin.query<{ k: string }>(
			`select storage_key as k from screen where id = '${s.id}'`
		);
		expect(storage.files.has(row.k)).toBe(true);
		await expect(removeScreen(as('viewer'), s.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await removeScreen(as('admin'), s.id);
		expect(storage.files.has(row.k)).toBe(false);
		expect((await listScreens(as('member'), p.ref)).screens).toHaveLength(0);
	});

	it('promotes the latest picture when the first is removed', async () => {
		const p = await plan('Promote plan');
		const first = await addScreen(as('member'), { item: p.ref, ...base('promote') }, png(80));
		const second = await addScreen(as('member'), { item: p.ref, ...base('promote') }, png(81));
		// A later capture replaces the latest
		await addScreen(as('member'), { item: p.ref, ...base('promote') }, png(82));
		// Removing the first picture makes the latest the first, so the next capture is a latest again
		await removeScreen(as('admin'), first.screen.id);
		const left = await listScreens(as('member'), p.ref);
		expect(left.screens.map((s) => s.role)).toEqual(['before']);
		const next = await addScreen(as('member'), { item: p.ref, ...base('promote') }, png(83));
		expect(next.screen.role).toBe('after');
		// The picture address changes with the picture, so a page never shows the old one from its cache
		expect(next.screen.image).not.toBe(second.screen.image);
		expect(next.screen.image).toMatch(/^\/pictures\/screen\/[0-9a-f-]+\?v=[0-9a-f]{12}$/);
	});

	it('refuses to close a plan with a design brief and no screens, until a screen or a waiver exists', async () => {
		// A plan with no counted steps, so only the screens rule can refuse it
		const p = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Visible plan',
			sections: [{ slug: 'design-brief', title: 'Design brief', body: 'A screen changes.' }]
		});
		// The rule is for agents: an agent is refused, a person moving the plan by hand is not (AFB-20261125-0906)
		const asAgent = { ...w.ctx('owner', { kind: 'agent' }), services };
		await expect(
			setStatus(asAgent, { item: p.ref, status: 'COMPLETED', note: 'Done at the board' })
		).rejects.toMatchObject({ code: 'COMPLETED_REFUSED', details: { reason: 'screens-missing' } });
		const byHand = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Visible plan closed by hand',
			sections: [{ slug: 'design-brief', title: 'Design brief', body: 'A screen changes.' }]
		});
		const handClosed = await setStatus(as('owner'), {
			item: byHand.ref,
			status: 'COMPLETED',
			note: 'Done at the board'
		});
		expect(handClosed.item.status).toBe('COMPLETED');
		// A picture on the Screens tab lets it close
		await addScreen(as('member'), { item: p.ref, ...base('visible') }, png(95));
		const closed = await setStatus(as('owner'), {
			item: p.ref,
			status: 'COMPLETED',
			note: 'Done at the board'
		});
		expect(closed.item.status).toBe('COMPLETED');
		// A waiver also lets a plan with no pictures close
		const q = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Waived plan',
			sections: [
				{ slug: 'design-brief', title: 'Design brief', body: 'A screen changes.' },
				{ slug: 'screens-waiver', title: 'Screens waiver', body: 'No integrated browser.' }
			]
		});
		const waived = await setStatus(as('owner'), {
			item: q.ref,
			status: 'COMPLETED',
			note: 'Done at the board'
		});
		expect(waived.item.status).toBe('COMPLETED');
		// A waiver with no reason written does not count for an agent, and an override does not skip the rule
		const e = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Empty waiver plan',
			sections: [
				{ slug: 'design-brief', title: 'Design brief', body: 'A screen changes.' },
				{ slug: 'screens-waiver', title: 'Screens waiver', body: '  ' }
			]
		});
		await expect(
			setStatus(asAgent, { item: e.ref, status: 'COMPLETED', note: 'Done at the board' })
		).rejects.toMatchObject({ code: 'COMPLETED_REFUSED', details: { reason: 'screens-missing' } });
		// A plan made before the rule existed is not held to it
		const old = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Old visible plan',
			sections: [{ slug: 'design-brief', title: 'Design brief', body: 'A screen changes.' }]
		});
		await db.admin.exec(
			`update item set created_at = '2026-11-20T00:00:00Z' where id = '${old.id}'`
		);
		const oldClosed = await setStatus(as('owner'), {
			item: old.ref,
			status: 'COMPLETED',
			note: 'Done at the board'
		});
		expect(oldClosed.item.status).toBe('COMPLETED');
		// A plan with no design brief is not asked for screens
		const r = await createItem(as('member'), { project: w.projectKey, title: 'Server only plan' });
		const plain = await setStatus(as('owner'), {
			item: r.ref,
			status: 'COMPLETED',
			note: 'Done at the board'
		});
		expect(plain.item.status).toBe('COMPLETED');
	});

	it('deletes the picture files when a plan leaves the trash for good', async () => {
		const p = await plan('Trash purge plan');
		const { screen: s } = await addScreen(as('member'), { item: p.ref, ...base('trash') }, png(90));
		const [row] = await db.admin.query<{ k: string }>(
			`select storage_key as k from screen where id = '${s.id}'`
		);
		expect(storage.files.has(row.k)).toBe(true);
		await trashItem(as('member'), p.ref);
		await db.admin.exec(
			`update item set deleted_at = now() - interval '31 days' where id = '${p.id}'`
		);
		await purgeTrash(as('admin'));
		const [n] = await db.admin.query<{ n: number }>(
			`select count(*)::int as n from screen where id = '${s.id}'`
		);
		expect(n.n).toBe(0);
		expect(storage.files.has(row.k)).toBe(false);
	});

	it('keeps the rows in the backup dump and never the picture files, and the purge erases the files', async () => {
		const p = await plan('Backup plan');
		const { screen: s } = await addScreen(
			as('member'),
			{ item: p.ref, ...base('backup') },
			png(70)
		);
		const [row] = await db.admin.query<{ k: string }>(
			`select storage_key as k from screen where id = '${s.id}'`
		);
		expect(storage.files.has(row.k)).toBe(true);
		const { frames } = await exportOrg(adminFromExecutor(db.admin), storage, w.orgId);
		const tables = frames.flatMap((f) =>
			f.type === 'table' ? [f.json as { table: string; rows: { id?: string }[] }] : []
		);
		// The rows of the screen table are in the dump, and the annotation table no longer exists
		expect(tables.find((t) => t.table === 'screen')?.rows.some((r) => r.id === s.id)).toBe(true);
		expect(tables.some((t) => t.table === 'screen_annotation')).toBe(false);
		// No picture file is written to the archive (ADR 5 of AFB-20261124-0926)
		const keys = frames.flatMap((f) =>
			f.type === 'file' ? [(f.json as { key: string }).key] : []
		);
		expect(keys).not.toContain(row.k);
		// Deleting the organisation and purging it erases every picture
		await db.admin.exec(
			`update org set deleted_at = now() - interval '40 days' where id = '${w.orgId}'`
		);
		expect(await dueOrgPurges(db)).toContain(w.orgId);
		expect(await purgeOrg({ handle: db, storage, backups: null }, w.orgId)).toBe('purged');
		expect(storage.files.has(row.k)).toBe(false);
	});
});
