// MIGRATION RUNNER. APPLIES THE DRIZZLE SQL FILES IN ORDER AS THE OWNER, THEN THE ROLES, GRANTS AND ROW LEVEL SECURITY.

// IMPORTED TYPES
import type { SqlExecutor } from './executor';
// IMPORTED DEP-MODULES
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// IMPORTED MODULES
import { securityStatements } from './security';

// -- CONSTANTS -- //

export const MIGRATIONS_DIR = join(process.cwd(), 'src', 'lib', 'server', 'db', 'migrations');
/** How long a migration or the security statements may wait for a table lock. */
const LOCK_TIMEOUT = '5s';

// -- FUNCTIONS -- //

type Journal = { entries: { tag: string; when: number }[] };

/**
 * Runs every migration that has not run yet, each in its own transaction, then the security statements.
 * Returns the tags it applied. A migration file that changed after it ran is refused loudly.
 */
export async function migrate(db: SqlExecutor, dir = MIGRATIONS_DIR): Promise<string[]> {
	await db.exec(
		`CREATE TABLE IF NOT EXISTS "__afb_migrations" (tag text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`
	);
	// The hash of the security statements last applied, so a start with nothing new does not take table locks again
	await db.exec(
		`CREATE TABLE IF NOT EXISTS "__afb_security" (id int PRIMARY KEY DEFAULT 1 CHECK (id = 1), hash text NOT NULL)`
	);
	const journal = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')) as Journal;
	const done = new Map(
		(await db.query<{ tag: string; hash: string }>(`SELECT tag, hash FROM "__afb_migrations"`)).map(
			(r) => [r.tag, r.hash]
		)
	);
	const applied: string[] = [];
	for (const { tag } of journal.entries) {
		const file = readFileSync(join(dir, `${tag}.sql`), 'utf8');
		const hash = createHash('sha256').update(file).digest('hex');
		const seen = done.get(tag);
		if (seen) {
			if (seen !== hash)
				throw new Error(
					`Migration ${tag} changed after it was applied. Write a new migration instead.`
				);
			continue;
		}
		const statements = file
			.split('--> statement-breakpoint')
			.map((s) => s.trim())
			.filter(Boolean);
		await db.exec('BEGIN');
		try {
			// A table lock that cannot be had in time (a backup holds a long transaction) fails the migration instead of queueing every query behind it
			await db.exec(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
			for (const s of statements) await db.exec(s);
			await db.query(`INSERT INTO "__afb_migrations" (tag, hash) VALUES ($1, $2)`, [tag, hash]);
			await db.exec('COMMIT');
		} catch (e) {
			await db.exec('ROLLBACK');
			throw new Error(`Migration ${tag} failed: ${e instanceof Error ? e.message : String(e)}`, {
				cause: e
			});
		}
		applied.push(tag);
	}
	// The security statements take an exclusive lock on every table until they commit, so they run only when something could have changed:
	// a migration ran (a new table or sequence needs its policy and grants) or the statements themselves changed. Every other start skips
	// them, which also keeps a restarting app from queueing queries behind those locks while the old app serves.
	if (applied.length === 0) {
		const [row] = await db.query<{ hash: string }>(`SELECT hash FROM "__afb_security"`);
		if (row?.hash === securityHash()) return applied;
	}
	await secure(db);
	return applied;
}

/** A fingerprint of the security statements, stored after they are applied. */
function securityHash(): string {
	return createHash('sha256').update(securityStatements().join(';\n')).digest('hex');
}

/** Roles, grants and forced row level security. Safe to run again, and run after every migration. */
export async function secure(db: SqlExecutor): Promise<void> {
	// ONE TRANSACTION, so a policy is never missing: a statement by statement run dropped each policy before creating it again, and for
	// that moment forced row level security let the runtime role read no rows and write none. Queries now wait for the commit instead.
	// A lock that cannot be had in 5 seconds (a long backup transaction) fails loudly and rolls back with the old policies intact.
	await db.exec('BEGIN');
	try {
		await db.exec(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
		for (const s of securityStatements()) await db.exec(s);
		// Remembered in the same transaction, so the hash is stored only if every statement was applied
		await db.query(
			`INSERT INTO "__afb_security" (id, hash) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET hash = EXCLUDED.hash`,
			[securityHash()]
		);
		await db.exec('COMMIT');
	} catch (e) {
		await db.exec('ROLLBACK');
		throw new Error(
			`The security statements failed: ${e instanceof Error ? e.message : String(e)}`,
			{
				cause: e
			}
		);
	}
}
