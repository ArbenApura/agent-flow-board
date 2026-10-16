// MIGRATION RUNNER. APPLIES THE DRIZZLE SQL FILES IN ORDER AS THE OWNER, THEN THE ROLES, GRANTS AND ROW LEVEL SECURITY.

// -- TYPES -- //
import type { SqlExecutor } from './executor';
// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { securityStatements } from './security';

// -- CONSTANTS -- //

export const MIGRATIONS_DIR = join(process.cwd(), 'src', 'lib', 'server', 'db', 'migrations');

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
	await secure(db);
	return applied;
}

/** Roles, grants and forced row level security. Safe to run again, and run after every migration. */
export async function secure(db: SqlExecutor): Promise<void> {
	for (const s of securityStatements()) await db.exec(s);
}
