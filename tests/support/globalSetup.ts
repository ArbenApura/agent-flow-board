// ONE EMBEDDED POSTGRESQL SERVER FOR THE WHOLE TEST RUN, WITH A MIGRATED TEMPLATE DATABASE EVERY TEST FILE CLONES
// It runs the migrations as a NON-SUPERUSER owner and the app as a separate login role, exactly like production, so forced row
// level security is tested where PostgreSQL really applies it (ADR-021). Starting the server and migrating cost several seconds,
// so both happen once here; a test file then gets its own database in a fraction of a second (see makePostgres in db.ts).

// -- TYPES -- //
import type { TestProject } from 'vitest/node';
// -- DEP-MODULES -- //
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
// -- MODULES -- //
import { migrate } from '../../src/lib/server/db/migrate';

// -- TYPES -- //

declare module 'vitest' {
	export interface ProvidedContext {
		/** The port of the shared embedded PostgreSQL server of this run. */
		afbPg: { port: number };
	}
}

// -- CONSTANTS -- //

export const TEMPLATE = 'afb_template';

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

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
	const dir = mkdtempSync(join(tmpdir(), 'afb-pg-'));
	const port = await freePort();
	const server = new EmbeddedPostgres({
		databaseDir: dir,
		user: 'postgres',
		password: 'pw',
		port,
		persistent: false,
		// Test data never needs to survive a crash, so the server skips the disk syncs. Every test file keeps its own pools open
		// at once, so the connection limit is raised well above the default of 100.
		postgresFlags: [
			'-c',
			'max_connections=1000',
			'-c',
			'fsync=off',
			'-c',
			'synchronous_commit=off',
			'-c',
			'full_page_writes=off'
		],
		onLog: () => {},
		onError: () => {}
	});
	await server.initialise();
	await server.start();

	const url = (user: string, password: string, database: string) =>
		`postgres://${user}:${password}@localhost:${port}/${database}`;
	const root = new pg.Pool({ connectionString: url('postgres', 'pw', 'postgres'), max: 1 });
	await root.query(`CREATE ROLE afb_owner LOGIN CREATEROLE PASSWORD 'own'`);
	await root.query(`CREATE DATABASE ${TEMPLATE} OWNER afb_owner`);
	await root.end();

	// The public schema belongs to the owner, who is NOT a superuser and so is bound by forced row level security
	const admin = new pg.Pool({ connectionString: url('postgres', 'pw', TEMPLATE), max: 1 });
	await admin.query(`ALTER SCHEMA public OWNER TO afb_owner`);
	const owner = new pg.Pool({ connectionString: url('afb_owner', 'own', TEMPLATE), max: 1 });
	// Migrations run on a single connection so BEGIN and COMMIT share a session
	const client = await owner.connect();
	await migrate({
		exec: async (s) => void (await client.query(s)),
		query: async <T extends Record<string, unknown>>(s: string, p?: unknown[]) =>
			(await client.query(s, p)).rows as T[]
	});
	client.release();
	// The role belongs to the whole server, so its login is set once here and every clone inherits it
	await admin.query(`ALTER ROLE app_runtime LOGIN PASSWORD 'rt'`);
	// CREATE DATABASE ... TEMPLATE refuses a template that still has a connection, so every pool is closed before any clone
	await owner.end();
	await admin.end();

	project.provide('afbPg', { port });

	return async () => {
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
	};
}
