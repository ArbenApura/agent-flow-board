// SCREENS (AFB-20261124-0926): WHO MAY DO WHAT, FIRST AND LATEST, THE PICTURE CHECKS, PRIVACY OF A PLAN, ANNOTATIONS AND THE ORG PURGE

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { exportOrg } from '../../src/lib/server/backup/dump';
import { adminFromExecutor } from '../../src/lib/server/backup/admin';
import { dueOrgPurges, purgeOrg } from '../../src/lib/server/orgs/purge';
import { purgeTrash } from '../../src/lib/server/ops/history';
import { createItem, trashItem, updateItem } from '../../src/lib/server/ops/items';
import {
	MAX_ANNOTATIONS_PER_SCREEN,
	MAX_SCREEN_BYTES,
	MAX_SCREENS_PER_ITEM,
	addScreen,
	addScreenAnnotation,
	countScreens,
	listScreens,
	readScreenImage,
	removeScreen,
	removeScreenAnnotation,
	setScreenAnnotationResolved
} from '../../src/lib/server/ops/screens';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, PLAN, type World } from '../support/ops';

// -- CONSTANTS -- //

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
/** A small PNG-looking file, made different by its last bytes. */
const png = (n: number) => Uint8Array.from([...SIG, 0, 0, n % 256, Math.floor(n / 256)]);
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

	it('writers add and annotate, viewers and guests only look or see nothing', async () => {
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
		const note = {
			screen: made.screen.id,
			kind: 'pin' as const,
			x: 0.5,
			y: 0.25,
			body: 'Check the title'
		};
		await expect(addScreenAnnotation(as('viewer'), note)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		const added = await addScreenAnnotation(as('member'), note);
		expect(added.annotation).toMatchObject({ kind: 'pin', w: null, h: null, untrusted: true });
		// A viewer can read
		const read = await listScreens(as('viewer'), p.ref);
		expect(read.screens[0].annotations).toHaveLength(1);
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
		await expect(bad(png(1), { screenKey: 'Has Spaces' })).rejects.toThrow();
		await expect(bad(png(1), { width: 20 })).rejects.toThrow();
		await expect(bad(png(1), { mode: 'sepia' })).rejects.toThrow();
		expect((await listScreens(as('member'), p.ref)).screens).toHaveLength(0);
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
		await expect(
			addScreenAnnotation(as('admin'), {
				screen: made.screen.id,
				kind: 'pin',
				x: 0.1,
				y: 0.1,
				body: 'x'
			})
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		expect(await readScreenImage(db, storage, w.people.admin, made.screen.id)).toBeNull();
		expect((await listScreens(as('member'), p.ref)).screens).toHaveLength(1);
		// The picture itself reaches only a person who may see the plan, and never another org
		expect(await readScreenImage(db, storage, w.people.member, made.screen.id)).not.toBeNull();
		expect(await readScreenImage(db, storage, w.other.userId, made.screen.id)).toBeNull();
	});

	it('validates annotations: coordinates inside the picture, shapes with sizes, a text and a cap', async () => {
		const p = await plan('Annotation checks plan');
		const { screen: s } = await addScreen(as('member'), { item: p.ref, ...base() }, png(40));
		const add = (over: Record<string, unknown>) =>
			addScreenAnnotation(heavy('member', '00000000-0000-4000-8000-0000000000a2'), {
				screen: s.id,
				kind: 'pin',
				x: 0.2,
				y: 0.2,
				body: 'Look here',
				...over
			} as never);
		await expect(add({ x: 1.2 })).rejects.toThrow();
		await expect(add({ y: -0.1 })).rejects.toThrow();
		await expect(add({ w: 0.1, h: 0.1 })).rejects.toThrow();
		await expect(add({ kind: 'box' })).rejects.toThrow();
		await expect(add({ kind: 'box', w: 0.9, h: 0.1 })).rejects.toThrow();
		await expect(add({ kind: 'box', w: -0.1, h: 0.1 })).rejects.toThrow();
		await expect(add({ kind: 'arrow', x: 0.9, w: 0.5, h: 0 })).rejects.toThrow();
		await expect(add({ body: '' })).rejects.toThrow();
		await expect(add({ body: 'x'.repeat(1001) })).rejects.toThrow();
		await expect(add({ body: ' \u0007 ' })).rejects.toMatchObject({ code: 'INVALID' });
		const box = await add({ kind: 'box', x: 0.1, y: 0.1, w: 0.3, h: 0.2 });
		expect(box.annotation).toMatchObject({ kind: 'box', w: 0.3, h: 0.2 });
		const arrow = await add({ kind: 'arrow', x: 0.8, y: 0.8, w: -0.3, h: -0.2 });
		expect(arrow.annotation.kind).toBe('arrow');
		for (let i = 2; i < MAX_ANNOTATIONS_PER_SCREEN; i++) await add({ body: `Note ${i}` });
		await expect(add({})).rejects.toMatchObject({ code: 'CONFLICT' });
	}, 120_000);

	it('lets writers resolve and reopen a note, and only its author or an admin remove it', async () => {
		const p = await plan('Resolve plan');
		const { screen: s } = await addScreen(as('member'), { item: p.ref, ...base() }, png(50));
		const { annotation: n } = await addScreenAnnotation(as('member'), {
			screen: s.id,
			kind: 'pin',
			x: 0.4,
			y: 0.4,
			body: 'Check'
		});
		await expect(setScreenAnnotationResolved(as('viewer'), n.id, true)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		const done = await setScreenAnnotationResolved(as('admin'), n.id, true);
		expect(done.annotation.resolved).toBe(true);
		expect((await setScreenAnnotationResolved(as('admin'), n.id, false)).annotation.resolved).toBe(
			false
		);
		await expect(removeScreenAnnotation(as('viewer'), n.id)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await removeScreenAnnotation(as('admin'), n.id);
		expect((await listScreens(as('member'), p.ref)).screens[0].annotations).toHaveLength(0);
	});

	it('removes a screenshot with its notes and its file, and refuses someone who did not add it', async () => {
		const p = await plan('Remove plan');
		const { screen: s } = await addScreen(as('member'), { item: p.ref, ...base() }, png(60));
		await addScreenAnnotation(as('member'), {
			screen: s.id,
			kind: 'pin',
			x: 0.3,
			y: 0.3,
			body: 'Check'
		});
		const [row] = await db.admin.query<{ k: string }>(
			`select storage_key as k from screen where id = '${s.id}'`
		);
		expect(storage.files.has(row.k)).toBe(true);
		await expect(removeScreen(as('viewer'), s.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await removeScreen(as('admin'), s.id);
		expect(storage.files.has(row.k)).toBe(false);
		expect((await listScreens(as('member'), p.ref)).screens).toHaveLength(0);
		const notes = await db.admin.query<{ n: string }>(
			`select count(*)::text as n from screen_annotation where screen_id = '${s.id}'`
		);
		expect(notes[0].n).toBe('0');
	});

	it('promotes the latest picture when the first is removed, and clears the notes of a replaced latest', async () => {
		const p = await plan('Promote plan');
		const first = await addScreen(as('member'), { item: p.ref, ...base('promote') }, png(80));
		const second = await addScreen(as('member'), { item: p.ref, ...base('promote') }, png(81));
		await addScreenAnnotation(as('member'), {
			screen: second.screen.id,
			kind: 'pin',
			x: 0.5,
			y: 0.5,
			body: 'Old place'
		});
		// A later capture replaces the latest and the notes that pointed at the old picture go with it
		await addScreen(as('member'), { item: p.ref, ...base('promote') }, png(82));
		const after = await listScreens(as('member'), p.ref);
		expect(after.screens.find((s) => s.role === 'after')?.annotations).toHaveLength(0);
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
		await addScreenAnnotation(as('member'), {
			screen: s.id,
			kind: 'pin',
			x: 0.5,
			y: 0.5,
			body: 'Check'
		});
		const [row] = await db.admin.query<{ k: string }>(
			`select storage_key as k from screen where id = '${s.id}'`
		);
		expect(storage.files.has(row.k)).toBe(true);
		const { frames } = await exportOrg(adminFromExecutor(db.admin), storage, w.orgId);
		const tables = frames.flatMap((f) =>
			f.type === 'table' ? [f.json as { table: string; rows: { id?: string }[] }] : []
		);
		// The rows of both tables are in the dump
		expect(tables.find((t) => t.table === 'screen')?.rows.some((r) => r.id === s.id)).toBe(true);
		expect(tables.find((t) => t.table === 'screen_annotation')?.rows.length).toBeGreaterThan(0);
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
