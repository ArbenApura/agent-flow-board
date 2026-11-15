// THE SETUP CHECKLIST OF CONNECT A TOOL (AFB-20261115-1000, H.4 TO H.6): A MARK IS THE PERSON'S OWN, IN ONE ORGANISATION
// Each rule has a negative control, so a test cannot pass on an empty answer.

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { connectSetupMark } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import { bridgeRunners, isOnline } from '../../src/lib/server/ops/bridgeRunners';
import { listMySetupMarks, setMySetupMark } from '../../src/lib/server/ops/connectSetup';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

describe('the setup marks of Connect a tool', () => {
	let db: TestDb;
	let w: World;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 240_000);
	afterAll(() => db?.stop());

	it('keeps what a person marks, changes it in place and clears it', async () => {
		const ctx = w.ctx('member');
		expect(await listMySetupMarks(ctx)).toEqual({ marks: {}, panel: null });
		const first = await setMySetupMark(ctx, { key: 'skills', state: 'done' });
		expect(first.marks).toEqual({ skills: 'done' });
		const changed = await setMySetupMark(ctx, { key: 'skills', state: 'skipped' });
		expect(changed.marks).toEqual({ skills: 'skipped' });
		const two = await setMySetupMark(ctx, { key: 'token', state: 'skipped' });
		expect(two.marks).toEqual({ skills: 'skipped', token: 'skipped' });
		const cleared = await setMySetupMark(ctx, { key: 'skills', state: null });
		expect(cleared.marks).toEqual({ token: 'skipped' });
		await setMySetupMark(ctx, { key: 'token', state: null });
	});

	it('keeps whether the person folded the checklist, apart from the tiles', async () => {
		const ctx = w.ctx('admin');
		expect((await setMySetupMark(ctx, { key: 'panel', state: 'closed' })).panel).toBe('closed');
		expect((await setMySetupMark(ctx, { key: 'panel', state: 'open' })).panel).toBe('open');
		const after = await setMySetupMark(ctx, { key: 'panel', state: null });
		expect(after).toEqual({ marks: {}, panel: null });
	});

	it('refuses a key outside the six tiles and a state that does not fit the key', async () => {
		const ctx = w.ctx('member');
		await expect(setMySetupMark(ctx, { key: 'made-up' as never, state: 'done' })).rejects.toThrow();
		await expect(setMySetupMark(ctx, { key: 'skills', state: 'open' })).rejects.toThrow();
		await expect(setMySetupMark(ctx, { key: 'panel', state: 'done' })).rejects.toThrow();
		expect(await listMySetupMarks(ctx)).toEqual({ marks: {}, panel: null });
	});

	it("never shows one person's marks to another in the same organisation", async () => {
		await setMySetupMark(w.ctx('member'), { key: 'skills', state: 'done' });
		await setMySetupMark(w.ctx('member'), { key: 'panel', state: 'closed' });
		// Negative control: the person who made them sees them
		expect((await listMySetupMarks(w.ctx('member'))).marks).toEqual({ skills: 'done' });
		for (const who of ['owner', 'admin', 'viewer', 'guest'] as const)
			expect(await listMySetupMarks(w.ctx(who)), who).toEqual({ marks: {}, panel: null });
		await setMySetupMark(w.ctx('member'), { key: 'skills', state: null });
		await setMySetupMark(w.ctx('member'), { key: 'panel', state: null });
	});

	it('lets a viewer and a guest keep their own checklist, apart from everyone else', async () => {
		await setMySetupMark(w.ctx('viewer'), { key: 'editor', state: 'skipped' });
		await setMySetupMark(w.ctx('guest'), { key: 'editor', state: 'done' });
		expect((await listMySetupMarks(w.ctx('viewer'))).marks).toEqual({ editor: 'skipped' });
		expect((await listMySetupMarks(w.ctx('guest'))).marks).toEqual({ editor: 'done' });
		expect((await listMySetupMarks(w.ctx('owner'))).marks).toEqual({});
		await setMySetupMark(w.ctx('viewer'), { key: 'editor', state: null });
		await setMySetupMark(w.ctx('guest'), { key: 'editor', state: null });
	});

	it('shows nothing of this organisation to a person of another one, and refuses them a write here', async () => {
		await setMySetupMark(w.ctx('owner'), { key: 'bridge', state: 'done' });
		const outsider = {
			handle: db,
			orgId: w.other.orgId,
			actor: { userId: w.other.userId, kind: 'person' as const, label: 'other' }
		};
		expect(await listMySetupMarks(outsider as never)).toEqual({ marks: {}, panel: null });
		// A person of the other organisation naming this one is not a member of it
		const intruder = { ...outsider, orgId: w.orgId };
		await expect(listMySetupMarks(intruder as never)).rejects.toThrow();
		await expect(
			setMySetupMark(intruder as never, { key: 'bridge', state: 'skipped' })
		).rejects.toThrow();
		expect((await listMySetupMarks(w.ctx('owner'))).marks).toEqual({ bridge: 'done' });
		await setMySetupMark(w.ctx('owner'), { key: 'bridge', state: null });
	});

	it('stops a row for another person or another organisation at the database, whatever the code says', async () => {
		const tenant = { orgId: w.orgId, userId: w.people.member };
		await expect(
			withTenant(db, tenant, (tx) =>
				tx
					.insert(connectSetupMark)
					.values({ orgId: w.orgId, userId: w.people.owner, key: 'skills', state: 'done' })
			)
		).rejects.toThrow();
		await expect(
			withTenant(db, tenant, (tx) =>
				tx
					.insert(connectSetupMark)
					.values({ orgId: w.other.orgId, userId: w.people.member, key: 'skills', state: 'done' })
			)
		).rejects.toThrow();
		// Negative control: a row for themselves in their own organisation is accepted
		await withTenant(db, tenant, (tx) =>
			tx
				.insert(connectSetupMark)
				.values({ orgId: w.orgId, userId: w.people.member, key: 'skills', state: 'done' })
		);
		const seen = await withTenant(db, { orgId: w.orgId, userId: w.people.owner }, (tx) =>
			tx.select().from(connectSetupMark)
		);
		expect(seen).toHaveLength(0);
		await db.admin.exec(`DELETE FROM connect_setup_mark`);
	});
});

describe('the check runners of the Bridge tab', () => {
	let db: TestDb;
	let w: World;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		const now = new Date().toISOString();
		const old = new Date(Date.now() - 3_600_000).toISOString();
		const insert = (id: number, owner: string, name: string, seen: string, slots: number) =>
			db.admin.exec(
				`INSERT INTO runner (id, org_id, kind, name, owner_id, last_seen_at, capacity_slots, capacity_busy) VALUES ('00000000-0000-4000-8000-${String(900 + id).padStart(12, '0')}', '${w.orgId}', 'tool', '${name}', '${owner}', '${seen}', ${slots}, 1)`
			);
		await insert(1, w.people.member, 'Members-Laptop', now, 8);
		await insert(2, w.people.owner, 'Owners-Desktop', now, 4);
		await insert(3, w.people.viewer, 'Viewers-Old-PC', old, 2);
		// A runner of the member that was registered but never heard from: it must not be taken for the newest
		await db.admin.exec(
			`INSERT INTO runner (id, org_id, kind, name, owner_id) VALUES ('00000000-0000-4000-8000-000000000904', '${w.orgId}', 'tool', 'Members-Never-Seen', '${w.people.member}')`
		);
	}, 240_000);
	afterAll(() => db?.stop());

	it('lists only the runners the person owns and counts the online ones of colleagues without naming them', async () => {
		const r = await bridgeRunners(w.ctx('member'));
		// The runner heard from last comes first, and the one never heard from goes last
		expect(r.mine.map((x) => x.name)).toEqual(['Members-Laptop', 'Members-Never-Seen']);
		expect(r.mine[0]).toMatchObject({ online: true, slots: 8, busy: 1 });
		expect(r.othersOnline).toBe(1);
		// Negative control: a colleague's runner is never named, and the old one is not counted as online
		expect(JSON.stringify(r)).not.toContain('Owners-Desktop');
		expect(JSON.stringify(r)).not.toContain('Viewers-Old-PC');
	});

	it("does not let a colleague's runner stand for the person's own", async () => {
		expect((await bridgeRunners(w.ctx('admin'))).mine).toEqual([]);
		const viewer = await bridgeRunners(w.ctx('viewer'));
		expect(viewer.mine).toHaveLength(1);
		expect(viewer.mine[0].online).toBe(false);
		expect(viewer.othersOnline).toBe(2);
	});

	it('shows nothing of this organisation to a person of another one', async () => {
		const outsider = {
			handle: db,
			orgId: w.other.orgId,
			actor: { userId: w.other.userId, kind: 'person' as const, label: 'other' }
		};
		expect(await bridgeRunners(outsider as never)).toEqual({ mine: [], othersOnline: 0 });
	});

	it('calls a runner online only when it was heard from inside the window', () => {
		const now = new Date('2026-11-15T10:00:00Z');
		expect(isOnline(new Date('2026-11-15T09:59:30Z'), now)).toBe(true);
		expect(isOnline(new Date('2026-11-15T09:58:00Z'), now)).toBe(false);
		expect(isOnline(null, now)).toBe(false);
	});
});
