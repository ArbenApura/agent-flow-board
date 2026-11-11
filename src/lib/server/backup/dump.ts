// READING ONE ORG OUT OF THE DATABASE AND ITS FILES INTO BACKUP FRAMES (SPEC 8)
// Tables come from the tenant table registry, so a new tenant table is backed up without anyone remembering to add it.
// Parents are written before children, and the columns each table had are recorded so a restore can match them.

// -- TYPES -- //
import type { Storage } from '../adapters/storage';
import type { Admin } from './admin';
import type { Frame } from './archive';
// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
// -- MODULES -- //
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
const SKIP = new Set(['rate_bucket', 'request_log', 'org_deletion_log']);
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

/** Every frame of one org: its tables, then its attachment files. Read through a consistent view where the server gives one. */
export async function exportOrg(
	db: Admin,
	storage: Storage | null,
	orgId: string,
	now = new Date()
): Promise<{ frames: Frame[]; meta: BackupMeta }> {
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
		const tables: Record<string, TableMeta> = {};
		const tableFrames: Frame[] = [];
		const userRefs = await userReferences(q, registry);
		for (const name of order) {
			const columns = await writableColumns(q, name);
			if (!columns.length) continue;
			const list = columns.map((c) => `"${c}"`).join(', ');
			const scope = scopeOf(name, registry.get(name)!, userRefs);
			let count = 0;
			for (let offset = 0; ; offset += PAGE) {
				const rows = await q.query<{ j: unknown }>(
					`select to_jsonb(r) as j from (select ${list} from "${name}" where ${scope} order by 1 limit ${PAGE} offset ${offset}) r`,
					[orgId]
				);
				if (!rows.length) break;
				count += rows.length;
				tableFrames.push({ type: 'table', json: { table: name, rows: rows.map((r) => r.j) } });
				if (rows.length < PAGE) break;
			}
			tables[name] = { count, columns };
		}
		const fileFrames: Frame[] = [];
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
			// Mockup files (versions, screenshots, kits) are stored files too. Screenshots and kits carry no saved checksum, so one is taken now
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
				 union all select "storage_key", "mime", "size", "checksum", null from "note_file" where "org_id" = $1
				 order by 1`,
				[orgId]
			);
			for (const f of [...files, ...mockupFiles]) {
				const bytes = await storage.get(f.storage_key);
				if (!bytes) {
					// A file in the trash may already be gone, a live one missing is data loss and is reported
					if (!f.deleted_at) missing.push(f.storage_key);
					continue;
				}
				// Stored bytes that no longer match what was saved are damage, and a backup of damage is not a backup
				const sum = createHash('sha256').update(bytes).digest('hex');
				if (f.checksum && sum !== f.checksum) {
					if (!f.deleted_at) missing.push(`${f.storage_key} (damaged)`);
					continue;
				}
				fileFrames.push({
					type: 'file',
					json: { key: f.storage_key, mime: f.mime, size: bytes.length, checksum: sum },
					bytes
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
			files: fileFrames.length,
			missingFiles: missing
		};
		return { frames: [{ type: 'meta', json: meta }, ...tableFrames, ...fileFrames], meta };
	});
}
