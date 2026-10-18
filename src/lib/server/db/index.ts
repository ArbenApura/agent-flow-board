// THE APP'S DATABASE HANDLE: THE POSTGRESQL SERVER IN DATABASE_URL. THE APP STOPS AT START WITHOUT IT.

// -- TYPES -- //
import type { DbHandle } from './client';
// -- ENVS -- //
import { AFB_AUTO_MIGRATE, DATABASE_OWNER_URL, DATABASE_URL } from '$app/env/private';
// -- MODULES -- //
import { createPostgres } from './client';
import { migrate } from './migrate';

// -- STATES -- //

// Kept on globalThis so a hot reload of this module in development reuses the open connections. A new handle for each reload
// leaked a few connections every time and ended in "max clients reached" on a server with a small connection limit
const shared = globalThis as typeof globalThis & { __afbDb?: Promise<DbHandle> };

// -- FUNCTIONS -- //

async function open(): Promise<DbHandle> {
	if (!DATABASE_URL)
		throw new Error(
			'DATABASE_URL is required: the PostgreSQL connection of the app as the app_runtime role (see .env.example).'
		);
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

/** One handle per server process, opened on first use. */
export function getDb(): Promise<DbHandle> {
	shared.__afbDb ??= open();
	return shared.__afbDb;
}
