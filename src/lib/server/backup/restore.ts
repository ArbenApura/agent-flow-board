// RESTORING ONE ORG FROM ITS BACKUP: INTO AN EMPTY DATABASE, OVER ITS OWN OLD ROWS, OR AFTER A CHECK IN A SCRATCH DATABASE (SPEC 8)
// Operator only, through the server command. A restore changes data for real, so the command asks for a confirmation that
// names the database, and it never runs from the web app.

// -- TYPES -- //
import type { Storage } from '../adapters/storage';
import type { Admin } from './admin';
import type { BackupMeta } from './dump';
import type { Frame } from './archive';
// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
// -- MODULES -- //
import { BackupError, readArchive } from './archive';
import { writableColumns } from './dump';

// -- TYPES -- //

export type RestoreResult = {
	orgId: string;
	orgSlug: string;
	tables: Record<string, number>;
	files: number;
};

// -- CONSTANTS -- //

/** Rows that may already exist because people belong to several orgs. They are kept as they are. */
const SHARED = new Set(['user', 'auth_account']);

// -- FUNCTIONS -- //

function metaOf(frames: Frame[]): BackupMeta {
	const first = frames[0];
	if (!first || first.type !== 'meta') throw new BackupError('The backup has no header.');
	const meta = first.json as BackupMeta;
	if (meta.format !== 'afb-backup' || meta.version !== 1)
		throw new BackupError('This backup format is not known to this version.');
	return meta;
}

async function appliedMigrations(db: Admin): Promise<string[]> {
	return (
		await db.query<{ tag: string }>(
			`select "tag" from "__afb_migrations" order by "applied_at", "tag"`
		)
	).map((r) => r.tag);
}

/** Reads an archive and says what is in it, without touching any database. */
export function inspectArchive(archive: Uint8Array, key: string) {
	const frames = readArchive(archive, key);
	const meta = metaOf(frames);
	// Every table's rows are all there, and every file has its checksum
	const seen: Record<string, number> = {};
	for (const f of frames)
		if (f.type === 'table') {
			const t = f.json as { table: string; rows: unknown[] };
			seen[t.table] = (seen[t.table] ?? 0) + t.rows.length;
		}
	for (const [name, t] of Object.entries(meta.tables))
		if ((seen[name] ?? 0) !== t.count)
			throw new BackupError(
				`The backup is incomplete: ${name} has ${seen[name] ?? 0} of ${t.count} rows.`
			);
	// Every file frame holds exactly the bytes it was saved with, and none is missing
	let files = 0;
	for (const f of frames)
		if (f.type === 'file') {
			files++;
			const h = f.json as { key: string; checksum?: string };
			if (h.checksum && createHash('sha256').update(f.bytes).digest('hex') !== h.checksum)
				throw new BackupError(
					`The backup is damaged: the file ${h.key} does not match its checksum.`
				);
		}
	if (files !== meta.files)
		throw new BackupError(`The backup is incomplete: it has ${files} of ${meta.files} files.`);
	return { frames, meta };
}

/**
 * Loads an org's frames into a database. `replace` removes the org's current rows first (its own org row cascades), otherwise
 * the org must not exist. Everything runs in one transaction where the connection can hold one.
 */
export async function loadOrg(
	frames: Frame[],
	target: Admin,
	storage: Storage | null,
	options: { replace?: boolean } = {}
): Promise<RestoreResult> {
	const meta = metaOf(frames);
	const have = await appliedMigrations(target);
	if (JSON.stringify(have) !== JSON.stringify(meta.migrations))
		throw new BackupError(
			`This backup was made by a database at migration ${meta.migrations.at(-1) ?? 'none'}, and the target is at ${have.at(-1) ?? 'none'}. Restore into a database of the same version.`
		);
	const columnsOf = new Map<string, string[]>();
	for (const name of Object.keys(meta.tables)) {
		const mine = await writableColumns(target, name);
		columnsOf.set(
			name,
			meta.tables[name].columns.filter((c) => mine.includes(c))
		);
	}
	const result = await target.tx(async (q) => {
		const existing = await q.query(`select 1 from "org" where "id" = $1`, [meta.orgId]);
		if (existing.length && !options.replace)
			throw new BackupError(
				`Organisation ${meta.orgSlug} already exists in this database. Use replace to restore over it.`
			);
		if (existing.length) await q.query(`delete from "org" where "id" = $1`, [meta.orgId]);
		const loaded: Record<string, number> = {};
		for (const f of frames) {
			if (f.type !== 'table') continue;
			const { table, rows } = f.json as { table: string; rows: Record<string, unknown>[] };
			const cols = columnsOf.get(table) ?? [];
			if (!cols.length || !rows.length) continue;
			const list = cols.map((c) => `"${c}"`).join(', ');
			await q.query(
				`insert into "${table}" (${list}) overriding system value select ${list} from jsonb_populate_recordset(null::"${table}", $1::jsonb)${SHARED.has(table) ? ' on conflict do nothing' : ''}`,
				[JSON.stringify(rows)]
			);
			loaded[table] = (loaded[table] ?? 0) + rows.length;
		}
		// Identity counters continue after the restored rows
		const identities = await q.query<{ table_name: string; column_name: string }>(
			`select table_name, column_name from information_schema.columns where table_schema = 'public' and is_identity = 'YES'`
		);
		for (const i of identities)
			if (meta.tables[i.table_name])
				await q.query(
					`select setval(pg_get_serial_sequence('"${i.table_name}"', '${i.column_name}'), greatest(coalesce((select max("${i.column_name}") from "${i.table_name}"), 1), 1))`
				);
		return loaded;
	});
	let files = 0;
	if (storage)
		for (const f of frames) {
			if (f.type !== 'file') continue;
			const h = f.json as { key: string; mime: string };
			await storage.put(h.key, f.bytes, h.mime);
			files++;
		}
	return { orgId: meta.orgId, orgSlug: meta.orgSlug, tables: result, files };
}

/**
 * The careful way to restore one org into a live database: the archive is read, checked and loaded into a scratch database
 * first (which must be migrated and empty of that org), and only a restore that matched its own row counts reaches the live
 * database. A bad archive, the wrong key or the wrong database version stops before the live database is touched.
 */
export async function restoreOrg(
	archive: Uint8Array,
	key: string,
	live: Admin,
	options: { scratch?: Admin; storage?: Storage | null; replace?: boolean } = {}
): Promise<RestoreResult> {
	const { frames, meta } = inspectArchive(archive, key);
	if (options.scratch) {
		const trial = await loadOrg(frames, options.scratch, null, { replace: true });
		for (const [name, t] of Object.entries(meta.tables)) {
			const got = (trial.tables[name] ?? 0) as number;
			// Shared rows may exist in the scratch database already, so only org rows must match exactly
			if (!SHARED.has(name) && got !== t.count)
				throw new BackupError(
					`The scratch restore of ${name} loaded ${got} of ${t.count} rows. Nothing was changed.`
				);
		}
	}
	return loadOrg(frames, live, options.storage ?? null, { replace: options.replace });
}

/** Full restore: every archive in turn into an empty database. People shared by several orgs are kept once. */
export async function restoreAll(
	archives: Uint8Array[],
	key: string,
	live: Admin,
	options: { storage?: Storage | null } = {}
): Promise<RestoreResult[]> {
	// Read every archive first, so a bad one stops the whole restore before anything is written
	const read = archives.map((a) => inspectArchive(a, key));
	// The database version is checked for all of them now, so an archive from before an update cannot leave half the orgs restored
	const have = JSON.stringify(await appliedMigrations(live));
	for (const { meta } of read)
		if (JSON.stringify(meta.migrations) !== have)
			throw new BackupError(
				`The backup of ${meta.orgSlug} was made by a database at migration ${meta.migrations.at(-1) ?? 'none'}, and the target is at ${JSON.parse(have).at(-1) ?? 'none'}. Nothing was restored. Restore into a database of the same version.`
			);
	const out: RestoreResult[] = [];
	for (const { frames } of read) out.push(await loadOrg(frames, live, options.storage ?? null));
	return out;
}
