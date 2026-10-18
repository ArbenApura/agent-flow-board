// THE DATABASE CLIENT: A POSTGRESQL CONNECTION POOL (pg) AND THE HANDLE THE APP, THE SCRIPTS AND THE TESTS SHARE.

// -- DEP-TYPES -- //
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
// -- DEP-MODULES -- //
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import pg from 'pg';
// -- MODULES -- //
import * as schema from './schema';
import { pgExecutor, type SqlExecutor } from './executor';

// -- TYPES -- //

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbHandle = {
	db: Db;
	/** For migrations and setup, run as the owner. */
	owner: SqlExecutor;
	/**
	 * True when this connection is a superuser or the owner, so each transaction must switch to the runtime role.
	 * False when the connection already logs in as app_runtime.
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

/**
 * A real PostgreSQL connection pool. `runtimeUrl` logs in as app_runtime. `ownerUrl` is used only for migrations
 * and setup and may be omitted at runtime. Without a runtime URL the owner connection switches role per transaction.
 */
export async function createPostgres(options: {
	runtimeUrl?: string;
	ownerUrl: string;
	/** Left out, the role is switched in each transaction when there is no runtime URL. Set false when the one URL already logs in as the runtime role. */
	switchRole?: boolean;
	/** Connections the pool may hold. */
	poolMax?: number;
}): Promise<DbHandle> {
	const ownerPool = new pg.Pool({ connectionString: options.ownerUrl, max: options.poolMax ?? 2 });
	const runtimePool = options.runtimeUrl
		? new pg.Pool({ connectionString: options.runtimeUrl, max: options.poolMax ?? 10 })
		: ownerPool;
	return {
		db: drizzlePg(runtimePool, { schema }) as unknown as Db,
		owner: pgExecutor(ownerPool),
		switchRole: options.switchRole ?? !options.runtimeUrl,
		listen: (channel, onMessage) => listenOnPool(runtimePool, channel, onMessage),
		close: async () => {
			if (runtimePool !== ownerPool) await runtimePool.end();
			await ownerPool.end();
		}
	};
}
