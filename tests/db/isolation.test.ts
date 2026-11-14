// 3.10: DATABASE LEVEL ISOLATION, RUN AS app_runtime ON A REAL POSTGRESQL SERVER

// IMPORTED DEP-MODULES
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { item, project, projectPin } from '../../src/lib/server/db/schema';
import { TENANT_TABLES } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import { makePostgres, seedTwoOrgs, type Seed, type TestDb } from '../support/db';

// -- FUNCTIONS -- //

const rowsOf = (res: unknown) => (res as { rows: Record<string, unknown>[] }).rows;

/** Drizzle wraps the driver error, so the PostgreSQL message sits on the cause chain. */
async function failure(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return 'did not fail';
	} catch (e) {
		const out: string[] = [];
		for (
			let err = e as { message?: string; cause?: unknown } | undefined;
			err;
			err = err.cause as typeof err
		)
			out.push(err.message ?? '');
		return out.join(' | ');
	}
}

describe('tenant isolation', () => {
	const make = makePostgres;
	let db: TestDb;
	let s: Seed;

	beforeAll(async () => {
		db = await make();
		s = await seedTwoOrgs(db);
	}, 180_000);
	afterAll(async () => {
		await db?.stop();
	});

	it('every table with an org column is registered, forced and has a policy', async () => {
		const withOrg = await db.admin.query<{ table_name: string }>(
			`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'org_id' group by table_name`
		);
		const registered = new Set(TENANT_TABLES.map((t) => t.name));
		for (const r of withOrg)
			expect(registered.has(r.table_name), `${r.table_name} is not in the tenant registry`).toBe(
				true
			);
		const forced = await db.admin.query<{
			relname: string;
			relforcerowsecurity: boolean;
			relrowsecurity: boolean;
		}>(
			`select relname, relforcerowsecurity, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`
		);
		const byName = new Map(forced.map((r) => [r.relname, r]));
		for (const t of TENANT_TABLES) {
			expect(byName.get(t.name)?.relrowsecurity, `${t.name} row security`).toBe(true);
			expect(byName.get(t.name)?.relforcerowsecurity, `${t.name} forced`).toBe(true);
		}
		const policies = await db.admin.query<{ tablename: string }>(
			`select tablename from pg_policies where policyname = 'tenant_isolation'`
		);
		expect(new Set(policies.map((p) => p.tablename))).toEqual(registered);
	});

	it('a request sees only its own org', async () => {
		const a = await withTenant(db, { orgId: s.orgA }, (tx) => tx.select().from(item));
		const b = await withTenant(db, { orgId: s.orgB }, (tx) => tx.select().from(item));
		expect(a.map((r) => r.ref).sort()).toEqual(['AAA-1', 'AAB-1']);
		expect(b.map((r) => r.ref)).toEqual(['BBB-1']);
	});

	it('a pin is visible to its own person only, and cannot be planted for another org', async () => {
		// Two people in org A and one in org B each pin a project, the seed bypasses the policies
		await db.admin.exec(
			`INSERT INTO "user" (id, name, email) VALUES ('u-a2', 'Ana Two', 'ana2@a.example') ON CONFLICT DO NOTHING`
		);
		await db.admin.exec(
			`INSERT INTO project_pin (org_id, project_id, user_id) VALUES ('${s.orgA}', '${s.projectA}', 'u-a'), ('${s.orgA}', '${s.projectA}', 'u-a2'), ('${s.orgB}', '${s.projectB}', 'u-b')`
		);
		const own = await withTenant(db, { orgId: s.orgA, userId: 'u-a' }, (tx) =>
			tx.select().from(projectPin)
		);
		expect(own.map((r) => r.userId)).toEqual(['u-a']);
		// Another person in the same org sees their own row, not the first person's
		const other = await withTenant(db, { orgId: s.orgA, userId: 'u-a2' }, (tx) =>
			tx.select().from(projectPin)
		);
		expect(other.map((r) => r.userId)).toEqual(['u-a2']);
		// Org B's pin is out of reach of org A, even for the same person id
		const crossOrg = await withTenant(db, { orgId: s.orgA, userId: 'u-b' }, (tx) =>
			tx.select().from(projectPin)
		);
		expect(crossOrg).toHaveLength(0);
		// No person set reads nothing
		const nobody = await withTenant(db, { orgId: s.orgA }, (tx) => tx.select().from(projectPin));
		expect(nobody).toHaveLength(0);
		// A write that names another org is refused
		await expect(
			withTenant(db, { orgId: s.orgA, userId: 'u-a' }, (tx) =>
				tx.insert(projectPin).values({ orgId: s.orgB, projectId: s.projectB, userId: 'u-a' })
			)
		).rejects.toThrow();
		await db.admin.exec(`DELETE FROM project_pin`);
	});

	it('a request with no tenant reads nothing from any tenant table', async () => {
		for (const t of TENANT_TABLES) {
			const res = await withTenant(db, {}, (tx) =>
				tx.execute(sql.raw(`select count(*)::int as n from "${t.name}"`))
			);
			expect(rowsOf(res)[0].n, t.name).toBe(0);
		}
	});

	it('naming another org in a query does not reach its rows', async () => {
		const res = await withTenant(db, { orgId: s.orgA }, (tx) =>
			tx.execute(sql`select * from item where org_id = ${s.orgB}`)
		);
		expect(rowsOf(res)).toHaveLength(0);
	});

	it('a write into another org is refused or changes nothing', async () => {
		await expect(
			withTenant(db, { orgId: s.orgA }, (tx) =>
				tx.insert(item).values({
					orgId: s.orgB,
					projectId: s.projectB,
					number: 9,
					ref: 'BBB-9',
					title: 'Planted'
				})
			)
		).rejects.toThrow();
		const upd = await withTenant(db, { orgId: s.orgA }, (tx) =>
			tx.execute(sql`update item set title = 'hacked' where id = ${s.itemB} returning id`)
		);
		expect(rowsOf(upd)).toHaveLength(0);
		const del = await withTenant(db, { orgId: s.orgA }, (tx) =>
			tx.execute(sql`delete from item where id = ${s.itemB} returning id`)
		);
		expect(rowsOf(del)).toHaveLength(0);
		const still = await withTenant(db, { orgId: s.orgB }, (tx) => tx.select().from(item));
		expect(still.map((r) => r.title)).toEqual(['Item of B']);
	});

	it('moving a row into another org with an update is refused', async () => {
		await expect(
			withTenant(db, { orgId: s.orgA }, (tx) =>
				tx.execute(sql`update item set org_id = ${s.orgB} where id = ${s.itemA}`)
			)
		).rejects.toThrow();
	});

	it('a project set on the request narrows project tables to that project', async () => {
		const only = await withTenant(db, { orgId: s.orgA, projectId: s.projectA }, (tx) =>
			tx.select().from(item)
		);
		expect(only.map((r) => r.ref)).toEqual(['AAA-1']);
		// A project of another org gives nothing, even though the project id is real
		const cross = await withTenant(db, { orgId: s.orgA, projectId: s.projectB }, (tx) =>
			tx.select().from(item)
		);
		expect(cross).toHaveLength(0);
	});

	it('an org is visible only while the request is inside it', async () => {
		const own = await withTenant(db, { orgId: s.orgA }, (tx) =>
			tx.execute(sql`select slug from org`)
		);
		expect(rowsOf(own).map((r) => r.slug)).toEqual(['a']);
		const none = await withTenant(db, {}, (tx) => tx.execute(sql`select slug from org`));
		expect(rowsOf(none)).toHaveLength(0);
	});

	it('a person can list their own memberships before choosing an org, and no one else', async () => {
		const mine = await withTenant(db, { userId: 'u-a' }, (tx) =>
			tx.execute(sql`select org_id from member`)
		);
		expect(rowsOf(mine).map((r) => r.org_id)).toEqual([s.orgA]);
		const stranger = await withTenant(db, { userId: 'u-nobody' }, (tx) =>
			tx.execute(sql`select org_id from member`)
		);
		expect(rowsOf(stranger)).toHaveLength(0);
	});

	it('refuses a tenant value that is not a UUID', async () => {
		await expect(
			withTenant(db, { orgId: "x' or '1'='1" }, (tx) => tx.select().from(project))
		).rejects.toThrow(/UUID/);
	});

	it('the event log only grows, and only the actor can be anonymised', async () => {
		await db.admin.exec(
			`insert into event (org_id, project_id, actor_user_id, actor_label, verb, target_type) values ('${s.orgA}', '${s.projectA}', 'u-a', 'Ana', 'item.create', 'item')`
		);
		const res = await withTenant(db, { orgId: s.orgA }, (tx) =>
			tx.execute(sql`select id from event`)
		);
		const eventId = rowsOf(res)[0].id as number;
		expect(
			await failure(
				withTenant(db, { orgId: s.orgA }, (tx) =>
					tx.execute(sql`update event set verb = 'x' where id = ${eventId}`)
				)
			)
		).toMatch(/append only|permission denied/);
		expect(
			await failure(
				withTenant(db, { orgId: s.orgA }, (tx) =>
					tx.execute(sql`delete from event where id = ${eventId}`)
				)
			)
		).toMatch(/permission denied/);
		await withTenant(db, { orgId: s.orgA }, (tx) =>
			tx.execute(
				sql`update event set actor_user_id = null, actor_label = 'Former member' where id = ${eventId}`
			)
		);
		const after = await withTenant(db, { orgId: s.orgA }, (tx) =>
			tx.execute(sql`select actor_user_id, actor_label, verb from event where id = ${eventId}`)
		);
		expect(rowsOf(after)[0]).toEqual({
			actor_user_id: null,
			actor_label: 'Former member',
			verb: 'item.create'
		});
	});

	it('the owner role is bound by row level security too (no owner bypass)', async () => {
		const owner = (db as TestDb).ownerPool!;
		const bare = await owner.query('select count(*)::int as n from item');
		expect(bare.rows[0].n).toBe(0);
		const client = await owner.connect();
		await client.query('begin');
		await client.query(`select set_config('app.org_id', $1, true)`, [s.orgA]);
		// No policy applies to the owner, so even with a tenant set it reads nothing: forced row level security denies by default
		const seen = await client.query('select count(*)::int as n from item');
		await client.query('rollback');
		client.release();
		expect(seen.rows[0].n).toBe(0);
	});

	it('a pooled connection never carries a tenant into the next request', async () => {
		// Many overlapping requests for both orgs on a small pool, each must see only its own org
		const checks = Array.from({ length: 40 }, (_, i) => {
			const org = i % 2 === 0 ? s.orgA : s.orgB;
			return withTenant(db, { orgId: org }, async (tx) => {
				await tx.execute(sql`select pg_sleep(0.01)`);
				return (await tx.select().from(item)).map((r) => r.orgId);
			}).then((orgs) => orgs.every((o) => o === org));
		});
		expect((await Promise.all(checks)).every(Boolean)).toBe(true);
		const after = await db.db.select().from(item);
		expect(after).toHaveLength(0);
	});
});
