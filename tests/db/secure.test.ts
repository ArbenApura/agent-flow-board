// SECURE() IS ONE TRANSACTION: A DEPLOY THAT RUNS IT WHILE THE APP SERVES NEVER SHOWS THE RUNTIME ROLE A MISSING POLICY

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { project } from '../../src/lib/server/db/schema';
import { secure } from '../../src/lib/server/db/migrate';
import { withTenant } from '../../src/lib/server/db/tenant';
import { makePostgres, seedTwoOrgs, type Seed, type TestDb } from '../support/db';

// -- FUNCTIONS -- //

describe('secure()', () => {
	let db: TestDb;
	let seed: Seed;
	beforeAll(async () => {
		db = await makePostgres();
		seed = await seedTwoOrgs(db);
	}, 60_000);
	afterAll(async () => {
		await db.stop();
	});

	it('never lets a concurrent runtime read see zero rows while the policies are renewed', async () => {
		// BEGIN and COMMIT must share one connection
		const client = await db.ownerPool.connect();
		const executor = {
			exec: async (s: string) => void (await client.query(s)),
			query: async <T extends Record<string, unknown>>(s: string, p?: unknown[]) =>
				(await client.query(s, p)).rows as T[]
		};
		let running = true;
		let reads = 0;
		const empty: number[] = [];
		const reader = (async () => {
			while (running) {
				const rows = await withTenant(db, { orgId: seed.orgA }, (tx) => tx.select().from(project));
				reads++;
				if (rows.length === 0) empty.push(reads);
			}
		})();
		try {
			for (let i = 0; i < 15; i++) await secure(executor);
		} finally {
			running = false;
			await reader;
			client.release();
		}
		expect(reads).toBeGreaterThan(0);
		expect(empty).toEqual([]);
	}, 60_000);

	it('rolls back and fails loudly when a statement fails, leaving the old policies in place', async () => {
		const client = await db.ownerPool.connect();
		let calls = 0;
		const executor = {
			exec: async (s: string) => {
				calls++;
				// Fail the third statement, inside the transaction
				if (calls === 4) throw new Error('boom');
				await client.query(s);
			},
			query: async <T extends Record<string, unknown>>(s: string, p?: unknown[]) =>
				(await client.query(s, p)).rows as T[]
		};
		try {
			await expect(secure(executor)).rejects.toThrow(/security statements failed/);
		} finally {
			client.release();
		}
		const rows = await withTenant(db, { orgId: seed.orgA }, (tx) => tx.select().from(project));
		expect(rows.length).toBeGreaterThan(0);
	}, 60_000);
});
