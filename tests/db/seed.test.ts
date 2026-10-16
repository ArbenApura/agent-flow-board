// 3.9: THE SEED DATA, INCLUDING THE 5,000 ITEM LOAD PROJECT, AND A FIRST LOOK AT REGISTRY QUERY SPEED

// -- DEP-MODULES -- //
import { and, asc, count, eq, gt } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { item, project } from '../../src/lib/server/db/schema';
import { SEED, seedDemo } from '../../src/lib/server/db/seed';
import { withTenant } from '../../src/lib/server/db/tenant';
import { searchAll } from '../../src/lib/server/db/search';
import { makePglite, type TestDb } from '../support/db';

// -- FUNCTIONS -- //

describe('seed data', () => {
	let db: TestDb;
	beforeAll(async () => {
		db = await makePglite();
		await seedDemo(db.owner, { loadItems: 5000 });
	}, 120_000);
	afterAll(async () => {
		await db.stop();
	});

	it('seeds two orgs that cannot see each other', async () => {
		const acme = await withTenant(db, { orgId: SEED.acme }, (tx) => tx.select().from(project));
		const lumora = await withTenant(db, { orgId: SEED.lumora }, (tx) => tx.select().from(project));
		expect(acme.map((p) => p.key).sort()).toEqual(['CKT', 'LOAD', 'WEB']);
		expect(lumora.map((p) => p.key)).toEqual(['LUM']);
	});

	it('seeds 5,000 items in the load project and the named items with their steps', async () => {
		const [load] = await withTenant(db, { orgId: SEED.acme, projectId: SEED.load }, (tx) =>
			tx.select({ n: count() }).from(item)
		);
		expect(load.n).toBe(5000);
		const named = await withTenant(db, { orgId: SEED.acme, projectId: SEED.checkout }, (tx) =>
			tx.select().from(item).orderBy(asc(item.number))
		);
		expect(named.map((i) => i.status)).toEqual([
			'IN PROGRESS',
			'IN REVIEW',
			'PLANNED',
			'COMPLETED',
			'ON HOLD'
		]);
		expect(named[0].percent).toBe(50);
	});

	it('is safe to run twice', async () => {
		await seedDemo(db.owner, { loadItems: 5000 });
		const [load] = await withTenant(db, { orgId: SEED.acme, projectId: SEED.load }, (tx) =>
			tx.select({ n: count() }).from(item)
		);
		expect(load.n).toBe(5000);
	});

	it('pages the 5,000 item registry by keyset quickly', async () => {
		const page = async (after: number) =>
			withTenant(db, { orgId: SEED.acme, projectId: SEED.load }, (tx) =>
				tx
					.select()
					.from(item)
					.where(and(eq(item.projectId, SEED.load), gt(item.number, after)))
					.orderBy(asc(item.number))
					.limit(50)
			);
		await page(0);
		const t = performance.now();
		const a = await page(2000);
		const ms = performance.now() - t;
		expect(a[0].number).toBe(2001);
		expect(a).toHaveLength(50);
		expect(ms).toBeLessThan(150);
	});

	it('finds a load item by its reference through the search index', async () => {
		const hits = await withTenant(db, { orgId: SEED.acme }, (tx) => searchAll(tx, 'LOAD-4321'));
		expect(hits[0]?.title).toContain('LOAD-4321');
	});
});
