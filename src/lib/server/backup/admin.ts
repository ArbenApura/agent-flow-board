// THE PRIVILEGED CONNECTION BACKUPS AND RESTORES USE. IT MUST BYPASS ROW LEVEL SECURITY, SO IT IS NEVER THE APP'S OWN CONNECTION.
// On a server that is a role made for the purpose (BYPASSRLS) given in DATABASE_BACKUP_URL. In tests the connection is the
// superuser of the embedded server. Nothing outside the backup code and the server command ever sees this.

// -- TYPES -- //
import type { SqlExecutor } from '../db/executor';
// -- DEP-MODULES -- //
import pg from 'pg';

// -- TYPES -- //

export interface Admin {
	query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
	exec(sql: string): Promise<void>;
	/** Runs `fn` as one transaction where the connection can hold one. */
	tx<T>(fn: (q: Admin) => Promise<T>): Promise<T>;
}

// -- FUNCTIONS -- //

/** An executor as an Admin. Without a dedicated connection a transaction is only the steps run in order. */
export function adminFromExecutor(executor: SqlExecutor): Admin {
	const admin: Admin = {
		query: (sql, params) => executor.query(sql, params),
		exec: (sql) => executor.exec(sql),
		tx: (fn) => fn(admin)
	};
	return admin;
}

/** A real server connection. Transactions use one connection from the pool, so they are real. */
export function pgAdmin(connectionString: string): Admin & { close(): Promise<void> } {
	const pool = new pg.Pool({ connectionString, max: 3 });
	const over = (client: { query: pg.Pool['query'] }): Admin => ({
		query: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]) =>
			(await client.query(sql, params as never)).rows as T[],
		exec: async (sql) => void (await client.query(sql)),
		tx: () => {
			throw new Error('Transactions do not nest');
		}
	});
	return {
		...over(pool),
		tx: async (fn) => {
			const client = await pool.connect();
			try {
				await client.query('BEGIN');
				const result = await fn(over(client as never));
				await client.query('COMMIT');
				return result;
			} catch (e) {
				await client.query('ROLLBACK').catch(() => undefined);
				throw e;
			} finally {
				client.release();
			}
		},
		close: () => pool.end()
	};
}
