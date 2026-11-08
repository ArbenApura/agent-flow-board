// THE POOLED THROWAWAY DATABASES OF THIS MACHINE: ONE POSTGRES CONTAINER, A TEMPLATE DATABASE WARMED ONCE, A CLONE (WITH ITS OWN ROLES) PER RUN.
// A container per run costs seconds of start-up and a migration each; here the container is made once (afb-checks-pool-<id>), the schema is migrated and
// seeded once into a template database keyed by recipe + migration hash, and every run gets `CREATE DATABASE clone TEMPLATE template` (well under a second).
//
// SAFETY, in the same terms as provision.ts: every docker command goes through checkDockerArgs, so only containers named afb-checks-... are ever touched, the
// port is bound to 127.0.0.1 and is never 5433 or another forbidden port, and the person's own database container is never named. A pooled run records only
// { dbName, roleName, poolId } in its marker (never a container name), so a sweep of a dead run drops that run's database and roles and cannot remove the pool.
//
// ISOLATION: CONNECT is revoked from PUBLIC on the template, the clone, `postgres` and `template1`; each clone grants CONNECT to its own login role only. The
// recipe's runtime role (for example app_runtime) exists once as a NOLOGIN group, so the migrations can grant to it; each run's login role is a member of it.
// Another run's role has the group's table rights in the other clone but cannot connect to it. An owner role owns the clone's database and objects (ownerUrl).
//
// FILE LAYOUT (poolDir()):
//   db-<poolId>.json       { kind:'db', poolId, containerName, port, ownerPid, ownerStartedAt, image, maxConnections, slots, password, createdAt }
//                          written BEFORE the container starts (a crash leaves a recorded name); mode 0600; the superuser password lives only here.
//   db-<poolId>.runs.json  { runs: { <runId>: { pid, at, dbName, roleName } } }, changed only under the lock "dbruns-<poolId>"; its live entries are the live-run count.
// The container is removed by its owner process when no run is live (removeWhenIdle) or by sweepPool() (doctor) when the owner is dead, no run is live and the
// marker is old enough. Nothing else removes it.

// -- DEP-MODULES -- //
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { FORBIDDEN_PORTS } from './guardrails.js';
import { acquireLock, pidAlive, withLockSync, type Lock } from './lock.js';
import { NAME, ensureDir, poolDir } from './paths.js';
import { renameRetry } from './fsretry.js';
import {
	CONTAINER_PREFIX,
	checkDockerArgs,
	freePort,
	makeThrowawayDatabase,
	realDocker,
	removeContainer,
	type DockerResult,
	type DockerRun
} from './provision.js';

// -- TYPES -- //

export type PoolMarker = {
	kind: 'db';
	poolId: string;
	containerName: string;
	port: number;
	ownerPid: number;
	/** When the owner process started (ms since the epoch, rounded to the second). With the pid it tells a reused pid from the owner. */
	ownerStartedAt: number;
	image: string;
	maxConnections: number;
	slots: number;
	password: string;
	createdAt: string;
};
export type DatabaseTemplate = {
	/** A hash (or any text) of the recipe: what the database must look like. */
	recipeHash: string;
	/** A hash of the migrations: changes with every new migration, so a new template is made. */
	migrationHash: string;
	/** Migrates and seeds the template. Gets the owner url of the template database; run once per key, under a lock, whatever the number of runs. */
	warm(ownerUrl: string): Promise<void>;
};
export type AcquireOptions = {
	/** The runtime role the app connects as (for example app_runtime). Made once as a NOLOGIN group; the run's login role is a member. */
	runtimeRole?: string;
	template: DatabaseTemplate;
	/** A scope that records the names for a later sweep and closes the run's database when the run ends. */
	scope?: PooledScope;
};
export type PooledDatabase = {
	databaseUrl: string;
	ownerUrl: string;
	roleName: string;
	dbName: string;
	poolId: string;
};
export type PooledInfo = { dbName: string; roleName: string; poolId: string };
/** What a run scope offers (scope.ts RunScope fits): resources closed with the run, and the names a later sweep needs. */
export type PooledScope = {
	add(name: string, dispose: () => void | Promise<void>): void;
	setInfo?: (info: Partial<PooledInfo> & { containerName?: string }) => void;
};
export type PoolDeps = {
	docker?: DockerRun;
	pickPort?: () => Promise<number>;
	/** The most runs at once; sizes max_connections. */
	slots?: number;
	image?: string;
	log?: (line: string) => void;
	/** True (default): the owner removes the container as soon as its last run ends. A worker sets false and calls closePoolIfIdle() when it stops. */
	removeWhenIdle?: boolean;
	readyTimeoutMs?: number;
	/** How long a run waits for another run's warm-up of the same template. */
	templateWaitMs?: number;
	/** The pause between tries of a busy template (tests shorten it). */
	retryMs?: number;
};
type RunsFile = {
	runs: Record<string, { pid: number; at: string; dbName: string; roleName: string }>;
};

// -- CONSTANTS -- //

export const POOL_PREFIX = `${CONTAINER_PREFIX}pool-`;
const DEFAULT_IMAGE = 'postgres:17';
/** Connections one run may hold (its app, its migrations and a check), and the base for the superuser and the tool itself. */
const CONNECTIONS_PER_RUN = 12;
const BASE_CONNECTIONS = 20;
const READY_COMMENT = 'afb-ready';
const POOL_ID = /^[a-f0-9]{6,16}$/;
const ROLE = /^[a-z_][a-z0-9_]{0,40}$/;
const RESERVED_ROLE = /^(pg_|postgres$|afb[dro]_)/;
/** The names a pooled run owns. Only names of this exact shape are ever dropped. */
const DB_NAME = /^afbd_[a-z0-9_]{1,50}$/;
const RUN_ROLE = /^afbr_[a-z0-9_]{1,50}$/;
/** A marker younger than this is never swept (its owner may be only starting). */
const MIN_SWEEP_AGE_MS = 2 * 60_000;

// -- FUNCTIONS -- //

export class PoolUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PoolUnavailableError';
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The rename of this module. A test replaces it to simulate the errors Windows gives while another process holds the file. */
export const poolIo = {
	rename: (from: string, to: string): void => renameSync(from, to)
};

function writeWhole(file: string, text: string): void {
	const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	try {
		renameRetry(tmp, file, poolIo.rename);
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
	}
}

const markerFile = (poolId: string) => join(poolDir(), `db-${poolId}.json`);
const runsFile = (poolId: string) => join(poolDir(), `db-${poolId}.runs.json`);
const runsLock = (poolId: string) => `dbruns-${poolId}`;

/** The numeric start time of this process in ms (rounded to the second). */
const ownStart = () => Math.round((Date.now() - process.uptime() * 1000) / 1000) * 1000;

/** The names of one run: lower case, dash to underscore, shortened with a hash when long. */
export function pooledNames(runId: string): PooledInfo & { ownerRole: string } {
	if (!NAME.test(runId)) throw new Error('The run id is not a plain name.');
	let slug = runId.toLowerCase().replace(/-/g, '_');
	if (slug.length > 36)
		slug = `${slug.slice(0, 24)}_${createHash('sha256').update(runId).digest('hex').slice(0, 10)}`;
	return {
		dbName: `afbd_${slug}`,
		roleName: `afbr_${slug}`,
		ownerRole: `afbo_${slug}`,
		poolId: ''
	};
}

/** The owner role that belongs to a recorded run role, or null when the recorded names are not a matched pair of ours. */
function ownerRoleOf(info: PooledInfo): string | null {
	if (!DB_NAME.test(info.dbName) || !RUN_ROLE.test(info.roleName)) return null;
	const slug = info.roleName.slice('afbr_'.length);
	if (info.dbName !== `afbd_${slug}`) return null;
	return `afbo_${slug}`;
}

/** The template database name for a key. */
export function templateName(
	template: Pick<DatabaseTemplate, 'recipeHash' | 'migrationHash'>,
	runtimeRole = ''
): string {
	const h = createHash('sha256')
		.update(`${template.recipeHash}\n${template.migrationHash}\n${runtimeRole}`)
		.digest('hex');
	return `afbt_${h.slice(0, 20)}`;
}

function parseMarker(text: string): PoolMarker | null {
	try {
		const v = JSON.parse(text) as Partial<PoolMarker> | null;
		if (!v || v.kind !== 'db') return null;
		if (typeof v.poolId !== 'string' || !POOL_ID.test(v.poolId)) return null;
		// A marker that names any container but its own pool is damaged or planted: it is never acted on
		if (v.containerName !== `${POOL_PREFIX}${v.poolId}`) return null;
		if (!Number.isInteger(v.port) || (v.port as number) < 1024 || (v.port as number) > 65535)
			return null;
		if (FORBIDDEN_PORTS.has(v.port as number)) return null;
		if (!Number.isInteger(v.ownerPid) || typeof v.password !== 'string') return null;
		return v as PoolMarker;
	} catch {
		return null;
	}
}

function readMarker(poolId: string): PoolMarker | null {
	if (!POOL_ID.test(poolId)) return null;
	try {
		return parseMarker(readFileSync(markerFile(poolId), 'utf8'));
	} catch {
		return null;
	}
}

/** Every pool marker on this machine. For doctor and the sweep. */
export function listPools(): { marker: PoolMarker; ownerAlive: boolean; liveRuns: number }[] {
	let names: string[];
	try {
		names = readdirSync(poolDir());
	} catch {
		return [];
	}
	const out: { marker: PoolMarker; ownerAlive: boolean; liveRuns: number }[] = [];
	for (const n of names) {
		const m = /^db-([a-f0-9]{6,16})\.json$/.exec(n);
		if (!m) continue;
		const marker = readMarker(m[1]);
		if (marker)
			out.push({
				marker,
				ownerAlive: pidAlive(marker.ownerPid),
				liveRuns: liveRunCount(marker.poolId)
			});
	}
	return out;
}

function readRuns(poolId: string): RunsFile {
	try {
		const v = JSON.parse(readFileSync(runsFile(poolId), 'utf8')) as Partial<RunsFile> | null;
		if (v && typeof v.runs === 'object' && v.runs) return { runs: v.runs };
	} catch {
		/* No file yet */
	}
	return { runs: {} };
}

/** Changes the runs file under its lock; dead entries (a process that is gone) are dropped first. */
function mutateRuns<T>(poolId: string, fn: (f: RunsFile) => T): T {
	return withLockSync(runsLock(poolId), () => {
		const f = readRuns(poolId);
		for (const [id, r] of Object.entries(f.runs)) if (!pidAlive(r.pid)) delete f.runs[id];
		const result = fn(f);
		ensureDir(poolDir());
		writeWhole(runsFile(poolId), JSON.stringify(f) + '\n');
		return result;
	});
}

/** The number of runs of this pool whose process is alive. */
export function liveRunCount(poolId: string): number {
	return Object.values(readRuns(poolId).runs).filter((r) => pidAlive(r.pid)).length;
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Waits for a lock without blocking the event loop. Null when it could not be had in time. */
async function takeLock(
	name: string,
	staleMs: number,
	waitMs: number,
	pause = 150
): Promise<Lock | null> {
	const until = Date.now() + waitMs;
	for (;;) {
		const lock = acquireLock(name, { staleMs });
		if (lock) return lock;
		if (Date.now() > until) return null;
		await sleep(pause);
	}
}

export class DatabasePool {
	private readonly docker: DockerRun;
	private readonly pickPort: () => Promise<number>;
	private readonly slots: number;
	private readonly image: string;
	private readonly log: (line: string) => void;
	private readonly removeWhenIdle: boolean;
	private readonly readyTimeoutMs: number;
	private readonly templateWaitMs: number;
	private readonly retryMs: number;
	private pool: PoolMarker | null = null;
	/** The names recorded for each run this process made, so a release drops exactly those. */
	private readonly records = new Map<string, PooledInfo>();

	constructor(deps: PoolDeps = {}) {
		this.docker = deps.docker ?? realDocker;
		this.pickPort = deps.pickPort ?? freePort;
		this.slots = Math.max(1, Math.floor(deps.slots ?? 4));
		this.image = deps.image ?? DEFAULT_IMAGE;
		this.log = deps.log ?? (() => {});
		this.removeWhenIdle = deps.removeWhenIdle ?? true;
		this.readyTimeoutMs = deps.readyTimeoutMs ?? 90_000;
		this.templateWaitMs = deps.templateWaitMs ?? 20 * 60_000;
		this.retryMs = deps.retryMs ?? 250;
	}

	/** Runs docker after the same argument check provision.ts applies. */
	private async dock(args: string[]): Promise<DockerResult> {
		checkDockerArgs(args);
		return this.docker(args);
	}

	/** One SQL statement as the superuser inside the pool container (over its socket), on a database. */
	private async psql(pool: PoolMarker, db: string, sql: string): Promise<DockerResult> {
		if (!pool.containerName.startsWith(POOL_PREFIX))
			throw new Error('That is not a pool container of the check tool.');
		return this.dock([
			'exec',
			pool.containerName,
			'psql',
			'-U',
			'postgres',
			'-d',
			db,
			'-v',
			'ON_ERROR_STOP=1',
			'-qtAc',
			sql
		]);
	}

	private async psqlOk(pool: PoolMarker, db: string, sql: string, what: string): Promise<string> {
		const r = await this.psql(pool, db, sql);
		if (r.status !== 0)
			throw new Error(
				`The pooled database step "${what}" failed: ${r.stderr.trim().split('\n').pop()?.slice(0, 200) ?? ''}`
			);
		return r.stdout.trim();
	}

	private async isRunning(pool: PoolMarker): Promise<boolean> {
		const r = await this.dock(['inspect', pool.containerName]);
		if (r.status !== 0) return false;
		try {
			const v: unknown = JSON.parse(r.stdout);
			const first = Array.isArray(v)
				? (v[0] as { State?: { Running?: boolean } } | undefined)
				: undefined;
			return first?.State?.Running === true;
		} catch {
			return false;
		}
	}

	private async waitReady(pool: PoolMarker): Promise<void> {
		const until = Date.now() + this.readyTimeoutMs;
		while (Date.now() < until) {
			// With -h the answer only comes from the real server, not the temporary one of the image's first start
			const r = await this.dock([
				'exec',
				pool.containerName,
				'pg_isready',
				'-U',
				'postgres',
				'-h',
				'127.0.0.1'
			]);
			if (r.status === 0) return;
			await sleep(400);
		}
		throw new PoolUnavailableError('The pooled database did not accept connections in time.');
	}

	/** Finds the live pool of this machine or starts one. Throws PoolUnavailableError when Docker or the container does not work. */
	async ensurePool(): Promise<PoolMarker> {
		if (this.pool && readMarker(this.pool.poolId)) return this.pool;
		this.pool = null;
		const version = await this.dock(['version']).catch(() => ({
			status: -1,
			stdout: '',
			stderr: ''
		}));
		if (version.status !== 0)
			throw new PoolUnavailableError('The pooled database needs Docker, which is not running.');
		const need = this.slots * CONNECTIONS_PER_RUN + BASE_CONNECTIONS;
		const lock = await takeLock('dbpool-create', 120_000, 120_000);
		if (!lock)
			throw new PoolUnavailableError('Another process kept the pool start lock for too long.');
		try {
			for (const p of listPools()) {
				// A pool whose owner ended is still used while a run is live in another process (the last run removes it)
				if ((!p.ownerAlive && p.liveRuns === 0) || p.marker.maxConnections < need) continue;
				if (await this.isRunning(p.marker)) {
					this.pool = p.marker;
					return p.marker;
				}
			}
			this.pool = await this.startPool(need);
			return this.pool;
		} finally {
			lock.release();
		}
	}

	private async startPool(maxConnections: number): Promise<PoolMarker> {
		ensureDir(poolDir());
		const poolId = randomBytes(4).toString('hex');
		for (let attempt = 0; attempt < 3; attempt++) {
			const port = await this.pickPort();
			if (port === 5433 || FORBIDDEN_PORTS.has(port))
				throw new Error(`Port ${port} is not one the check tool may use for a database.`);
			const marker: PoolMarker = {
				kind: 'db',
				poolId,
				containerName: `${POOL_PREFIX}${poolId}`,
				port,
				ownerPid: process.pid,
				ownerStartedAt: ownStart(),
				image: this.image,
				maxConnections,
				slots: this.slots,
				password: randomBytes(18).toString('hex'),
				createdAt: new Date().toISOString()
			};
			// Recorded before the container exists: whatever happens next, a sweep knows the exact name
			writeWhole(markerFile(poolId), JSON.stringify(marker) + '\n');
			let started: DockerResult;
			try {
				started = await this.dock([
					'run',
					'-d',
					'--name',
					marker.containerName,
					'--label',
					'afb-checks=pool',
					'-e',
					`POSTGRES_PASSWORD=${marker.password}`,
					'-p',
					`127.0.0.1:${port}:5432`,
					this.image,
					'postgres',
					'-c',
					`max_connections=${maxConnections}`,
					// The data is thrown away with the container, so it is never flushed for safety
					'-c',
					'fsync=off',
					'-c',
					'synchronous_commit=off',
					'-c',
					'full_page_writes=off'
				]);
			} catch (e) {
				rmSync(markerFile(poolId), { force: true });
				throw e;
			}
			if (started.status !== 0) {
				await removeContainer(marker.containerName, this.docker);
				if (
					attempt < 2 &&
					/port is already allocated|address already in use|bind for/i.test(started.stderr)
				)
					continue;
				rmSync(markerFile(poolId), { force: true });
				throw new PoolUnavailableError('The pooled database container could not be started.');
			}
			this.log(`Pooled database ${marker.containerName} started on port ${port}.`);
			try {
				await this.waitReady(marker);
				// Nobody but a run's own role may connect to a database; the default databases are closed to PUBLIC too
				await this.psqlOk(
					marker,
					'postgres',
					'REVOKE CONNECT ON DATABASE postgres FROM PUBLIC',
					'close postgres'
				);
				await this.psqlOk(
					marker,
					'postgres',
					'REVOKE CONNECT ON DATABASE template1 FROM PUBLIC',
					'close template1'
				);
			} catch (e) {
				await removeContainer(marker.containerName, this.docker);
				rmSync(markerFile(poolId), { force: true });
				throw e instanceof PoolUnavailableError
					? e
					: new PoolUnavailableError(e instanceof Error ? e.message : String(e));
			}
			return marker;
		}
		throw new PoolUnavailableError('No port could be used for the pooled database.');
	}

	private async templateReady(pool: PoolMarker, tpl: string): Promise<boolean> {
		const out = await this.psqlOk(
			pool,
			'postgres',
			`SELECT coalesce(shobj_description(oid,'pg_database'),'') FROM pg_database WHERE datname='${tpl}'`,
			'look for the template'
		);
		return out === READY_COMMENT;
	}

	/** Makes the template once: whoever gets the lock migrates and seeds it, the others wait and then find it ready. */
	private async ensureTemplate(
		pool: PoolMarker,
		template: DatabaseTemplate,
		runtimeRole: string | undefined
	): Promise<string> {
		const tpl = templateName(template, runtimeRole);
		if (await this.templateReady(pool, tpl)) return tpl;
		const lockName = `dbtpl-${pool.poolId}-${tpl.slice(5, 17)}`;
		// A warm-up can take minutes; a holder is only stale when its process is gone or after this long
		const lock = await takeLock(lockName, 45 * 60_000, this.templateWaitMs, 200);
		if (!lock) throw new Error('Another run kept the template warm-up for too long.');
		try {
			if (await this.templateReady(pool, tpl)) return tpl;
			// A half-built template of a run that died: dropped, then made again
			await this.psqlOk(
				pool,
				'postgres',
				`DROP DATABASE IF EXISTS ${quote(tpl)} WITH (FORCE)`,
				'drop a half-built template'
			);
			// The runtime role must exist before the migrations grant to it
			if (runtimeRole)
				await this.psqlOk(pool, 'postgres', groupSql(runtimeRole), 'make the runtime group');
			await this.psqlOk(pool, 'postgres', `CREATE DATABASE ${quote(tpl)}`, 'create the template');
			this.log(`Warming the template database ${tpl} (once)...`);
			try {
				await template.warm(`postgresql://postgres:${pool.password}@127.0.0.1:${pool.port}/${tpl}`);
				await this.psqlOk(
					pool,
					'postgres',
					`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${tpl}'`,
					'close the template connections'
				);
				await this.psqlOk(
					pool,
					'postgres',
					`REVOKE ALL ON DATABASE ${quote(tpl)} FROM PUBLIC`,
					'close the template'
				);
				await this.psqlOk(
					pool,
					'postgres',
					`ALTER DATABASE ${quote(tpl)} ALLOW_CONNECTIONS false`,
					'lock the template'
				);
				await this.psqlOk(
					pool,
					'postgres',
					`COMMENT ON DATABASE ${quote(tpl)} IS '${READY_COMMENT}'`,
					'mark the template ready'
				);
			} catch (e) {
				await this.psql(
					pool,
					'postgres',
					`DROP DATABASE IF EXISTS ${quote(tpl)} WITH (FORCE)`
				).catch(() => undefined);
				throw e;
			}
			return tpl;
		} finally {
			lock.release();
		}
	}

	/** Gives the run its own database: a clone of the template with its own login role, owner role and connection limit. */
	async acquireDatabase(runId: string, opts: AcquireOptions): Promise<PooledDatabase> {
		const group = opts.runtimeRole;
		if (group !== undefined && (!ROLE.test(group) || RESERVED_ROLE.test(group)))
			throw new Error('The runtime role is not a plain role name.');
		const names = pooledNames(runId);
		let pool = await this.ensurePool();
		const info: PooledInfo = {
			dbName: names.dbName,
			roleName: names.roleName,
			poolId: pool.poolId
		};
		// Recorded first (the file and the marker of the run): a crash after this point still leaves the exact names to drop
		const register = () =>
			mutateRuns(pool.poolId, (f) => {
				f.runs[runId] = {
					pid: process.pid,
					at: new Date().toISOString(),
					dbName: info.dbName,
					roleName: info.roleName
				};
			});
		register();
		// A pool whose last run ended a moment ago may have been removed by its owner between the look and the registration
		if (!readMarker(pool.poolId)) {
			this.pool = null;
			pool = await this.ensurePool();
			info.poolId = pool.poolId;
			register();
		}
		this.records.set(runId, info);
		opts.scope?.setInfo?.(info);
		opts.scope?.add(`pooled database ${info.dbName}`, () => this.releaseDatabase(runId));
		try {
			const tpl = await this.ensureTemplate(pool, opts.template, group);
			const runPassword = randomBytes(18).toString('hex');
			const ownerPassword = randomBytes(18).toString('hex');
			// One statement batch for the roles (the group too, idempotent), one for the clone: each docker exec costs a round trip
			const roles = [
				...(group ? [groupSql(group)] : []),
				// The owner seeds and migrates under FORCE ROW LEVEL SECURITY, as the cluster superuser did in the container per run; the runtime role never bypasses
				`CREATE ROLE ${quote(names.ownerRole)} LOGIN BYPASSRLS PASSWORD '${ownerPassword}'`,
				`CREATE ROLE ${quote(info.roleName)} LOGIN PASSWORD '${runPassword}'${group ? ` IN ROLE ${quote(group)}` : ''}`
			].join('; ');
			await this.psqlOk(pool, 'postgres', roles, 'make the run roles');
			await this.cloneTemplate(pool, tpl, info.dbName, names.ownerRole);
			// Run inside the clone: database-level statements work from any connection, and the owner hand-over needs this one
			await this.psqlOk(
				pool,
				info.dbName,
				[
					`REVOKE ALL ON DATABASE ${quote(info.dbName)} FROM PUBLIC`,
					`GRANT CONNECT ON DATABASE ${quote(info.dbName)} TO ${quote(info.roleName)}`,
					`ALTER DATABASE ${quote(info.dbName)} CONNECTION LIMIT ${CONNECTIONS_PER_RUN}`,
					ownerTransferSql(names.ownerRole)
				].join('; '),
				'close the clone and give the owner role its objects'
			);
			const at = (role: string, pw: string) =>
				`postgresql://${role}:${pw}@127.0.0.1:${pool.port}/${info.dbName}`;
			const ownerUrl = at(names.ownerRole, ownerPassword);
			return {
				databaseUrl: group ? at(info.roleName, runPassword) : ownerUrl,
				ownerUrl,
				// Always the recorded run role (the one a sweep drops), even when the url of a run with no runtime group is the owner role
				roleName: info.roleName,
				dbName: info.dbName,
				poolId: pool.poolId
			};
		} catch (e) {
			await this.releaseDatabase(runId).catch(() => undefined);
			throw e;
		}
	}

	/** CREATE DATABASE ... TEMPLATE, tried again while the template is busy (a connection of the warm-up still closing). */
	private async cloneTemplate(
		pool: PoolMarker,
		tpl: string,
		dbName: string,
		ownerRole: string
	): Promise<void> {
		const sql = `CREATE DATABASE ${quote(dbName)} TEMPLATE ${quote(tpl)} OWNER ${quote(ownerRole)} ALLOW_CONNECTIONS true`;
		for (let attempt = 0; ; attempt++) {
			const r = await this.psql(pool, 'postgres', sql);
			if (r.status === 0) return;
			if (
				attempt < 40 &&
				/being accessed by other users|is being used by|source database/i.test(r.stderr)
			) {
				await sleep(this.retryMs);
				continue;
			}
			throw new Error(
				`The pooled database could not be cloned: ${r.stderr.trim().split('\n').pop()?.slice(0, 200) ?? ''}`
			);
		}
	}

	/** Drops the run's database and roles by the names recorded for it, forgets the run and, when it was the last one, lets the owner remove the pool. */
	async releaseDatabase(runId: string): Promise<void> {
		const info = this.records.get(runId);
		this.records.delete(runId);
		if (!info) return;
		await dropPooledDatabase(info, { docker: this.docker });
		if (this.removeWhenIdle) await this.closePoolIfIdle();
	}

	/**
	 * Removes the pool container when no run of any process is live. Any process may do it, not only the owner: the owner may end first while other
	 * processes still use the pool, so whichever finishes last removes it. Returns true when it was removed.
	 */
	async closePoolIfIdle(): Promise<boolean> {
		const pool = this.pool;
		// Only a pool this process knows by its recorded name, and only an afb-checks-pool- container
		if (!pool || !pool.containerName.startsWith(POOL_PREFIX)) return false;
		const rmLock = await takeLock(`dbpoolrm-${pool.poolId}`, 120_000, 30_000, 50);
		if (!rmLock) return false;
		try {
			const current = readMarker(pool.poolId);
			if (!current || current.containerName !== pool.containerName) {
				// Another process already removed it
				this.pool = null;
				return false;
			}
			// Counted again inside the lock, under the runs lock, so a run that registers at this moment is counted or finds the marker gone and starts again
			const idle = mutateRuns(pool.poolId, (f) => {
				if (Object.keys(f.runs).length > 0) return false;
				rmSync(markerFile(pool.poolId), { force: true });
				return true;
			});
			if (!idle) return false;
			await removeContainer(pool.containerName, this.docker);
			rmSync(runsFile(pool.poolId), { force: true });
			this.pool = null;
			this.log(`Pooled database ${pool.containerName} removed.`);
			return true;
		} finally {
			rmLock.release();
		}
	}
}

/** Makes the runtime group role once (NOLOGIN, no rights of its own); a second call is harmless. */
const groupSql = (group: string) =>
	`DO $$ BEGIN CREATE ROLE ${quote(group)} NOLOGIN; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$`;

/** The statement that hands the objects of a clone (owned by the superuser after the template was migrated) to the clone's owner role. */
function ownerTransferSql(ownerRole: string): string {
	const owner = ownerRole.replace(/'/g, "''");
	return `DO $$ DECLARE r record; own text := '${owner}'; su oid := (SELECT oid FROM pg_roles WHERE rolname='postgres'); BEGIN
FOR r IN SELECT n.nspname s, c.relname o, c.relkind k FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND c.relkind IN ('r','p','v','m','f','S') AND c.relowner=su AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.deptype='e') LOOP
BEGIN EXECUTE format('ALTER %s %I.%I OWNER TO %I', CASE r.k WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END, r.s, r.o, own); EXCEPTION WHEN OTHERS THEN NULL; END;
END LOOP;
FOR r IN SELECT n.nspname s, p.proname o, pg_get_function_identity_arguments(p.oid) a, p.prokind k FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.proowner=su AND p.prokind IN ('f','p') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e') LOOP
BEGIN EXECUTE format('ALTER %s %I.%I(%s) OWNER TO %I', CASE r.k WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, r.s, r.o, r.a, own); EXCEPTION WHEN OTHERS THEN NULL; END;
END LOOP;
FOR r IN SELECT nspname s FROM pg_namespace WHERE nspowner=su AND nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' LOOP
BEGIN EXECUTE format('ALTER SCHEMA %I OWNER TO %I', r.s, own); EXCEPTION WHEN OTHERS THEN NULL; END;
END LOOP; END $$`;
}

/**
 * Drops one pooled run's database and its two roles by the recorded names, and forgets the run. Only names of the exact shape afbd_/afbr_ that belong
 * together are ever dropped; the container is never touched. Returns false when the pool or the names are not known. Never throws.
 */
export async function dropPooledDatabase(
	info: PooledInfo,
	deps: { docker?: DockerRun } = {}
): Promise<boolean> {
	const docker = deps.docker ?? realDocker;
	const ownerRole = ownerRoleOf(info);
	const pool = readMarker(info.poolId);
	if (!ownerRole || !pool) return false;
	const psql = (sql: string) => {
		const args = [
			'exec',
			pool.containerName,
			'psql',
			'-U',
			'postgres',
			'-d',
			'postgres',
			'-v',
			'ON_ERROR_STOP=1',
			'-qtAc',
			sql
		];
		checkDockerArgs(args);
		return docker(args);
	};
	let dropped = false;
	try {
		// psql answers with an exit status: a drop that failed (the database is busy, docker hiccuped) keeps the run's entry so a later sweep tries again
		const db = await psql(`DROP DATABASE IF EXISTS ${quote(info.dbName)} WITH (FORCE)`);
		if (db.status !== 0) return false;
		const roles = await psql(
			`DROP ROLE IF EXISTS ${quote(info.roleName)}; DROP ROLE IF EXISTS ${quote(ownerRole)}`
		);
		if (roles.status !== 0) return false;
		dropped = true;
	} catch {
		return false;
	} finally {
		if (dropped) {
			try {
				mutateRuns(pool.poolId, (f) => {
					for (const [id, r] of Object.entries(f.runs))
						if (r.dbName === info.dbName) delete f.runs[id];
				});
			} catch {
				/* The lock could not be had: the dead entry is pruned by the next change */
			}
		}
	}
	return true;
}

/**
 * Doctor: removes pool containers whose owner process is gone, that no live run uses and whose marker is older than `minAgeMs` (default 2 minutes).
 * Removes by the recorded name only. Returns the names removed.
 */
export async function sweepPool(
	opts: { docker?: DockerRun; minAgeMs?: number; log?: (line: string) => void } = {}
): Promise<string[]> {
	const removed: string[] = [];
	for (const p of listPools()) {
		if (p.ownerAlive || p.liveRuns > 0) continue;
		if (Date.now() - Date.parse(p.marker.createdAt) < (opts.minAgeMs ?? MIN_SWEEP_AGE_MS)) continue;
		await removeContainer(p.marker.containerName, opts.docker ?? realDocker);
		rmSync(markerFile(p.marker.poolId), { force: true });
		rmSync(runsFile(p.marker.poolId), { force: true });
		removed.push(p.marker.containerName);
		opts.log?.(`Removed the leftover pooled database ${p.marker.containerName}.`);
	}
	return removed;
}

let shared: DatabasePool | null = null;
let sharedDeps: PoolDeps = {};

/** Sets how this process's pool behaves (slots, keep-warm). Call before the first acquireDatabase. */
export function configureDatabasePool(deps: PoolDeps): void {
	sharedDeps = deps;
	shared = null;
}

/** The pool of this process. */
export function databasePool(): DatabasePool {
	shared ??= new DatabasePool(sharedDeps);
	return shared;
}

export const acquireDatabase = (runId: string, opts: AcquireOptions): Promise<PooledDatabase> =>
	databasePool().acquireDatabase(runId, opts);
export const releaseDatabase = (runId: string): Promise<void> =>
	databasePool().releaseDatabase(runId);
export const closePoolIfIdle = (): Promise<boolean> => databasePool().closePoolIfIdle();

/**
 * A database for one run: from the pool, or, when the pool is unavailable (Docker down, the container could not start), its own container as before.
 * The template's warm-up runs on the fresh container in that case, so the caller sees the same result either way.
 */
export async function provisionDatabase(
	runId: string,
	scope: PooledScope & { runId: string; close(): Promise<void> },
	log: (line: string) => void,
	opts: AcquireOptions & {
		pool?: DatabasePool;
		docker?: DockerRun;
		pickPort?: () => Promise<number>;
	}
): Promise<PooledDatabase & { pooled: boolean }> {
	const pool = opts.pool ?? databasePool();
	try {
		const db = await pool.acquireDatabase(runId, {
			runtimeRole: opts.runtimeRole,
			template: opts.template,
			scope
		});
		return { ...db, pooled: true };
	} catch (e) {
		if (!(e instanceof PoolUnavailableError)) throw e;
		log(`The database pool is not available (${e.message}). Using a container for this run.`);
	}
	const own = await makeThrowawayDatabase(runId, scope, log, {
		runtimeRole: opts.runtimeRole,
		docker: opts.docker,
		pickPort: opts.pickPort
	});
	await opts.template.warm(own.ownerUrl);
	return {
		databaseUrl: own.databaseUrl,
		ownerUrl: own.ownerUrl,
		roleName: own.roleName ?? 'postgres',
		dbName: 'app',
		poolId: '',
		pooled: false
	};
}
