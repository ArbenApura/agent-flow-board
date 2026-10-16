// THE APP'S DATABASE HANDLE. A REAL POSTGRESQL SERVER WHEN DATABASE_URL IS SET, OTHERWISE A LOCAL PGLITE FOLDER.

// -- TYPES -- //
import type { DbHandle } from './client';
// -- ENVS -- //
import { AFB_AUTO_MIGRATE, AFB_DB_DIR, DATABASE_OWNER_URL, DATABASE_URL } from '$app/env/private';
// -- MODULES -- //
import { currentPlatform, requestScoped } from '../platform';
import { createPglite, createPostgres } from './client';
import { migrate } from './migrate';

// -- STATES -- //

// Kept on globalThis so a hot reload of this module in development reuses the open connections. A new handle for each reload
// leaked a few connections every time and ended in "max clients reached" on a session pooler such as Supabase's
const shared = globalThis as typeof globalThis & { __afbDb?: Promise<DbHandle> };

// -- FUNCTIONS -- //

async function open(): Promise<DbHandle> {
	if (DATABASE_URL) {
		const owner = DATABASE_OWNER_URL ?? DATABASE_URL;
		// A URL that already logs in as app_runtime needs no role switch in each transaction, which saves a round trip every time
		const loginIsRuntime =
			!DATABASE_OWNER_URL && new URL(DATABASE_URL).username.startsWith('app_runtime');
		const h = await createPostgres({
			runtimeUrl: DATABASE_OWNER_URL ? DATABASE_URL : undefined,
			ownerUrl: owner,
			...(loginIsRuntime ? { switchRole: false, poolMax: 5 } : {})
		});
		if (AFB_AUTO_MIGRATE) await migrate(h.owner);
		return h;
	}
	// Local development and previews. Nothing here is a deployment.
	// AFB_DB_DIR=memory keeps the database in memory, so every start is a clean one (checks)
	const h = await createPglite(AFB_DB_DIR === 'memory' ? undefined : (AFB_DB_DIR ?? '.afb/dev-db'));
	if (AFB_AUTO_MIGRATE) await migrate(h.owner);
	return h;
}

/**
 * One handle per server process, opened on first use. On a Worker, a handle for the current request over Hyperdrive, which does
 * the pooling: a pool made in one request cannot be used by another, so each request makes its own with a single connection.
 */
export function getDb(): Promise<DbHandle> {
	const hyperdrive = currentPlatform()?.env.HYPERDRIVE as { connectionString: string } | undefined;
	if (hyperdrive)
		return requestScoped('db', () =>
			createPostgres({
				runtimeUrl: hyperdrive.connectionString,
				ownerUrl: hyperdrive.connectionString,
				poolMax: 1,
				listen: async () => {
					throw new Error(
						'A Worker hears about changes from the hub binding, not from the database.'
					);
				}
			})
		);
	shared.__afbDb ??= open();
	return shared.__afbDb;
}
