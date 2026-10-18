// TEST DATABASES: A FRESH DATABASE ON THE ONE EMBEDDED POSTGRESQL SERVER OF THE RUN, CLONED FROM A MIGRATED TEMPLATE
// The server and the template are made once by globalSetup.ts. A test file gets its own database with a copy of the template, so
// the migrations never run again and files cannot see each other's rows. The owner is NOT a superuser, so forced row level
// security binds it exactly like production (ADR-021); `admin` is the superuser, for seeding rows across orgs.

// -- DEP-TYPES -- //
import type { DbHandle } from '../../src/lib/server/db/client';
// -- DEP-MODULES -- //
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
// -- MODULES -- //
import { createPostgres } from '../../src/lib/server/db/client';
// -- CONSTANTS -- //
import { TEMPLATE } from './globalSetup';

// -- TYPES -- //

export type TestDb = DbHandle & {
	kind: 'postgres';
	/** A connection as the owner role, for proving the owner is bound by row level security. */
	ownerPool: pg.Pool;
	/** A superuser connection for seeding rows across orgs. */
	admin: DbHandle['owner'];
	/** The name of this database on the shared server. */
	name: string;
	/** Connection strings to this database as the app's runtime role, the owner and the superuser, for a program started from a test. */
	urls: { runtime: string; owner: string; admin: string };
	stop(): Promise<void>;
};

// -- FUNCTIONS -- //

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** PostgreSQL copies a template one clone at a time, so a clone that meets another one in progress waits and tries again. */
async function cloneTemplate(root: pg.Pool, name: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await root.query(`CREATE DATABASE "${name}" TEMPLATE ${TEMPLATE} OWNER afb_owner`);
			return;
		} catch (e) {
			if ((e as { code?: string }).code !== '55006' || attempt >= 60) throw e;
			await sleep(100 + Math.random() * 300);
		}
	}
}

export async function makePostgres(): Promise<TestDb> {
	const { port } = inject('afbPg');
	const name = `afb_${randomBytes(6).toString('hex')}`;
	const url = (user: string, password: string, database = name) =>
		`postgres://${user}:${password}@localhost:${port}/${database}`;
	const root = new pg.Pool({ connectionString: url('postgres', 'pw', 'postgres'), max: 1 });
	try {
		await cloneTemplate(root, name);
	} finally {
		await root.end();
	}
	const adminPool = new pg.Pool({ connectionString: url('postgres', 'pw'), max: 2 });
	const ownerPool = new pg.Pool({ connectionString: url('afb_owner', 'own'), max: 2 });
	const handle = await createPostgres({
		ownerUrl: url('afb_owner', 'own'),
		runtimeUrl: url('app_runtime', 'rt')
	});
	return {
		...handle,
		kind: 'postgres',
		name,
		urls: {
			runtime: url('app_runtime', 'rt'),
			owner: url('afb_owner', 'own'),
			admin: url('postgres', 'pw')
		},
		owner: {
			exec: async (s: string) => void (await ownerPool.query(s)),
			query: async <T extends Record<string, unknown>>(s: string, p?: unknown[]) =>
				(await ownerPool.query(s, p)).rows as T[]
		},
		ownerPool,
		admin: {
			exec: async (s: string) => void (await adminPool.query(s)),
			query: async <T extends Record<string, unknown>>(s: string, p?: unknown[]) =>
				(await adminPool.query(s, p)).rows as T[]
		},
		stop: async () => {
			await handle.close();
			await ownerPool.end();
			await adminPool.end();
			// The clone is dropped so a long run does not keep every database; the server goes away with the run anyway
			const drop = new pg.Pool({ connectionString: url('postgres', 'pw', 'postgres'), max: 1 });
			try {
				await drop.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
			} catch {
				/* The server removes everything when the run ends */
			} finally {
				await drop.end();
			}
		}
	};
}

// -- SEED -- //

export type Seed = {
	orgA: string;
	orgB: string;
	projectA: string;
	projectA2: string;
	projectB: string;
	itemA: string;
	itemB: string;
};

/** Two orgs, each with a project and an item, plus a second project in org A. Written as a superuser, which bypasses row level security. */
export async function seedTwoOrgs(db: TestDb): Promise<Seed> {
	const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
	const s: Seed = {
		orgA: id(1),
		orgB: id(2),
		projectA: id(11),
		projectA2: id(12),
		projectB: id(21),
		itemA: id(101),
		itemB: id(201)
	};
	const a = db.admin;
	await a.exec(
		`INSERT INTO "user" (id, name, email) VALUES ('u-a', 'Ana', 'ana@a.example'), ('u-b', 'Ben', 'ben@b.example') ON CONFLICT DO NOTHING`
	);
	await a.exec(
		`INSERT INTO org (id, name, slug) VALUES ('${s.orgA}', 'Org A', 'a'), ('${s.orgB}', 'Org B', 'b')`
	);
	await a.exec(
		`INSERT INTO member (org_id, user_id, role) VALUES ('${s.orgA}', 'u-a', 'owner'), ('${s.orgB}', 'u-b', 'owner')`
	);
	await a.exec(
		`INSERT INTO project (id, org_id, key, name) VALUES ('${s.projectA}', '${s.orgA}', 'AAA', 'A one'), ('${s.projectA2}', '${s.orgA}', 'AAB', 'A two'), ('${s.projectB}', '${s.orgB}', 'BBB', 'B one')`
	);
	await a.exec(
		`INSERT INTO item (id, org_id, project_id, number, ref, title) VALUES ('${s.itemA}', '${s.orgA}', '${s.projectA}', 1, 'AAA-1', 'Item of A'), ('${id(102)}', '${s.orgA}', '${s.projectA2}', 1, 'AAB-1', 'Second project of A'), ('${s.itemB}', '${s.orgB}', '${s.projectB}', 1, 'BBB-1', 'Item of B')`
	);
	// Seeded items already use number 1, so the counters start at 2 (an importer must do the same)
	await a.exec(
		`INSERT INTO project_counter (project_id, org_id, next) VALUES ('${s.projectA}', '${s.orgA}', 2), ('${s.projectA2}', '${s.orgA}', 2), ('${s.projectB}', '${s.orgB}', 2)`
	);
	return s;
}
