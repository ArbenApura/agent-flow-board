// MOCKUPS (AFB-20261107-0346): WHO MAY DO WHAT, VERSIONS UNDER RACES, RETRIES, THE SIZE CAP, PRIVACY AND THE PUBLIC LINK

// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { adminFromExecutor } from '../../src/lib/server/backup/admin';
import { exportOrg } from '../../src/lib/server/backup/dump';
import { loadOrg } from '../../src/lib/server/backup/restore';
import { dueOrgPurges, purgeOrg } from '../../src/lib/server/orgs/purge';
import { mockup } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import { itemMockups } from '../../src/lib/server/web/itemMockups';
import { listEvents, listTrash, purgeTrash, undoChange } from '../../src/lib/server/ops/history';
import { createItem, restoreItem, trashItem, updateItem } from '../../src/lib/server/ops/items';
import {
	getMockup,
	listMockups,
	publishMockup,
	readMockupHtml,
	restoreMockupFromTrash,
	restoreMockupVersion,
	setMockupPublicLink,
	trashMockup,
	linkMockup,
	MAX_MOCKUP_BYTES
} from '../../src/lib/server/ops/mockups';
import {
	addMockupPin,
	listMockupPins,
	removeMockupPin,
	setMockupPinResolved
} from '../../src/lib/server/ops/mockupPins';
import { readMockupKit, setMockupKit } from '../../src/lib/server/ops/mockupSettings';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, PLAN, type World } from '../support/ops';

// -- CONSTANTS -- //

const BASE = 'https://afb.test';
const html = (n: number) => new TextEncoder().encode(`<html><body>version ${n}</body></html>`);
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);

// -- FUNCTIONS -- //

describe('mockups', () => {
	let db: TestDb;
	let w: World;
	const storage = memoryStorage('mockup-test-secret-0123456789');
	const services = { storage, baseUrl: BASE };
	const as = (who: keyof World['people'], requestId?: string) => ({
		...w.ctx(who, requestId ? { requestId } : {}),
		services
	});
	const plan = (title: string, who: keyof World['people'] = 'member') =>
		createItem(as(who), { project: w.projectKey, title, ...PLAN });
	const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');
	const rowByToken = (hash: string) =>
		withTenant(db, { mockupTokenHash: hash }, (tx) => tx.select().from(mockup));

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 120_000);
	afterAll(() => db?.stop());

	it('writers publish, viewers and guests only look, and managers own the project settings and the public link', async () => {
		const it1 = await plan('Role matrix plan');
		await expect(publishMockup(as('viewer'), { item: it1.ref }, html(1))).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		// A guest sees only the projects it was added to, so here the plan does not exist for it
		await expect(publishMockup(as('guest'), { item: it1.ref }, html(1))).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		const made = await publishMockup(as('member'), { item: it1.ref }, html(1));
		expect(made.version.number).toBe(1);
		// Everyone who can see the project can read it
		for (const who of ['viewer', 'admin'] as const)
			expect((await getMockup(as(who), made.mockup.id)).mockup.id).toBe(made.mockup.id);
		// Reads never carry a storage key or the address hash
		const read = await getMockup(as('viewer'), made.mockup.id);
		expect(JSON.stringify(read)).not.toContain('storage');
		expect(JSON.stringify(read)).not.toContain('publicTokenHash');
		expect(read.canWrite).toBe(false);
		await expect(setMockupPublicLink(as('member'), made.mockup.id, true)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		// The kit is saved by a manager and read as untrusted text
		await expect(
			setMockupKit(as('member'), { project: w.projectKey, builtFromCommit: 'abc' }, html(9))
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await setMockupKit(
			as('admin'),
			{ project: w.projectKey, builtFromCommit: 'abc1234', summary: 'Kit one' },
			html(9)
		);
		const kit = await readMockupKit(as('member'), w.projectKey);
		expect(kit).toMatchObject({
			untrusted: true,
			number: 1,
			builtFromCommit: 'abc1234',
			stale: false
		});
		await setMockupKit(as('admin'), { project: w.projectKey, stale: true });
		expect((await readMockupKit(as('member'), w.projectKey))?.stale).toBe(true);
		// A project of another organisation is the same NOT_FOUND as one that does not exist
		await expect(readMockupKit(as('owner'), 'NOPE-KEY')).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
	});

	it('two publishes at once never share a version number, and two first publishes for one plan make one mockup', async () => {
		const first = await plan('Parallel plan');
		const firsts = await Promise.allSettled([
			publishMockup(as('member'), { item: first.ref }, html(1)),
			publishMockup(as('member'), { item: first.ref }, html(2)),
			publishMockup(as('admin'), { item: first.ref }, html(3))
		]);
		const ok = firsts.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
		expect(firsts.every((r) => r.status === 'fulfilled')).toBe(true);
		expect(new Set(ok.map((r) => r.mockup.id)).size).toBe(1);
		expect(ok.map((r) => r.version.number).sort()).toEqual([1, 2, 3]);
		const id = ok[0].mockup.id;
		const more = await Promise.allSettled(
			[4, 5, 6, 7].map((n) => publishMockup(as('member'), { mockup: id }, html(n)))
		);
		expect(more.every((r) => r.status === 'fulfilled')).toBe(true);
		const detail = await getMockup(as('member'), id);
		expect(detail.versions.map((v) => v.number).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(detail.mockup.currentVersion).toBe(7);
		// A second mockup on the plan only when asked for
		const other = await publishMockup(as('member'), { item: first.ref, another: true }, html(1));
		expect(other.mockup.id).not.toBe(id);
		expect(
			(await listMockups(as('member'), { project: w.projectKey, item: first.ref })).mockups
		).toHaveLength(2);
	});

	it('a retry with the same request id writes once, and a restore keeps both stored files', async () => {
		const p = await plan('Retry plan');
		const a = await publishMockup(as('member', 'publish-retry-0001'), { item: p.ref }, html(1));
		const b = await publishMockup(as('member', 'publish-retry-0001'), { item: p.ref }, html(1));
		expect(b.version.id).toBe(a.version.id);
		const before = storage.files.size;
		await publishMockup(as('member'), { mockup: a.mockup.id, keepNotes: 'Keep the nav.' }, html(2));
		const restored = await restoreMockupVersion(as('member'), a.mockup.id, 1);
		expect(restored.version).toMatchObject({ number: 3, restoredFrom: 1 });
		expect(restored.mockup.currentVersion).toBe(3);
		// Version 1, version 2 and the restored copy each own a file
		expect(storage.files.size).toBe(before + 2);
		const old = await readMockupHtml(as('member'), a.mockup.id, { version: 1 });
		const copy = await readMockupHtml(as('member'), a.mockup.id, { version: 3 });
		expect(old.html).toBe(copy.html);
		expect(copy.untrusted).toBe(true);
		const part = await readMockupHtml(as('member'), a.mockup.id, { offset: 6, limit: 4 });
		expect(part).toMatchObject({ html: '<bod', more: true });
		await expect(restoreMockupVersion(as('member'), a.mockup.id, 9)).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		const notes = (await getMockup(as('member'), a.mockup.id)).notes;
		expect(notes).toMatchObject({ untrusted: true });
	});

	it('an oversize file is refused before anything is stored, and a screenshot must be a small PNG', async () => {
		const p = await plan('Size plan');
		const before = storage.files.size;
		await expect(
			publishMockup(as('member'), { item: p.ref }, new Uint8Array(MAX_MOCKUP_BYTES + 1))
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			publishMockup(as('member'), { item: p.ref }, new Uint8Array())
		).rejects.toMatchObject({
			code: 'INVALID'
		});
		await expect(
			publishMockup(as('member'), { item: p.ref }, html(1), new Uint8Array([1, 2, 3, 4]))
		).rejects.toMatchObject({ code: 'INVALID' });
		expect(storage.files.size).toBe(before);
		const ok = await publishMockup(as('member'), { item: p.ref }, html(1), PNG);
		expect(ok.version.hasScreenshot).toBe(true);
		expect(storage.files.size).toBe(before + 2);
	});

	it('pins belong to a version, writers add them, and only the author or an admin removes one', async () => {
		const p = await plan('Pin plan');
		const m = await publishMockup(as('member'), { item: p.ref }, html(1));
		await publishMockup(as('member'), { mockup: m.mockup.id }, html(2));
		await expect(
			addMockupPin(as('viewer'), { mockup: m.mockup.id, version: 2, x: 5, y: 5, body: 'Hi' })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		const pin = await addMockupPin(as('member'), {
			mockup: m.mockup.id,
			version: 1,
			x: 140,
			y: -3,
			hint: 'button.save',
			body: 'Make this\u0000 larger'
		});
		expect(pin.pin).toMatchObject({
			x: 100,
			y: 0,
			version: 1,
			untrusted: true,
			body: 'Make this larger'
		});
		await expect(
			addMockupPin(as('member'), { mockup: m.mockup.id, version: 9, x: 1, y: 1, body: 'x' })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		const v1 = await listMockupPins(as('viewer'), m.mockup.id, 1);
		const v2 = await listMockupPins(as('viewer'), m.mockup.id, 2);
		expect(v1.pins).toHaveLength(1);
		expect(v2.pins).toHaveLength(0);
		await expect(removeMockupPin(as('viewer'), pin.pin.id)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await removeMockupPin(as('admin'), pin.pin.id);
		expect((await listMockupPins(as('member'), m.mockup.id)).pins).toHaveLength(0);
	});

	it('a pin remembers its device, and writers resolve and reopen it without a second event for the same state', async () => {
		const p = await plan('Resolve plan');
		const m = await publishMockup(as('member'), { item: p.ref }, html(1));
		const phone = await addMockupPin(as('member'), {
			mockup: m.mockup.id,
			version: 1,
			x: 10,
			y: 20,
			body: 'Too tight on a phone',
			device: 'phone'
		});
		const older = await addMockupPin(as('member'), {
			mockup: m.mockup.id,
			version: 1,
			x: 30,
			y: 40,
			body: 'Older pin'
		});
		expect(phone.pin).toMatchObject({ device: 'phone', resolved: false, resolvedBy: null });
		expect(older.pin.device).toBeNull();
		await expect(
			addMockupPin(as('member'), {
				mockup: m.mockup.id,
				version: 1,
				x: 1,
				y: 1,
				body: 'x',
				device: 'watch' as never
			})
		).rejects.toThrow();
		// Viewers cannot resolve, writers can
		await expect(setMockupPinResolved(as('viewer'), phone.pin.id, true)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		const done = await setMockupPinResolved(as('member'), phone.pin.id, true);
		expect(done.pin).toMatchObject({ resolved: true, resolvedBy: 'member' });
		const events = () =>
			db.admin.query<{ verb: string }>(
				`select verb from event where project_id = '${w.projectId}' and verb in ('mockup.pin-resolve','mockup.pin-reopen') order by created_at`
			);
		const after1 = (await events()).length;
		// Resolving a resolved pin changes nothing and writes no event
		await setMockupPinResolved(as('admin'), phone.pin.id, true);
		expect((await events()).length).toBe(after1);
		const reopened = await setMockupPinResolved(as('admin'), phone.pin.id, false);
		expect(reopened.pin).toMatchObject({ resolved: false, resolvedBy: null, resolvedAt: null });
		expect((await events()).length).toBe(after1 + 1);
		const listed = await listMockupPins(as('viewer'), m.mockup.id, 1);
		expect(listed.pins.map((x) => x.device).sort()).toEqual([null, 'phone']);
		await expect(
			setMockupPinResolved(as('member'), '00000000-0000-4000-8000-000000000000', true)
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('a private plan hides its mockup from everyone else, and a change of the plan carries to its mockups', async () => {
		const p = await plan('Private plan', 'member');
		const m = await publishMockup(as('member'), { item: p.ref }, html(1));
		await updateItem(as('member'), { item: p.ref, visibility: 'private' });
		expect((await getMockup(as('member'), m.mockup.id)).mockup.visibility).toBe('private');
		for (const who of ['admin', 'owner', 'viewer'] as const) {
			await expect(getMockup(as(who), m.mockup.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
			expect(
				(await listMockups(as(who), { project: w.projectKey })).mockups.map((x) => x.id)
			).not.toContain(m.mockup.id);
		}
		// The public link cannot be switched on for a private plan
		await expect(setMockupPublicLink(as('member'), m.mockup.id, true)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await updateItem(as('member'), { item: p.ref, visibility: 'public' });
		await expect(setMockupPublicLink(as('admin'), m.mockup.id, true)).resolves.toMatchObject({
			mockup: { publicLinkOn: true }
		});
		// Making the plan private again switches the link off, and public again does not switch it back on
		await updateItem(as('member'), { item: p.ref, visibility: 'private' });
		expect((await getMockup(as('member'), m.mockup.id)).mockup.publicLinkOn).toBe(false);
		await updateItem(as('member'), { item: p.ref, visibility: 'public' });
		expect((await getMockup(as('admin'), m.mockup.id)).mockup.publicLinkOn).toBe(false);
	});

	it('undoing a visibility change or a create carries to the mockups of the plan', async () => {
		const p = await plan('Undo plan');
		const m = await publishMockup(as('member'), { item: p.ref }, html(1));
		await updateItem(as('member'), { item: p.ref, visibility: 'private' });
		const flip = (await listEvents(as('member'), { project: w.projectKey, item: p.ref })).find(
			(e) => e.verb === 'item.update'
		)!;
		await expect(undoChange(as('member'), flip.id)).resolves.toMatchObject({ ok: true });
		expect((await getMockup(as('admin'), m.mockup.id)).mockup.visibility).toBe('public');
		// Undoing the plan's create trashes the plan and switches its mockups' links off
		const q = await plan('Undo create plan');
		const m2 = await publishMockup(as('member'), { item: q.ref }, html(1));
		await setMockupPublicLink(as('admin'), m2.mockup.id, true);
		const created = (await listEvents(as('member'), { project: w.projectKey, item: q.ref })).find(
			(e) => e.verb === 'item.create'
		)!;
		await expect(undoChange(as('member'), created.id)).resolves.toMatchObject({ ok: true });
		// The mockup is hidden with its trashed plan, so the link state is read from the row
		await expect(getMockup(as('admin'), m2.mockup.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		const [link] = await db.admin.query<{ public_enabled: boolean }>(
			`select public_enabled from mockup where id = '${m2.mockup.id}'`
		);
		expect(link.public_enabled).toBe(false);
	});

	it('the public link reads only its own mockup, a new address replaces the old, and every off state returns nothing', async () => {
		const p = await plan('Public plan');
		const m = await publishMockup(as('member'), { item: p.ref }, html(1));
		const other = await publishMockup(
			as('member'),
			{ item: (await plan('Public plan two')).ref },
			html(1)
		);
		expect(await rowByToken(hashOf('not-a-token'))).toEqual([]);
		const on = await setMockupPublicLink(as('admin'), m.mockup.id, true);
		expect(on.token!.length).toBeGreaterThanOrEqual(32);
		expect(on.url).toBe(`${BASE}/m/${on.token}`);
		// The clear address is never stored
		const stored = await db.admin.query<{ public_token_hash: string }>(
			`select public_token_hash from mockup where id = '${m.mockup.id}'`
		);
		expect(stored[0].public_token_hash).toBe(hashOf(on.token!));
		expect(stored[0].public_token_hash).not.toContain(on.token!);
		// The token finds that one row and no other, even though other rows exist in the org
		const found = await rowByToken(hashOf(on.token!));
		expect(found.map((r) => r.id)).toEqual([m.mockup.id]);
		expect(await rowByToken(hashOf('x'.repeat(30)))).toEqual([]);
		// Without any tenant the table is empty for everyone
		expect(await withTenant(db, {}, (tx) => tx.select().from(mockup))).toEqual([]);
		// The policy only reads: a write through the token matches no row
		const changed = await withTenant(db, { mockupTokenHash: hashOf(on.token!) }, (tx) =>
			tx.update(mockup).set({ title: 'hacked' }).returning({ id: mockup.id })
		);
		expect(changed).toEqual([]);
		// A new address stops the old one at once
		const again = await setMockupPublicLink(as('admin'), m.mockup.id, true);
		expect(again.token).not.toBe(on.token);
		expect(await rowByToken(hashOf(on.token!))).toEqual([]);
		expect(await rowByToken(hashOf(again.token!))).toHaveLength(1);
		// Off, trashed and restored from the trash: nothing, and the link is not back on
		await setMockupPublicLink(as('admin'), m.mockup.id, false);
		expect(await rowByToken(hashOf(again.token!))).toEqual([]);
		const third = await setMockupPublicLink(as('admin'), m.mockup.id, true);
		await trashMockup(as('member'), m.mockup.id);
		expect(await rowByToken(hashOf(third.token!))).toEqual([]);
		await restoreMockupFromTrash(as('member'), m.mockup.id);
		expect(await rowByToken(hashOf(third.token!))).toEqual([]);
		expect((await getMockup(as('member'), m.mockup.id)).mockup.publicLinkOn).toBe(false);
		// A plan in the trash turns its mockups' links off
		const fourth = await setMockupPublicLink(as('admin'), other.mockup.id, true);
		expect(await rowByToken(hashOf(fourth.token!))).toHaveLength(1);
		await trashItem(as('member'), p.ref);
		await trashItem(as('member'), (await getMockup(as('member'), other.mockup.id)).plan!.ref);
		expect(await rowByToken(hashOf(fourth.token!))).toEqual([]);
	});

	it('a mockup is hidden while its plan is in the trash and is back when the plan is restored', async () => {
		const gone = await plan('Trashed plan with a mockup');
		const kept = await plan('Live plan with a mockup');
		const m = await publishMockup(as('member'), { item: gone.ref }, html(1));
		const other = await publishMockup(as('member'), { item: kept.ref }, html(1));
		const solo = await publishMockup(
			as('member'),
			{ project: w.projectKey, title: 'Solo' },
			html(1)
		);
		const ids = async () =>
			(await listMockups(as('member'), { project: w.projectKey })).mockups.map((x) => x.id);
		expect(await ids()).toEqual(
			expect.arrayContaining([m.mockup.id, other.mockup.id, solo.mockup.id])
		);
		await trashItem(as('member'), gone.ref);
		// Gone from the list and from every read, and not in the mockup trash: it follows its plan
		const after = await ids();
		expect(after).not.toContain(m.mockup.id);
		expect(after).toEqual(expect.arrayContaining([other.mockup.id, solo.mockup.id]));
		await expect(getMockup(as('member'), m.mockup.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(readMockupHtml(as('member'), m.mockup.id)).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		expect(
			(await listMockups(as('member'), { project: w.projectKey, trashed: true })).mockups.map(
				(x) => x.id
			)
		).not.toContain(m.mockup.id);
		await restoreItem(as('member'), gone.ref);
		expect(await ids()).toContain(m.mockup.id);
		expect((await getMockup(as('member'), m.mockup.id)).plan?.ref).toBe(gone.ref);
	});

	it('linking moves a mockup to another plan, and an item purged after 30 days takes its mockup to the mockup trash', async () => {
		const a = await plan('Link plan A', 'member');
		const b = await plan('Link plan B', 'member');
		const m = await publishMockup(as('member'), { item: a.ref }, html(1));
		const moved = await linkMockup(as('member'), m.mockup.id, b.ref);
		expect(moved.mockup.itemId).toBe(b.id);
		const solo = await linkMockup(as('member'), m.mockup.id, null);
		expect(solo.mockup.itemId).toBeNull();
		await linkMockup(as('member'), m.mockup.id, a.ref);
		await updateItem(as('member'), { item: a.ref, visibility: 'private' });
		await trashItem(as('member'), a.ref);
		await db.admin.exec(
			`update item set deleted_at = now() - interval '31 days' where id = '${a.id}'`
		);
		await purgeTrash(as('admin'));
		const [row] = await db.admin.query<{ item_id: string | null; visibility: string }>(
			`select item_id, visibility from mockup where id = '${m.mockup.id}'`
		);
		expect(row).toEqual({ item_id: null, visibility: 'private' });
		// It does not come back as a standalone mockup: it is in the mockup trash, where its maker can still restore it
		await expect(getMockup(as('admin'), m.mockup.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(getMockup(as('member'), m.mockup.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		expect(
			(await listMockups(as('member'), { project: w.projectKey })).mockups.map((x) => x.id)
		).not.toContain(m.mockup.id);
		expect((await listTrash(as('member'), w.projectKey)).mockups.map((x) => x.id)).toContain(
			m.mockup.id
		);
		await restoreMockupFromTrash(as('member'), m.mockup.id);
		expect((await getMockup(as('member'), m.mockup.id)).mockup.id).toBe(m.mockup.id);
	});

	it('a mockup trashed for 30 days is purged with its versions, pins and files', async () => {
		const p = await plan('Purge plan');
		const m = await publishMockup(as('member'), { item: p.ref }, html(1), PNG);
		await publishMockup(as('member'), { mockup: m.mockup.id }, html(2));
		await addMockupPin(as('member'), { mockup: m.mockup.id, version: 1, x: 1, y: 1, body: 'pin' });
		const before = storage.files.size;
		await trashMockup(as('member'), m.mockup.id);
		const trash = await listTrash(as('member'), w.projectKey);
		expect(trash.mockups.map((x) => x.id)).toContain(m.mockup.id);
		expect(trash.mockups.find((x) => x.id === m.mockup.id)?.daysLeft).toBe(30);
		expect((await purgeTrash(as('admin'))).files).toBe(0);
		await db.admin.exec(
			`update mockup set trashed_at = now() - interval '31 days' where id = '${m.mockup.id}'`
		);
		await purgeTrash(as('admin'));
		expect(storage.files.size).toBe(before - 3);
		for (const t of ['mockup', 'mockup_version', 'mockup_pin']) {
			const [n] = await db.admin.query<{ n: number }>(
				`select count(*)::int as n from ${t} where ${t === 'mockup' ? 'id' : 'mockup_id'} = '${m.mockup.id}'`
			);
			expect(n.n).toBe(0);
		}
	});

	it('the public link policy is a read only policy on the mockup table alone', async () => {
		const rows = await db.admin.query<{ tablename: string; cmd: string }>(
			`select tablename, cmd from pg_policies where policyname = 'public_link_read'`
		);
		expect(rows).toEqual([{ tablename: 'mockup', cmd: 'SELECT' }]);
		const stray = await withTenant(db, { mockupTokenHash: hashOf('a') }, (tx) =>
			tx.execute(sql`select count(*)::int as n from mockup_version`)
		);
		expect((stray as unknown as { rows: { n: number }[] }).rows[0].n).toBe(0);
	});

	it('a plan page gets a count and a list always, and the preview and notes only when its tab is open', async () => {
		const p = await plan('Plan tab plan');
		expect(await itemMockups(as('member'), w.projectKey, p.ref, true)).toEqual({
			list: [],
			open: null
		});
		const m = await publishMockup(
			as('member'),
			{ item: p.ref, keepNotes: 'Keep the table.', freeNotes: 'Free colours.' },
			html(1),
			PNG
		);
		const closed = await itemMockups(as('viewer'), w.projectKey, p.ref, false);
		expect(closed.open).toBeNull();
		expect(closed.list).toHaveLength(1);
		expect(closed.list[0]).toMatchObject({ id: m.mockup.id, currentVersion: 1, hasShot: true });
		expect(closed.list[0].thumb).toMatch(
			new RegExp('^/mf/' + w.orgId + '/' + w.projectId + '/' + m.mockup.id + '/1/shot[?]exp=')
		);
		const opened = await itemMockups(as('viewer'), w.projectKey, p.ref, true);
		expect(opened.open).toMatchObject({
			id: m.mockup.id,
			version: 1,
			notes: { keep: 'Keep the table.', free: 'Free colours.' }
		});
		expect(opened.open?.src).toMatch(/^\/mf\/.+\/1\/html[?]exp=/);
		expect(closed.list[0].live).toBe(false);
		// A mockup with no screenshot gets the address of its live preview page, signed with no database call per card
		const bare = await plan('Bare plan');
		const noShot = await publishMockup(as('member'), { item: bare.ref }, html(1));
		const bareList = (await itemMockups(as('viewer'), w.projectKey, bare.ref, false)).list;
		expect(bareList[0]).toMatchObject({ id: noShot.mockup.id, hasShot: false, live: true });
		expect(bareList[0].thumb).toMatch(
			new RegExp('^/mf/' + w.orgId + '/' + w.projectId + '/' + noShot.mockup.id + '/1/thumb[?]exp=')
		);
		// Another plan's page never lists it, and a hidden plan's mockup is not listed for someone who cannot see it
		const other = await plan('Another plan');
		expect((await itemMockups(as('viewer'), w.projectKey, other.ref, false)).list).toEqual([]);
	});

	it('review fixes: unlinking keeps the visibility, a lost write leaves no file, the address never reaches the retry log, kits are pruned, and a stray name is trimmed', async () => {
		// Unlinking from a private plan keeps the mockup private
		const p = await plan('Unlink private plan');
		const m = await publishMockup(as('member'), { item: p.ref }, html(1));
		await updateItem(as('member'), { item: p.ref, visibility: 'private' });
		const solo = await linkMockup(as('member'), m.mockup.id, null);
		expect(solo.mockup).toMatchObject({ itemId: null, visibility: 'private' });
		await expect(getMockup(as('admin'), m.mockup.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		// A viewer cannot bring a mockup back from the trash (and one made private is not even visible to them)
		await trashMockup(as('member'), m.mockup.id);
		await expect(restoreMockupFromTrash(as('viewer'), m.mockup.id)).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		const pub = await publishMockup(
			as('member'),
			{ item: (await plan('Trash viewer plan')).ref },
			html(1)
		);
		await trashMockup(as('member'), pub.mockup.id);
		await expect(restoreMockupFromTrash(as('viewer'), pub.mockup.id)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		// A write that stored its page and then failed storing the screenshot deletes the page again
		const q = await plan('Failing storage plan');
		const failing = {
			...storage,
			put: (key: string, bytes: Uint8Array, mime: string) =>
				key.endsWith('.png')
					? Promise.reject(new Error('disk full'))
					: storage.put(key, bytes, mime)
		};
		const before = storage.files.size;
		await expect(
			publishMockup(
				{ ...as('member'), services: { storage: failing, baseUrl: BASE } },
				{ item: q.ref },
				html(1),
				PNG
			)
		).rejects.toThrow('disk full');
		expect(storage.files.size).toBe(before);
		// Switching the public link on is never kept in the retry log, so the clear address is not in the database
		const r = await plan('Retry log plan');
		const made = await publishMockup(as('member'), { item: r.ref }, html(1));
		const on = await setMockupPublicLink(as('admin', 'public-link-retry-1'), made.mockup.id, true);
		const logged = await db.admin.query<{ n: number }>(
			`select count(*)::int as n from request_log where result::text like '%${on.token}%'`
		);
		expect(logged[0].n).toBe(0);
		// A matching address reads its mockup row and no other table
		const hash = hashOf(on.token!);
		const other = await withTenant(db, { mockupTokenHash: hash }, async (tx) => ({
			versions: (await tx.execute(
				sql`select count(*)::int as n from mockup_version`
			)) as unknown as { rows: { n: number }[] },
			pins: (await tx.execute(sql`select count(*)::int as n from mockup_pin`)) as unknown as {
				rows: { n: number }[];
			},
			projects: (await tx.execute(sql`select count(*)::int as n from item`)) as unknown as {
				rows: { n: number }[];
			}
		}));
		expect([other.versions.rows[0].n, other.pins.rows[0].n, other.projects.rows[0].n]).toEqual([
			0, 0, 0
		]);
		await expect(withTenant(db, { mockupTokenHash: 'not-hex' }, async () => 1)).rejects.toThrow(
			/sha256/
		);
		// Only the newest five kits are kept, with their files
		for (let i = 1; i <= 7; i++)
			await setMockupKit(as('admin'), { project: w.projectKey, builtFromCommit: `c${i}` }, html(i));
		const kits = await db.admin.query<{ k: string; number: number }>(
			`select storage_key as k, number from mockup_kit where project_id = '${w.projectId}' order by number`
		);
		expect(kits.map((x) => x.number).slice(-5)).toEqual([
			kits.at(-5)!.number,
			kits.at(-4)!.number,
			kits.at(-3)!.number,
			kits.at(-2)!.number,
			kits.at(-1)!.number
		]);
		expect(kits.length).toBe(5);
		for (const k of kits) expect(storage.files.has(k.k)).toBe(true);
	});
	it('a backup carries the version, screenshot and kit files and restores them, and an org purge erases them', async () => {
		const p = await plan('Backup plan');
		const m = await publishMockup(as('member'), { item: p.ref }, html(1), PNG);
		await setMockupKit(as('admin'), { project: w.projectKey, builtFromCommit: 'def5678' }, html(8));
		const { frames, meta } = await exportOrg(adminFromExecutor(db.admin), storage, w.orgId);
		expect(meta.missingFiles).toEqual([]);
		const keys = frames.flatMap((f) =>
			f.type === 'file' ? [(f.json as { key: string }).key] : []
		);
		const mine = (
			await db.admin.query<{ k: string }>(
				`select storage_key as k from mockup_version where org_id = '${w.orgId}' union all select screenshot_key from mockup_version where org_id = '${w.orgId}' and screenshot_key is not null union all select storage_key from mockup_kit where org_id = '${w.orgId}'`
			)
		).map((r) => r.k);
		expect(mine.length).toBeGreaterThanOrEqual(3);
		for (const k of mine) expect(keys).toContain(k);
		// The files come back byte for byte in a fresh database and a fresh storage
		const target = await makePostgres();
		try {
			const restored = memoryStorage('restored-storage-secret-0123456789');
			await loadOrg(frames, adminFromExecutor(target.admin), restored);
			for (const k of mine)
				expect(restored.files.get(k)?.bytes).toEqual(storage.files.get(k)?.bytes);
			const [n] = await target.admin.query<{ n: number }>(
				`select count(*)::int as n from mockup where id = '${m.mockup.id}'`
			);
			expect(n.n).toBe(1);
		} finally {
			await target.stop();
		}
		// Deleting the organisation and purging it erases every one of those files
		await db.admin.exec(
			`update org set deleted_at = now() - interval '40 days' where id = '${w.orgId}'`
		);
		expect(await dueOrgPurges(db)).toContain(w.orgId);
		expect(await purgeOrg({ handle: db, storage, backups: null }, w.orgId)).toBe('purged');
		for (const k of mine) expect(storage.files.has(k)).toBe(false);
	});
});
