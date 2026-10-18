// FLOW-20261017-0007: DELETING AN ORGANISATION. OWNER ONLY, LOCKED AT ONCE, RESTORABLE UNTIL THE PURGE CLAIMS IT, THEN ERASED.

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
// -- MODULES -- //
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { contextFor } from '../../src/lib/server/adapters/jobs';
import { handleApi } from '../../src/lib/server/api/dispatch';
import { orgDeletionLog } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import { OpError } from '../../src/lib/server/ops/context';
import { listProjects } from '../../src/lib/server/ops/projects';
import { authenticateToken, createToken } from '../../src/lib/server/ops/tokens';
import { describeInvite } from '../../src/lib/server/orgs/invites';
import { ORG_DELETE_GRACE_DAYS, purgeAt, sameOrgName } from '../../src/lib/server/orgs/deletion';
import {
	OrgError,
	createOrg,
	deleteOrg,
	listMyOrgs,
	orgDeletionSummary,
	orgForSlug,
	orgForSlugIncludingDeleted,
	restoreOrg
} from '../../src/lib/server/orgs/orgs';
import { dueOrgPurges, purgeOrg } from '../../src/lib/server/orgs/purge';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const DAY = 24 * 60 * 60 * 1000;

// -- FUNCTIONS -- //

describe('deleting an organisation', () => {
	let db: TestDb;
	let w: World;
	let name: string;
	let slug: string;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		const [row] = await db.admin.query<{ name: string; slug: string }>(
			`select name, slug from org where id = '${w.orgId}'`
		);
		name = row.name;
		slug = row.slug;
	}, 120_000);
	afterAll(async () => {
		await db?.stop();
	});

	it('compares the typed name exactly, ignoring surrounding spaces only', () => {
		expect(sameOrgName('  Acme  ', 'Acme')).toBe(true);
		expect(sameOrgName('acme', 'Acme')).toBe(false);
		expect(sameOrgName('Café', 'Café')).toBe(true);
		expect(purgeAt(new Date(0)).getTime()).toBe(ORG_DELETE_GRACE_DAYS * DAY);
	});

	it('only an owner may delete, and the typed name is checked on the server', async () => {
		for (const who of ['admin', 'member', 'viewer', 'guest'] as const)
			await expect(deleteOrg(db, w.orgId, w.people[who], name)).rejects.toMatchObject({
				code: 'FORBIDDEN'
			});
		await expect(deleteOrg(db, w.orgId, w.people.owner, 'wrong')).rejects.toMatchObject({
			code: 'INVALID'
		});
		// Nothing happened yet
		expect((await orgForSlug(db, slug, w.people.owner))?.deletedAt).toBeNull();
		await expect(orgDeletionSummary(db, w.orgId, w.people.admin)).rejects.toBeInstanceOf(OrgError);
		expect(await orgDeletionSummary(db, w.orgId, w.people.owner)).toEqual({
			projects: 1,
			items: 0,
			files: 0
		});
	});

	let first: Date;
	it('locks the org at once, keeps the address, and a second delete changes nothing', async () => {
		const token = await createToken(w.ctx('member'), { name: 'ci', permissions: ['read'] });
		expect(await authenticateToken(db, token.token)).not.toBeNull();

		const done = await deleteOrg(db, w.orgId, w.people.owner, `  ${name} `);
		first = done.deletedAt;
		expect(done.purgeAt.getTime() - first.getTime()).toBe(ORG_DELETE_GRACE_DAYS * DAY);

		// Hidden from the normal lookup, still found by the locked page, listed with its flag
		expect(await orgForSlug(db, slug, w.people.owner)).toBeNull();
		expect((await orgForSlugIncludingDeleted(db, slug, w.people.owner))?.deletedAt).toEqual(first);
		const mine = await listMyOrgs(db, w.people.member);
		expect(mine.find((o) => o.id === w.orgId)?.deletedAt).toEqual(first);

		// Every entry point refuses it
		await expect(listProjects(w.ctx('owner'))).rejects.toMatchObject({ code: 'ORG_LOCKED' });
		await expect(
			createToken(w.ctx('member'), { name: 'late token', permissions: ['read'] })
		).rejects.toBeInstanceOf(OpError);
		expect(await authenticateToken(db, token.token)).toBeNull();
		expect(await describeInvite(db, `${w.orgId}.${'a'.repeat(60)}`)).toBeNull();

		// A background job of the locked org is refused, unless it is the org's own purge
		await expect(contextFor(db, { orgId: w.orgId }).tenant(async () => 'ran')).rejects.toThrow(
			/scheduled for deletion/
		);
		expect(
			await contextFor(db, { orgId: w.orgId, allowLocked: true }).tenant(async () => 'ran')
		).toBe('ran');

		// The address stays reserved while the org is locked
		await expect(createOrg(db, w.people.admin, { name: 'Squatter', slug })).rejects.toMatchObject({
			code: 'SLUG_TAKEN'
		});

		// A second call returns the first date and writes no second log row
		const again = await deleteOrg(db, w.orgId, w.people.owner, name);
		expect(again.deletedAt).toEqual(first);
		const log = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(orgDeletionLog).where(eq(orgDeletionLog.orgId, w.orgId))
		);
		expect(log.map((r) => r.event)).toEqual(['deleted']);
		expect(log[0]).toMatchObject({ orgName: name, orgSlug: slug, actorUserId: w.people.owner });
	});

	it('only an owner restores, and everything works again afterwards', async () => {
		await expect(restoreOrg(db, w.orgId, w.people.admin)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		expect(await restoreOrg(db, w.orgId, w.people.owner)).toEqual({ restored: true });
		expect(await orgForSlug(db, slug, w.people.owner)).not.toBeNull();
		expect((await listProjects(w.ctx('owner'))).length).toBe(1);
		// Restoring an org that is not deleted changes nothing
		expect(await restoreOrg(db, w.orgId, w.people.owner)).toEqual({ restored: false });
	});

	it('the deletion log of one org is invisible to another', async () => {
		const seen = await withTenant(db, { orgId: w.other.orgId }, (tx) =>
			tx.select().from(orgDeletionLog)
		);
		expect(seen).toHaveLength(0);
		// And a request cannot rewrite or remove log rows
		await expect(
			withTenant(db, { orgId: w.orgId }, (tx) => tx.execute(sql`delete from org_deletion_log`))
		).rejects.toThrow();
	});

	it('the purge waits for the grace period, claims the org, survives a storage failure and then erases everything', async () => {
		const storage = memoryStorage('secret');
		await storage.put('a/one.txt', new Uint8Array([1]), 'text/plain');
		await storage.put('a/two.txt', new Uint8Array([2]), 'text/plain');
		await db.admin.exec(
			`insert into item (id, org_id, project_id, number, ref, title) values ('${w.orgId.replace(/.$/, '9')}', '${w.orgId}', '${w.projectId}', 1, '${w.projectKey}-1', 'Item')`
		);
		const itemId = w.orgId.replace(/.$/, '9');
		await db.admin.exec(
			`insert into attachment (org_id, project_id, item_id, filename, kind, mime, size, storage_key, checksum, caption) values ('${w.orgId}', '${w.projectId}', '${itemId}', 'one.txt', 'data', 'text/plain', 1, 'a/one.txt', 'x', 'one'), ('${w.orgId}', '${w.projectId}', '${itemId}', 'two.txt', 'data', 'text/plain', 1, 'a/two.txt', 'x', 'two')`
		);
		// The event log only grows for the runtime role, yet the purge must still erase it with the org
		await db.admin.exec(
			`insert into event (org_id, project_id, actor_user_id, actor_label, verb, target_type) values ('${w.orgId}', '${w.projectId}', '${w.people.owner}', 'owner', 'item.create', 'item')`
		);
		// Another org's file must survive
		await storage.put('b/keep.txt', new Uint8Array([3]), 'text/plain');

		await deleteOrg(db, w.orgId, w.people.owner, name);
		const deletedAt = (await orgForSlugIncludingDeleted(db, slug, w.people.owner))!.deletedAt!;

		// Not due yet
		expect(await dueOrgPurges(db, new Date(deletedAt.getTime() + DAY))).toEqual([]);
		expect(
			await purgeOrg(
				{ handle: db, storage, backups: null },
				w.orgId,
				new Date(deletedAt.getTime() + DAY)
			)
		).toBe('not-due');
		expect(storage.files.size).toBe(3);

		// Due: the sweep finds exactly this org and nothing else
		const later = new Date(deletedAt.getTime() + (ORG_DELETE_GRACE_DAYS + 1) * DAY);
		expect(await dueOrgPurges(db, later)).toEqual([w.orgId]);

		// A storage failure keeps the org claimed, and a restore is refused from then on
		const failing = {
			...storage,
			delete: async (key: string) => {
				if (key === 'a/two.txt') throw new Error('storage is down');
				await storage.delete(key);
			}
		};
		await expect(
			purgeOrg({ handle: db, storage: failing, backups: null }, w.orgId, later)
		).rejects.toThrow('storage is down');
		await expect(restoreOrg(db, w.orgId, w.people.owner)).rejects.toMatchObject({
			code: 'INVALID'
		});
		expect(storage.files.has('a/two.txt')).toBe(true);

		// The retry finishes the job
		expect(await purgeOrg({ handle: db, storage, backups: null }, w.orgId, later)).toBe('purged');
		expect([...storage.files.keys()]).toEqual(['b/keep.txt']);
		const [gone] = await db.admin.query<{ n: number }>(
			`select count(*)::int as n from org where id = '${w.orgId}'`
		);
		expect(gone.n).toBe(0);
		const [rows] = await db.admin.query<{ n: number }>(
			`select count(*)::int as n from project where org_id = '${w.orgId}'`
		);
		expect(rows.n).toBe(0);
		// The other org is untouched and the log outlives the org
		const [events] = await db.admin.query<{ n: number }>(
			`select count(*)::int as n from event where org_id = '${w.orgId}'`
		);
		expect(events.n).toBe(0);
		const [other] = await db.admin.query<{ n: number }>(
			`select count(*)::int as n from org where id = '${w.other.orgId}'`
		);
		expect(other.n).toBe(1);
		const log = await db.admin.query<{ event: string }>(
			`select event from org_deletion_log where org_id = '${w.orgId}' order by created_at, event`
		);
		expect(log.map((r) => r.event).sort()).toEqual(['deleted', 'deleted', 'purged', 'restored']);
		// Running it again is a success
		expect(await purgeOrg({ handle: db, storage, backups: null }, w.orgId, later)).toBe('gone');
	});
});

describe('deleting an organisation through the REST API', () => {
	let db: TestDb;
	let w: World;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 120_000);
	afterAll(async () => {
		await db?.stop();
	});

	const call = (
		path: string,
		options: { as?: keyof World['people']; token?: string; body?: unknown }
	) => {
		const headers = new Headers();
		if (options.token) headers.set('authorization', `Bearer ${options.token}`);
		return handleApi(
			{
				method: options.body === undefined ? 'GET' : 'POST',
				path,
				query: {},
				headers,
				body:
					options.body === undefined
						? new Uint8Array()
						: new TextEncoder().encode(JSON.stringify(options.body)),
				session: options.as ? { id: w.people[options.as], name: options.as } : null
			},
			{
				handle: db,
				storage: memoryStorage('storage-secret-for-tests-0123456789'),
				baseUrl: 'http://localhost:5180'
			}
		);
	};

	it('a token can never delete, an admin is refused, and an owner session deletes', async () => {
		const [row] = await db.admin.query<{ name: string; slug: string }>(
			`select name, slug from org where id = '${w.orgId}'`
		);
		const base = `/orgs/${row.slug}`;
		const token = await createToken(w.ctx('owner'), {
			name: 'owner token',
			permissions: ['read', 'write', 'delete', 'manage']
		});
		expect(
			(await call(`${base}/delete`, { token: token.token, body: { name: row.name } })).status
		).toBe(403);
		expect((await call(`${base}/delete`, { as: 'admin', body: { name: row.name } })).status).toBe(
			403
		);
		expect((await call(`${base}/deletion`, { as: 'admin' })).status).toBe(403);
		expect((await call(`${base}/delete`, { as: 'owner', body: { name: 'nope' } })).status).toBe(
			400
		);
		expect((await call(`${base}/deletion`, { as: 'owner' })).body).toMatchObject({ projects: 1 });
		expect((await call(`${base}/delete`, { as: 'owner', body: { name: row.name } })).status).toBe(
			200
		);
		// From now on the org is not found by session, the token stops, and /me does not list it
		expect((await call(`${base}/projects`, { as: 'owner' })).status).toBe(404);
		expect((await call(`${base}/projects`, { token: token.token })).status).toBe(401);
		const me = await call('/me', { as: 'owner' });
		expect((me.body as { orgs: { id: string }[] }).orgs.map((o) => o.id)).not.toContain(w.orgId);
	});
});
