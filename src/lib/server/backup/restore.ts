// RESTORING ONE ORG FROM ITS BACKUP: INTO AN EMPTY DATABASE, OVER ITS OWN OLD ROWS, OR AFTER A CHECK IN A SCRATCH DATABASE (SPEC 8)
// Operator only, through the server command. A restore changes data for real, so the command asks for a confirmation that
// names the database, and it never runs from the web app.
// An archive is read as a stream, in passes that each open it again: first a full check that writes nothing, then the scratch
// trial, then the live load (tables inside one transaction, files only after it commits), so memory stays flat and a bad archive
// stops before anything real is touched.

// IMPORTED TYPES
import type { Storage } from '../adapters/storage';
import type { Admin } from './admin';
import type { BackupMeta } from './dump';
import type { Frame } from './archive';
// IMPORTED DEP-MODULES
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
// IMPORTED MODULES
import { BackupError, readArchive, readArchiveStream } from './archive';
import { writableColumns } from './dump';

// -- TYPES -- //

export type RestoreResult = {
	orgId: string;
	orgSlug: string;
	tables: Record<string, number>;
	files: number;
};

/** Opens the archive again each time it is called, so the passes can each read it from the start. */
export type ArchiveSource = () => AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>;

// -- CONSTANTS -- //

/** Rows that may already exist because people belong to several orgs. They are kept as they are. */
const SHARED = new Set(['user', 'auth_account']);

// -- FUNCTIONS -- //

function metaOfFrame(first: Frame | undefined): BackupMeta {
	if (!first || first.type !== 'meta') throw new BackupError('The backup has no header.');
	const meta = first.json as BackupMeta;
	if (meta.format !== 'afb-backup' || meta.version !== 1)
		throw new BackupError('This backup format is not known to this version.');
	return meta;
}

const metaOf = (frames: Frame[]): BackupMeta => metaOfFrame(frames[0]);

/** An archive held in memory as a source the passes can open again. */
export const bytesSource =
	(archive: Uint8Array): ArchiveSource =>
	() =>
		Readable.from([archive]);

async function appliedMigrations(db: Admin): Promise<string[]> {
	return (
		await db.query<{ tag: string }>(
			`select "tag" from "__afb_migrations" order by "applied_at", "tag"`
		)
	).map((r) => r.tag);
}

/** Every table's rows are all there. */
function checkRows(meta: BackupMeta, seen: Record<string, number>) {
	for (const [name, t] of Object.entries(meta.tables))
		if ((seen[name] ?? 0) !== t.count)
			throw new BackupError(
				`The backup is incomplete: ${name} has ${seen[name] ?? 0} of ${t.count} rows.`
			);
}

/** Every file the header counts is there. */
function checkFileCount(meta: BackupMeta, files: number) {
	if (files !== meta.files)
		throw new BackupError(`The backup is incomplete: it has ${files} of ${meta.files} files.`);
}

/** Every file frame holds exactly the bytes it was saved with. */
function checkFile(f: Extract<Frame, { type: 'file' }>) {
	const h = f.json as { key: string; checksum?: string };
	if (h.checksum && createHash('sha256').update(f.bytes).digest('hex') !== h.checksum)
		throw new BackupError(`The backup is damaged: the file ${h.key} does not match its checksum.`);
}

/** Reads an archive and says what is in it, without touching any database. */
export function inspectArchive(archive: Uint8Array, key: string) {
	const frames = readArchive(archive, key);
	const meta = metaOf(frames);
	const seen: Record<string, number> = {};
	for (const f of frames)
		if (f.type === 'table') {
			const t = f.json as { table: string; rows: unknown[] };
			seen[t.table] = (seen[t.table] ?? 0) + t.rows.length;
		}
	checkRows(meta, seen);
	let files = 0;
	for (const f of frames)
		if (f.type === 'file') {
			files++;
			checkFile(f);
		}
	checkFileCount(meta, files);
	return { frames, meta };
}

/**
 * The same check as inspectArchive on an archive read as a stream: the key, every block, the compressed stream, the row counts
 * and every file's checksum, one frame at a time. It writes nothing and holds no frames.
 */
export async function inspectArchiveStream(source: AsyncIterable<Uint8Array>, key: string) {
	let meta: BackupMeta | null = null;
	const seen: Record<string, number> = {};
	let files = 0;
	for await (const f of readArchiveStream(source, key)) {
		if (!meta) {
			meta = metaOfFrame(f);
			continue;
		}
		if (f.type === 'table') {
			const t = f.json as { table: string; rows: unknown[] };
			seen[t.table] = (seen[t.table] ?? 0) + t.rows.length;
		} else if (f.type === 'file') {
			files++;
			checkFile(f);
		}
	}
	if (!meta) throw new BackupError('The backup has no header.');
	checkRows(meta, seen);
	checkFileCount(meta, files);
	return { meta };
}

/**
 * Loads an org's table rows into a database. `replace` removes the org's current rows first (its own org row cascades), otherwise
 * the org must not exist. Everything runs in one transaction where the connection can hold one. File frames are left alone here.
 */
async function loadTables(
	meta: BackupMeta,
	frames: Iterable<Frame> | AsyncIterable<Frame>,
	target: Admin,
	options: { replace?: boolean }
): Promise<Record<string, number>> {
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
	return target.tx(async (q) => {
		const existing = await q.query(`select 1 from "org" where "id" = $1`, [meta.orgId]);
		if (existing.length && !options.replace)
			throw new BackupError(
				`Organisation ${meta.orgSlug} already exists in this database. Use replace to restore over it.`
			);
		if (existing.length) await q.query(`delete from "org" where "id" = $1`, [meta.orgId]);
		const loaded: Record<string, number> = {};
		for await (const f of frames) {
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
}

/** Puts the file frames into storage, one at a time. */
async function putFiles(
	storage: Storage,
	frames: Iterable<Frame> | AsyncIterable<Frame>
): Promise<number> {
	let files = 0;
	for await (const f of frames) {
		if (f.type !== 'file') continue;
		const h = f.json as { key: string; mime: string };
		// Read again after the commit, so each file is checked again against its checksum before it is put
		checkFile(f);
		await storage.put(h.key, f.bytes, h.mime);
		files++;
	}
	return files;
}

/** Loads an org's frames held in memory into a database. A restore reads as a stream instead (loadOrgStream). */
export async function loadOrg(
	frames: Frame[],
	target: Admin,
	storage: Storage | null,
	options: { replace?: boolean } = {}
): Promise<RestoreResult> {
	const meta = metaOf(frames);
	const result = await loadTables(meta, frames, target, options);
	const files = storage ? await putFiles(storage, frames) : 0;
	return { orgId: meta.orgId, orgSlug: meta.orgSlug, tables: result, files };
}

/**
 * Loads an org from an archive read as a stream. The tables go in first, inside one transaction; the files are put into storage
 * only after it commits, in a second read of the archive. Check the archive with inspectArchiveStream before calling this.
 */
export async function loadOrgStream(
	open: ArchiveSource,
	key: string,
	target: Admin,
	storage: Storage | null,
	options: { replace?: boolean } = {}
): Promise<RestoreResult> {
	const frames = readArchiveStream(await open(), key);
	const head = await frames.next();
	const meta = metaOfFrame(head.value as Frame | undefined);
	let result: Record<string, number>;
	try {
		result = await loadTables(meta, frames, target, options);
	} finally {
		// An early refusal (the database version) must not leave the archive's reader open
		await frames.return(undefined);
	}
	const files = storage ? await putFiles(storage, readArchiveStream(await open(), key)) : 0;
	return { orgId: meta.orgId, orgSlug: meta.orgSlug, tables: result, files };
}

/**
 * The careful way to restore one org into a live database: the archive is read and checked completely first (the key, every
 * block, the counts and checksums; nothing is written), then loaded into a scratch database (which must be migrated and empty
 * of that org), and only a restore that matched its own row counts reaches the live database. A bad archive, the wrong key or
 * the wrong database version stops before the live database is touched.
 */
export async function restoreOrgStream(
	open: ArchiveSource,
	key: string,
	live: Admin,
	options: { scratch?: Admin; storage?: Storage | null; replace?: boolean } = {}
): Promise<RestoreResult> {
	const { meta } = await inspectArchiveStream(await open(), key);
	if (options.scratch) {
		const trial = await loadOrgStream(open, key, options.scratch, null, { replace: true });
		for (const [name, t] of Object.entries(meta.tables)) {
			const got = (trial.tables[name] ?? 0) as number;
			// Shared rows may exist in the scratch database already, so only org rows must match exactly
			if (!SHARED.has(name) && got !== t.count)
				throw new BackupError(
					`The scratch restore of ${name} loaded ${got} of ${t.count} rows. Nothing was changed.`
				);
		}
	}
	return loadOrgStream(open, key, live, options.storage ?? null, { replace: options.replace });
}

/** Full restore: every archive in turn into an empty database. People shared by several orgs are kept once. */
export async function restoreAllStream(
	opens: ArchiveSource[],
	key: string,
	live: Admin,
	options: { storage?: Storage | null } = {}
): Promise<RestoreResult[]> {
	// Read every archive completely first, so a bad one stops the whole restore before anything is written
	const metas: BackupMeta[] = [];
	for (const open of opens) metas.push((await inspectArchiveStream(await open(), key)).meta);
	// The database version is checked for all of them now, so an archive from before an update cannot leave half the orgs restored
	const have = JSON.stringify(await appliedMigrations(live));
	for (const meta of metas)
		if (JSON.stringify(meta.migrations) !== have)
			throw new BackupError(
				`The backup of ${meta.orgSlug} was made by a database at migration ${meta.migrations.at(-1) ?? 'none'}, and the target is at ${JSON.parse(have).at(-1) ?? 'none'}. Nothing was restored. Restore into a database of the same version.`
			);
	const out: RestoreResult[] = [];
	for (const open of opens) out.push(await loadOrgStream(open, key, live, options.storage ?? null));
	return out;
}

/** restoreOrgStream for an archive held in memory. */
export function restoreOrg(
	archive: Uint8Array,
	key: string,
	live: Admin,
	options: { scratch?: Admin; storage?: Storage | null; replace?: boolean } = {}
): Promise<RestoreResult> {
	return restoreOrgStream(bytesSource(archive), key, live, options);
}

/** restoreAllStream for archives held in memory. */
export function restoreAll(
	archives: Uint8Array[],
	key: string,
	live: Admin,
	options: { storage?: Storage | null } = {}
): Promise<RestoreResult[]> {
	return restoreAllStream(archives.map(bytesSource), key, live, options);
}
