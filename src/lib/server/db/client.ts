// DATABASE CLIENTS. POSTGRESQL ON A VPS OR SUPABASE (pg POOL), HYPERDRIVE ON CLOUDFLARE (SAME pg DRIVER), PGLITE FOR LOCAL DEVELOPMENT AND TESTS.

// -- DEP-TYPES -- //
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
// -- DEP-MODULES -- //
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import pg from 'pg';
// -- MODULES -- //
import * as schema from './schema';
import { pgExecutor, pgliteExecutor, type SqlExecutor } from './executor';

// -- TYPES -- //

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbHandle = {
	db: Db;
	/** For migrations and setup, run as the owner. */
	owner: SqlExecutor;
	/**
	 * True when this connection is a superuser or the owner, so each transaction must switch to the runtime role
	 * (PGlite is always like this). False when the connection already logs in as app_runtime.
	 */
	switchRole: boolean;
	/** Listens to a NOTIFY channel on a connection of its own. Returns the function that stops listening. */
	listen(channel: string, onMessage: (payload: string) => void): Promise<() => Promise<void>>;
	close(): Promise<void>;
};

// -- FUNCTIONS -- //

/**
 * LISTEN on a dedicated connection taken from the pool. When that connection drops it is replaced after a second and the
 * listener is told with an empty payload, so a page that missed changes refetches instead of trusting a silent gap.
 */
async function listenOnPool(
	pool: pg.Pool,
	channel: string,
	onMessage: (payload: string) => void
): Promise<() => Promise<void>> {
	// The name goes into a LISTEN statement, which cannot take a parameter
	if (!/^[a-z_]{1,40}$/.test(channel)) throw new Error('Invalid channel name');
	let stopped = false;
	let client: pg.PoolClient | null = null;
	const connect = async (): Promise<void> => {
		if (stopped) return;
		try {
			const c = await pool.connect();
			client = c;
			c.on('notification', (m) => {
				if (m.channel === channel) onMessage(m.payload ?? '');
			});
			const lost = () => {
				if (client === c) client = null;
				c.removeAllListeners('notification');
				c.release(true);
				if (!stopped) setTimeout(() => void connect(), 1000).unref?.();
				onMessage('');
			};
			c.once('error', lost);
			c.once('end', lost);
			await c.query(`LISTEN ${channel}`);
		} catch {
			client = null;
			if (!stopped) setTimeout(() => void connect(), 1000).unref?.();
		}
	};
	await connect();
	return async () => {
		stopped = true;
		const c = client;
		client = null;
		if (c) {
			c.removeAllListeners();
			try {
				await c.query(`UNLISTEN ${channel}`);
			} catch {
				/* The connection is already gone */
			}
			c.release(true);
		}
	};
}

/** PGlite, in memory or in a folder. One connection, so concurrent work queues. */
export async function createPglite(dataDir?: string): Promise<DbHandle> {
	// Loaded here and not at the top, so a server that uses PostgreSQL (and a Worker) never loads the WebAssembly database
	const [{ PGlite }, { drizzle: drizzlePglite }] = await Promise.all([
		import('@electric-sql/pglite'),
		import('drizzle-orm/pglite')
	]);
	const client = new PGlite(dataDir);
	await client.waitReady;
	return {
		db: drizzlePglite(client, { schema }) as unknown as Db,
		owner: pgliteExecutor(client),
		switchRole: true,
		listen: async (channel, onMessage) => {
			const stop = await client.listen(channel, onMessage);
			return async () => {
				await stop();
			};
		},
		close: () => client.close()
	};
}

/**
 * A real PostgreSQL connection pool. `runtimeUrl` logs in as app_runtime. `ownerUrl` is used only for migrations
 * and setup and may be omitted at runtime. Without a runtime URL the owner connection switches role per transaction.
 */
export async function createPostgres(options: {
	runtimeUrl?: string;
	ownerUrl: string;
	/** Connections the pool may hold. A Worker uses 1 for each request, because Hyperdrive does the pooling. */
	poolMax?: number;
	/** Replaces LISTEN, for a platform where the database cannot notify (Hyperdrive). */
	listen?: DbHandle['listen'];
}): Promise<DbHandle> {
	const ownerPool = new pg.Pool({ connectionString: options.ownerUrl, max: options.poolMax ?? 2 });
	const runtimePool = options.runtimeUrl
		? new pg.Pool({ connectionString: options.runtimeUrl, max: options.poolMax ?? 10 })
		: ownerPool;
	return {
		db: drizzlePg(runtimePool, { schema }) as unknown as Db,
		owner: pgExecutor(ownerPool),
		switchRole: !options.runtimeUrl,
		listen:
			options.listen ?? ((channel, onMessage) => listenOnPool(runtimePool, channel, onMessage)),
		close: async () => {
			if (runtimePool !== ownerPool) await runtimePool.end();
			await ownerPool.end();
		}
	};
}
