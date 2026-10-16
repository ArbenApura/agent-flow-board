// TEST DATABASES: PGLITE (FAST, ONE CONNECTION) AND A REAL POSTGRESQL SERVER (EMBEDDED, SEVERAL CONNECTIONS)
// The real server runs the migrations as a NON-SUPERUSER owner and the app as a separate login role, exactly like production,
// so forced row level security is tested where PostgreSQL really applies it (ADR-021).

// -- DEP-TYPES -- //
import type { DbHandle } from '../../src/lib/server/db/client';
// -- DEP-MODULES -- //
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
// -- MODULES -- //
import { createPglite, createPostgres } from '../../src/lib/server/db/client';
import { migrate } from '../../src/lib/server/db/migrate';

// -- TYPES -- //

export type TestDb = DbHandle & {
	kind: 'pglite' | 'postgres';
	/** A connection as the owner role, for proving the owner is bound by row level security (real PostgreSQL only). */
	ownerPool?: pg.Pool;
	/** A superuser connection for seeding rows across orgs. */
	admin: DbHandle['owner'];
	stop(): Promise<void>;
};

// -- FUNCTIONS -- //

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.listen(0, () => {
			const port = (s.address() as { port: number }).port;
			s.close(() => resolve(port));
		});
		s.on('error', reject);
	});
}

export async function makePglite(): Promise<TestDb> {
	const handle = await createPglite();
	await migrate(handle.owner);
	return { ...handle, kind: 'pglite', admin: handle.owner, stop: () => handle.close() };
}

export async function makePostgres(): Promise<TestDb> {
	const dir = mkdtempSync(join(tmpdir(), 'afb-pg-'));
	const port = await freePort();
	const server = new EmbeddedPostgres({
		databaseDir: dir,
		user: 'postgres',
		password: 'pw',
		port,
		persistent: false,
		onLog: () => {},
		onError: () => {}
	});
	await server.initialise();
	await server.start();
	const root = new pg.Pool({
		host: 'localhost',
		port,
		user: 'postgres',
		password: 'pw',
		database: 'postgres',
		max: 2
	});
	await root.query(`CREATE ROLE afb_owner LOGIN CREATEROLE PASSWORD 'own'`);
	await root.query(`CREATE DATABASE afb OWNER afb_owner`);
	const url = (user: string, password: string) =>
		`postgres://${user}:${password}@localhost:${port}/afb`;
	// The public schema belongs to the owner, who is NOT a superuser and so is bound by forced row level security
	const adminPool = new pg.Pool({ connectionString: url('postgres', 'pw'), max: 2 });
	await adminPool.query(`ALTER SCHEMA public OWNER TO afb_owner`);
	const ownerPool = new pg.Pool({ connectionString: url('afb_owner', 'own'), max: 2 });
	const ownerExec = {
		exec: async (s: string) => void (await ownerPool.query(s)),
		query: async <T extends Record<string, unknown>>(s: string, p?: unknown[]) =>
			(await ownerPool.query(s, p)).rows as T[]
	};
	// Migrations run as a single connection so BEGIN and COMMIT share a session
	const migrationClient = await ownerPool.connect();
	await migrate({
		exec: async (s) => void (await migrationClient.query(s)),
		query: async <T extends Record<string, unknown>>(s: string, p?: unknown[]) =>
			(await migrationClient.query(s, p)).rows as T[]
	});
	migrationClient.release();
	await adminPool.query(`ALTER ROLE app_runtime LOGIN PASSWORD 'rt'`);
	const handle = await createPostgres({
		ownerUrl: url('afb_owner', 'own'),
		runtimeUrl: url('app_runtime', 'rt')
	});
	await root.end();
	return {
		...handle,
		kind: 'postgres',
		owner: ownerExec,
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
			// The server removes its own data folder when it stops, and on Windows that can briefly fail with EBUSY
			try {
				await server.stop();
			} catch (e) {
				if (!/EBUSY|EPERM/.test(String((e as Error).message))) throw e;
			}
			// The temp folder is cleaned on a best effort basis: on Windows the server can hold a file a moment longer
			try {
				rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
			} catch {
				/* The operating system removes the temp folder later */
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
