// A TINY SQL EXECUTOR SO MIGRATIONS AND ROW LEVEL SECURITY SETUP DO NOT DEPEND ON A DRIVER

// -- TYPES -- //

export interface SqlExecutor {
	/** Runs one or more statements with no parameters. */
	exec(sql: string): Promise<void>;
	/** Runs one statement and returns its rows. */
	query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

// -- FUNCTIONS -- //

export function pgExecutor(client: {
	query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}): SqlExecutor {
	return {
		exec: async (sql) => {
			await client.query(sql);
		},
		query: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]) =>
			(await client.query(sql, params)).rows as T[]
	};
}
