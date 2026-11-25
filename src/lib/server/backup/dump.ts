// READING ONE ORG OUT OF THE DATABASE AND ITS FILES INTO BACKUP FRAMES (SPEC 8)
// Tables come from the tenant table registry, so a new tenant table is backed up without anyone remembering to add it.
// Parents are written before children, and the columns each table had are recorded so a restore can match them.

// IMPORTED TYPES
import type { Storage } from '../adapters/storage';
import type { Admin } from './admin';
import type { Frame } from './archive';
// IMPORTED DEP-MODULES
import { createHash } from 'node:crypto';
// IMPORTED MODULES
import { TENANT_TABLES } from '../db/schema';

// -- TYPES -- //

export type TableMeta = { count: number; columns: string[] };
export type BackupMeta = {
	format: 'afb-backup';
	version: 1;
	orgId: string;
	orgSlug: string;
	createdAt: string;
	/** The migrations the database had, so a restore refuses a database of another shape. */
	migrations: string[];
	tables: Record<string, TableMeta>;
	files: number;
	/** Files an attachment row names that the storage did not hold. Trashed attachments are not counted. */
	missingFiles: string[];
};

// -- CONSTANTS -- //

/** Counters and idempotency records that are worthless after a restore. */
// The deletion log is about the org but outlives it, so a backup of the org never carries it
// session_file holds which files a live session edited in the last day: short-lived, never worth restoring (AFB-20261125-1527)
const SKIP = new Set(['rate_bucket', 'request_log', 'org_deletion_log', 'session_file']);
const PAGE = 500;

// -- FUNCTIONS -- //

const bare = (regclass: string) => regclass.replace(/^public\./, '').replace(/^"|"$/g, '');

/** Parents before children, from the foreign keys of the live database. */
export async function tableOrder(db: Admin, tables: string[]): Promise<string[]> {
	const fks = await db.query<{ child: string; parent: string }>(
		`select conrelid::regclass::text as child, confrelid::regclass::text as parent from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace`
	);
	const set = new Set(tables);
	const parents = new Map<string, Set<string>>(tables.map((t) => [t, new Set()]));
	for (const f of fks) {
		const c = bare(f.child);
		const p = bare(f.parent);
		if (c !== p && set.has(c) && set.has(p)) parents.get(c)!.add(p);
	}
	const out: string[] = [];
	const done = new Set<string>();
	const visit = (t: string, path: string[]) => {
		if (done.has(t)) return;
		if (path.includes(t)) return; // A cycle is left to the database to accept, rows reference each other lazily
		for (const p of parents.get(t) ?? []) visit(p, [...path, t]);
		done.add(t);
		out.push(t);
	};
	for (const t of [...tables].sort()) visit(t, []);
	return out;
}

/** The columns a table can be restored into: not generated, in order. */
export async function writableColumns(db: Admin, table: string): Promise<string[]> {
	const rows = await db.query<{ column_name: string }>(
		`select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 and is_generated = 'NEVER' order by ordinal_position`,
		[table]
	);
	return rows.map((r) => r.column_name);
}

/**
 * What selects an org's rows from each table. Users and their sign in records come through membership, and through every
 * column of the org's own rows that points at a user (an assignee who has since left, an inviter, a revoked token's owner), so
 * a restore into an empty database finds every person a row names.
 */
function scopeOf(table: string, orgColumn: string, userRefs: string[]): string {
	const people = [`select "user_id" from "member" where "org_id" = $1`, ...userRefs].join(
		' union '
	);
	if (table === 'user') return `"id" in (${people})`;
	if (table === 'auth_account') return `"user_id" in (${people})`;
	return `"${orgColumn}" = $1`;
}

/** One select for each column of a table in this backup that points at the user table. */
async function userReferences(db: Admin, registry: Map<string, string>): Promise<string[]> {
	const rows = await db.query<{ tbl: string; col: string }>(
		`select c.conrelid::regclass::text as tbl, a.attname as col
		   from pg_constraint c
		   join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
		  where c.contype = 'f' and c.confrelid = '"user"'::regclass`
	);
	const out: string[] = [];
	for (const r of rows) {
		const table = r.tbl.replace(/^"|"$/g, '').replace(/^public\./, '');
		const orgColumn = registry.get(table);
		if (!orgColumn || table === 'user' || table === 'auth_account' || table === 'member') continue;
		if (orgColumn === 'id' || orgColumn === 'user_id') continue;
		out.push(
			`select "${r.col}" from "${table}" where "${orgColumn}" = $1 and "${r.col}" is not null`
		);
	}
	return out;
}

/** The sha256 of a stored file, read as a stream, or null when the file is not there. */
async function checksumOf(storage: Storage, key: string): Promise<string | null> {
	const stream = await storage.getStream(key);
	if (!stream) return null;
	const hash = createHash('sha256');
	for await (const chunk of stream) hash.update(chunk);
	return hash.digest('hex');
}

/** Another export of the same org is already running, so this one steps aside. */
export class BackupBusyError extends Error {
	constructor(orgId: string) {
		super(`A backup of ${orgId} is already running.`);
		this.name = 'BackupBusyError';
	}
}

type FileEntry = { key: string; mime: string; checksum: string | null; deletedAt: string | null };

/**
 * Exports one org as a stream of frames and hands them to `consume`, all inside ONE repeatable read transaction that is closed
 * whatever `consume` does, so the connection is always released. Memory stays flat: pass 1 counts the rows and checks every file
 * once (one file at a time) to build the header and to fail before anything is written, and pass 2 yields one frame at a time.
 * Read through a consistent view where the server gives one. `lock` makes a second export of the same org step aside.
 */
export async function exportOrgTo<T>(
	db: Admin,
	storage: Storage | null,
	orgId: string,
	now: Date,
	consume: (meta: BackupMeta, frames: AsyncGenerator<Frame>) => Promise<T>,
	options: { lock?: boolean } = {}
): Promise<T> {
	const [org] = await db.query<{ slug: string }>(`select "slug" from "org" where "id" = $1`, [
		orgId
	]);
	if (!org) throw new Error(`No organisation ${orgId}`);
	const registry = new Map<string, string>(
		TENANT_TABLES.filter((t) => !SKIP.has(t.name)).map((t) => [t.name, t.orgColumn])
	);
	registry.set('user', 'id');
	registry.set('auth_account', 'user_id');
	const order = await tableOrder(db, [...registry.keys()]);
	const migrations = (
		await db.query<{ tag: string }>(
			`select "tag" from "__afb_migrations" order by "applied_at", "tag"`
		)
	).map((r) => r.tag);
	return db.tx(async (q) => {
		await q.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ').catch(() => undefined);
		// The transaction sits idle while a big file is written, so no idle timeout may cut it short
		await q.exec('SET LOCAL idle_in_transaction_session_timeout = 0').catch(() => undefined);
		if (options.lock) {
			const [got] = await q
				.query<{ ok: boolean }>(
					`select pg_try_advisory_xact_lock(hashtext('afb-backup'), hashtext($1)) as ok`,
					[orgId]
				)
				.catch(() => [{ ok: true }]);
			if (!got?.ok) throw new BackupBusyError(orgId);
		}
		const userRefs = await userReferences(q, registry);
		// -- PASS 1: THE HEADER -- //
		const tables: Record<string, TableMeta> = {};
		const scopes = new Map<string, { list: string; scope: string }>();
		for (const name of order) {
			const columns = await writableColumns(q, name);
			if (!columns.length) continue;
			const list = columns.map((c) => `"${c}"`).join(', ');
			const scope = scopeOf(name, registry.get(name)!, userRefs);
			const [counted] = await q.query<{ n: number | string }>(
				`select count(*) as n from "${name}" where ${scope}`,
				[orgId]
			);
			tables[name] = { count: Number(counted?.n ?? 0), columns };
			scopes.set(name, { list, scope });
		}
		const entries: FileEntry[] = [];
		const missing: string[] = [];
		if (storage) {
			const files = await q.query<{
				storage_key: string;
				mime: string;
				size: string;
				checksum: string;
				deleted_at: string | null;
			}>(
				`select "storage_key", "mime", "size", "checksum", "deleted_at" from "attachment" where "org_id" = $1 order by "id"`,
				[orgId]
			);
			// Mockup files (versions, the version screenshot, kits, parts) are stored files too. Screenshots and kits carry no saved
			// checksum, so one is taken now. The drawn shots and rendered trees of a version (derived.shots and derived.trees) are
			// left out on purpose: the bridge draws them from the version HTML, they grew 100 to 200 MB a day and made every nightly
			// archive larger (2026-11-20), and a read that finds one missing already skips it
			const mockupFiles = await q.query<{
				storage_key: string;
				mime: string;
				size: string | null;
				checksum: string | null;
				deleted_at: string | null;
			}>(
				`select "storage_key", 'text/html' as "mime", "size", "checksum", null as "deleted_at" from "mockup_version" where "org_id" = $1
				 union all select "screenshot_key", 'image/png', null, null, null from "mockup_version" where "org_id" = $1 and "screenshot_key" is not null
				 union all select "storage_key", 'text/html', "size", null, null from "mockup_kit" where "org_id" = $1
				 union all select "storage_key", "mime", "size", "checksum", null from "mockup_kit_asset" where "org_id" = $1
				 union all select "storage_key", 'text/plain', "size", "checksum", null from "mockup_part" where "org_id" = $1
				 union all select "storage_key", "mime", "size", "checksum", null from "note_file" where "org_id" = $1
				 order by 1`,
				[orgId]
			);
			for (const f of [...files, ...mockupFiles]) {
				// The file is read as a stream and hashed, so checking even a large file holds none of it
				const sum = await checksumOf(storage, f.storage_key);
				if (sum === null) {
					// A file in the trash may already be gone, a live one missing is data loss and is reported
					if (!f.deleted_at) missing.push(f.storage_key);
					continue;
				}
				// Stored bytes that no longer match what was saved are damage, and a backup of damage is not a backup
				if (f.checksum && sum !== f.checksum) {
					if (!f.deleted_at) missing.push(`${f.storage_key} (damaged)`);
					continue;
				}
				entries.push({
					key: f.storage_key,
					mime: f.mime,
					checksum: f.checksum,
					deletedAt: f.deleted_at
				});
			}
		}
		const meta: BackupMeta = {
			format: 'afb-backup',
			version: 1,
			orgId,
			orgSlug: org.slug,
			createdAt: now.toISOString(),
			migrations,
			tables,
			files: entries.length,
			missingFiles: missing
		};
		// -- PASS 2: THE FRAMES, ONE AT A TIME -- //
		async function* frames(): AsyncGenerator<Frame> {
			yield { type: 'meta', json: meta };
			for (const [name, { list, scope }] of scopes) {
				for (let offset = 0; ; offset += PAGE) {
					const rows = await q.query<{ j: unknown }>(
						`select to_jsonb(r) as j from (select ${list} from "${name}" where ${scope} order by 1 limit ${PAGE} offset ${offset}) r`,
						[orgId]
					);
					if (!rows.length) break;
					yield { type: 'table', json: { table: name, rows: rows.map((r) => r.j) } };
					if (rows.length < PAGE) break;
				}
			}
			for (const f of entries) {
				const bytes = await storage!.get(f.key);
				if (!bytes)
					throw new Error(`The file ${f.key} disappeared while the backup was being written.`);
				const sum = createHash('sha256').update(bytes).digest('hex');
				// A file with a saved checksum must still match it. One without (screenshots, kits) takes what is read now as the truth
				if (f.checksum && sum !== f.checksum)
					throw new Error(`The file ${f.key} changed while the backup was being written.`);
				yield {
					type: 'file',
					json: { key: f.key, mime: f.mime, size: bytes.length, checksum: sum },
					bytes
				};
			}
		}
		const stream = frames();
		try {
			return await consume(meta, stream);
		} finally {
			// A consumer that stopped early must not leave the generator suspended
			await stream.return(undefined);
		}
	});
}

/** Every frame of one org held in memory: its tables, then its attachment files. For small orgs and tests; a backup streams instead. */
export async function exportOrg(
	db: Admin,
	storage: Storage | null,
	orgId: string,
	now = new Date()
): Promise<{ frames: Frame[]; meta: BackupMeta }> {
	return exportOrgTo(db, storage, orgId, now, async (meta, stream) => {
		const frames: Frame[] = [];
		for await (const f of stream) frames.push(f);
		return { frames, meta };
	});
}
