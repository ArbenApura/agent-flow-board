// WHAT A RUN MAY REUSE FROM AN EARLIER RUN: THE DEPENDENCIES OF A LOCKFILE AND A FINISHED BUILD, KEPT PER REGISTRATION (cacheDirFor(org, name) in paths.ts).
// Entries are written into a folder of their own (<id>.tmp-<pid>-<time>) and renamed into place whole, so a reader never sees half of one. An entry holds
// manifest.json (every file with its size and, for builds, its sha256), a .complete note and a `use` folder of in-use markers. A restore checks the content
// of every file against the manifest first and refuses a damaged entry (it is moved aside and never served again). Files come back as copies, or as hard
// links on the same volume with the shared files set read-only, so a write through a restored file fails loudly instead of changing the cache.
// Nothing here follows a link: a link is recreated as a link, a path with `..` is skipped, and a write never goes through a link in the destination.
// The heavy walks (snapshot, publish, verify, restore) are generators that yield every few hundred files: the `...Async` forms let the event loop run between
// batches (the single-flight heartbeat and the board beat must never starve while a big tree is copied); the plain forms run the same code to the end.

// IMPORTED DEP-MODULES
import { createHash, randomBytes } from 'node:crypto';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
// IMPORTED MODULES
import { pidAlive } from './lock.js';

// -- TYPES -- //

export type LinkMode = 'auto' | 'copy';
export type CacheKind = 'builds' | 'deps';
export type RestoreResult = { files: number; linked: number; copied: number };
export type EvictOptions = { builds?: number; deps?: number; maxAgeDays?: number; now?: number };
type Entry = {
	p: string;
	t: 'f' | 'l' | 'd';
	size?: number;
	sha?: string;
	to?: string;
	dir?: boolean;
};
type Manifest = { version: 1; entries: Entry[] };
type UseMarker = { pid: number; start: string; token: string };
export type BuildKeyInput = {
	org: string;
	name: string;
	/** From treeId(): the tree that was copied. */
	treeId: string;
	/** The surface hash of the files that decide how it builds. */
	surface: string;
	build: string | undefined;
	env: Record<string, string> | undefined;
	/** Names of settings that belong to one run alone (adopted values, a made-for-this-run account). */
	envNames?: string[];
	/** Values that must never be part of a kept build (secrets, a made password). */
	secretValues?: string[];
	/** What changes what a build makes on this machine. They default to this process's own values. */
	node?: string;
	platform?: string;
	arch?: string;
	/** The app folder the build ran in (a monorepo builds more than one app from one tree). */
	appDir?: string;
};

/** A kept entry whose content no longer matches its manifest. It has been moved aside; the caller builds or installs instead. */
export class CacheCorruptError extends Error {
	readonly code = 'CACHE_CORRUPT';
	constructor(what: string) {
		super(`A kept cache entry is damaged (${what}) and was set aside.`);
		this.name = 'CacheCorruptError';
	}
}

// -- CONSTANTS -- //

export const KEEP_BUILDS = 5;
export const KEEP_DEPS = 3;
/** An entry used (restored from, or marked) this recently is never removed. */
const RECENT_USE_MS = 10 * 60_000;
const TMP_MAX_AGE_MS = 60 * 60_000;
const DAY_MS = 86_400_000;
/** A use marker older than this is ignored even when its process id is alive (ids are reused; a run lasts 40 minutes at most). */
const USE_MARKER_MAX_MS = 6 * 60 * 60_000;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const KEY = /^[a-f0-9]{16,64}$/;
const PORT_FREE_KEYS = new Set(['PORT', 'HOST']);
const SECRET_KEY =
	/(SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_?KEY|API_?KEY|SERVICE_?ROLE|CREDENTIAL|ACCESS_?KEY)/i;
const DB_KEY =
	/(DATABASE|DB|POSTGRES|POSTGRESQL|MYSQL|MONGO|REDIS)_?(URL|URI)$|^(DIRECT_URL|PG(HOST|PORT|USER|PASSWORD|DATABASE))$|^DB_(HOST|PORT|USER|PASSWORD|NAME)$/i;
const SELF_KEY = /(^|_)(BASE_?URL|APP_URL|SITE_URL|PUBLIC_URL|ORIGIN|SELF_URL)$|(^|_)PORT$/i;
const LOOPBACK_PORT = /(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0|host\.docker\.internal):\d{2,5}/i;
const PLACEHOLDER = /\{(port|baseUrl)\}/i;
const DB_SCHEME = /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|rediss):\/\//i;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

// -- FUNCTIONS -- //

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** How many files, or bytes, one batch may handle before it gives the event loop a turn. */
const BATCH_FILES = 50;
const BATCH_BYTES = 8 * 1024 * 1024;

/** A batch also ends after this long, whatever it holds: a file system with a scanner in front of it takes milliseconds per file. */
const BATCH_MS = 10;

/** Counts work and says when a batch is full (by files, by bytes or by time). */
function pacer() {
	let files = 0;
	let bytes = 0;
	let since = Date.now();
	return (size = 0): boolean => {
		files++;
		bytes += size;
		if (files < BATCH_FILES && bytes < BATCH_BYTES && Date.now() - since < BATCH_MS) return false;
		files = 0;
		bytes = 0;
		since = Date.now();
		return true;
	};
}

/** Runs a generator to its end without ever giving the event loop a turn (the plain forms of the functions below). */
function runSync<T>(g: Generator<void, T>): T {
	let r = g.next();
	while (!r.done) r = g.next();
	return r.value;
}
/** Runs a generator and gives the event loop a turn at every yield. */
async function runAsync<T>(g: Generator<void, T>): Promise<T> {
	let r = g.next();
	while (!r.done) {
		await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
		r = g.next();
	}
	return r.value;
}
const shaFile = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

// -- KEYS -- //

/** The key of an installed set of dependencies: the lockfile and everything that changes what an install makes on this machine. */
export function depsKey(i: {
	lockHash: string;
	node: string;
	platform: string;
	arch: string;
	pm: string;
	pmVersion: string;
}): string {
	return sha(
		JSON.stringify({
			kind: 'deps',
			lockHash: i.lockHash,
			node: i.node,
			platform: i.platform,
			arch: i.arch,
			pm: i.pm,
			pmVersion: i.pmVersion
		})
	);
}

/** The id of a copied tree: the commit with the hash of the uncommitted changes, or the content hash of a folder that is not a git repo. Null when neither is known. */
export function treeId(i: {
	commit?: string | null;
	diffHash?: string | null;
	contentHash?: string | null;
}): string | null {
	if (i.commit) return sha(JSON.stringify({ git: i.commit, diff: i.diffHash ?? '' }));
	if (i.contentHash) return sha(JSON.stringify({ content: i.contentHash }));
	return null;
}

/** Why a build must not be kept, or null when it may be. A kept build must not carry a value that belongs to one run (its port, its address, a database, a secret). */
export function uncacheableReason(i: {
	build: string | undefined;
	env: Record<string, string> | undefined;
	envNames?: string[];
	secretValues?: string[];
}): string | null {
	const build = i.build?.trim();
	if (!build) return 'there is no build command';
	const secrets = (i.secretValues ?? []).filter((v) => typeof v === 'string' && v.length >= 4);
	const names = new Set(i.envNames ?? []);
	const holdsSecret = (text: string) => secrets.some((s) => text.includes(s));
	if (PLACEHOLDER.test(build)) return 'the build command holds a port or base url placeholder';
	if (LOOPBACK_PORT.test(build) || /--port\b/.test(build)) return 'the build command holds a port';
	if (/\b(DATABASE_URL|DB_URL|POSTGRES_URL)\b/i.test(build) || DB_SCHEME.test(build))
		return 'the build command holds a database url';
	if (holdsSecret(build)) return 'the build command holds a secret';
	for (const [k, v] of Object.entries(i.env ?? {})) {
		if (PORT_FREE_KEYS.has(k)) continue;
		if (names.has(k)) return `the setting ${k} belongs to one run`;
		if (SECRET_KEY.test(k)) return `the setting ${k} is a secret`;
		if (DB_KEY.test(k)) return `the setting ${k} is a database setting`;
		if (SELF_KEY.test(k)) return `the setting ${k} is an address or a port`;
		const value = typeof v === 'string' ? v : '';
		if (PLACEHOLDER.test(value)) return `the setting ${k} holds a port or base url placeholder`;
		if (LOOPBACK_PORT.test(value)) return `the setting ${k} holds a local address with a port`;
		if (DB_SCHEME.test(value)) return `the setting ${k} holds a database url`;
		if (JWT.test(value) || holdsSecret(value)) return `the setting ${k} holds a secret`;
	}
	return null;
}

/** The key of a finished build, or null when it must not be kept (see uncacheableReason). */
export function buildKey(i: BuildKeyInput): string | null {
	if (uncacheableReason(i) !== null) return null;
	const values = Object.entries(i.env ?? {})
		.filter(([k]) => !PORT_FREE_KEYS.has(k))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return sha(
		JSON.stringify({
			kind: 'build',
			org: i.org,
			name: i.name,
			treeId: i.treeId,
			surface: i.surface,
			build: i.build,
			node: i.node ?? process.version,
			platform: i.platform ?? process.platform,
			arch: i.arch ?? process.arch,
			appDir: i.appDir ?? '',
			envHash: sha(JSON.stringify(values))
		})
	);
}

// -- ENTRIES -- //

function entryDir(cacheRoot: string, kind: CacheKind, key: string): string {
	if (!KEY.test(key)) throw new Error('The cache key is not a plain key.');
	return join(cacheRoot, kind, key);
}
/** The folder of a kept entry (it may not exist). */
export const buildEntryDir = (cacheRoot: string, key: string) => entryDir(cacheRoot, 'builds', key);
export const depsEntryDir = (cacheRoot: string, key: string) => entryDir(cacheRoot, 'deps', key);
/** True when a finished entry exists for this key. */
export const hasEntry = (cacheRoot: string, kind: CacheKind, key: string): boolean =>
	existsSync(join(entryDir(cacheRoot, kind, key), '.complete'));

const unsafePath = (p: string) =>
	!p ||
	isAbsolute(p) ||
	/^[A-Za-z]:/.test(p) ||
	p.includes('\0') ||
	p.split(/[\\/]/).includes('..');

function removeEntry(path: string): boolean {
	const tries = () => rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	try {
		tries();
		return true;
	} catch {
		makeWritable(path);
		try {
			tries();
			return true;
		} catch {
			return false;
		}
	}
}

/** Sets every file below a folder writable again (restored hard links are read-only), without following links. */
function makeWritable(path: string): void {
	let st;
	try {
		st = lstatSync(path);
	} catch {
		return;
	}
	if (st.isSymbolicLink()) return;
	try {
		chmodSync(path, st.isDirectory() ? 0o700 : 0o600);
	} catch {
		/* Best effort */
	}
	if (!st.isDirectory()) return;
	for (const n of readdirSync(path)) makeWritable(join(path, n));
}

const touch = (path: string) => {
	try {
		const now = new Date();
		utimesSync(path, now, now);
	} catch {
		/* An entry that cannot be touched is still usable */
	}
};

function readManifest(dir: string): Manifest | null {
	try {
		const v: unknown = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
		if (!v || typeof v !== 'object') return null;
		const m = v as Partial<Manifest>;
		if (m.version !== 1 || !Array.isArray(m.entries)) return null;
		for (const e of m.entries) {
			if (!e || typeof e.p !== 'string' || !['f', 'l', 'd'].includes(e.t)) return null;
		}
		return m as Manifest;
	} catch {
		return null;
	}
}

/** Moves a damaged entry aside under a name eviction removes, so it is never served again. */
function quarantine(dir: string): void {
	try {
		renameSync(dir, `${dir}.tmp-bad-${process.pid}-${Date.now()}`);
	} catch {
		removeEntry(dir);
	}
}

// -- SNAPSHOT AND PUBLISH -- //

/** Every regular file under a folder (not .git, not node_modules, no link) as relative path to "size:modified". */
export function snapshot(dir: string): Map<string, string> {
	return runSync(snapshotGen(dir));
}
export const snapshotAsync = (dir: string): Promise<Map<string, string>> =>
	runAsync(snapshotGen(dir));

function* snapshotGen(dir: string): Generator<void, Map<string, string>> {
	const out = new Map<string, string>();
	const due = pacer();
	function* walk(rel: string): Generator<void> {
		for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name)) yield* walk(r);
			} else if (e.isFile()) {
				const s = lstatSync(join(dir, r));
				out.set(r, `${s.size}:${Math.floor(s.mtimeMs)}`);
				if (due()) yield;
			}
		}
	}
	yield* walk('');
	return out;
}

function ensureRoot(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Renames a finished temporary entry into place. False when an entry already exists (somebody else published first). */
function finish(tmp: string, entry: string): boolean {
	writeFileSync(join(tmp, '.complete'), new Date().toISOString() + '\n');
	try {
		renameSync(tmp, entry);
		return true;
	} catch {
		removeEntry(tmp);
		return false;
	}
}

/**
 * Keeps what a build made: the files that are new or changed since `before` (a snapshot taken before the build). Returns false when there was nothing to keep,
 * an entry already exists, or the files changed while they were copied. The entry is made in a folder of its own and renamed into place.
 */
export function publishBuild(
	cacheRoot: string,
	key: string,
	dir: string,
	before: Map<string, string>
): boolean {
	return runSync(publishBuildGen(cacheRoot, key, dir, before));
}
export const publishBuildAsync = (
	cacheRoot: string,
	key: string,
	dir: string,
	before: Map<string, string>
): Promise<boolean> => runAsync(publishBuildGen(cacheRoot, key, dir, before));

function* publishBuildGen(
	cacheRoot: string,
	key: string,
	dir: string,
	before: Map<string, string>
): Generator<void, boolean> {
	const entry = buildEntryDir(cacheRoot, key);
	if (hasEntry(cacheRoot, 'builds', key)) return false;
	const after = yield* snapshotGen(dir);
	const made = [...after].filter(([rel, sig]) => before.get(rel) !== sig).map(([rel]) => rel);
	if (!made.length) return false;
	const tmp = `${entry}.tmp-${process.pid}-${Date.now()}`;
	const due = pacer();
	try {
		const entries: Entry[] = [];
		for (const rel of made) {
			if (unsafePath(rel)) continue;
			const from = join(dir, rel);
			const to = join(tmp, 'files', rel);
			mkdirSync(dirname(to), { recursive: true });
			copyFileSync(from, to);
			chmodSync(to, 0o644);
			const st = lstatSync(to);
			entries.push({ p: rel, t: 'f', size: st.size, sha: shaFile(to) });
			if (due(st.size)) yield;
		}
		writeFileSync(
			join(tmp, 'manifest.json'),
			JSON.stringify({ version: 1, entries } satisfies Manifest)
		);
		return finish(tmp, entry);
	} catch {
		removeEntry(tmp);
		return false;
	}
}

// -- RESTORE -- //

/** Checks every entry of a manifest against the files kept under `root`. Throws CacheCorruptError at the first difference. */
function* verify(root: string, entries: Entry[]): Generator<void> {
	const due = pacer();
	for (const e of entries) {
		// Folders and links live only in the manifest and are made again on restore
		if (e.t !== 'f' || unsafePath(e.p)) continue;
		const full = join(root, e.p);
		let st;
		try {
			st = lstatSync(full);
		} catch {
			throw new CacheCorruptError('a file is missing');
		}
		if (!st.isFile() || st.size !== e.size) throw new CacheCorruptError('a file has another size');
		if (e.sha && shaFile(full) !== e.sha) throw new CacheCorruptError('a file has other content');
		if (due(st.size)) yield;
	}
}

/** Makes the folders above `rel` inside `root`, refusing to step through a link that is already there. */
function ensureParent(root: string, rel: string): void {
	let at = root;
	for (const seg of posix.dirname(rel.replace(/\\/g, '/')).split('/')) {
		if (seg === '.' || seg === '') continue;
		at = join(at, seg);
		let st;
		try {
			st = lstatSync(at);
		} catch {
			mkdirSync(at, { mode: 0o755 });
			continue;
		}
		if (st.isSymbolicLink())
			throw new Error('Refusing to write through a link in the destination.');
		if (!st.isDirectory()) throw new Error('A file is in the way of a folder in the destination.');
	}
}

function clearTarget(path: string): void {
	let st;
	try {
		st = lstatSync(path);
	} catch {
		return;
	}
	if (st.isDirectory() && !st.isSymbolicLink())
		throw new Error('A folder is in the way of a file in the destination.');
	unlinkSync(path);
}

/** Brings the entries of `srcRoot` into `destRoot`: files as hard links (read-only) when allowed and possible, else copies; links as links. */
function* materialize(
	srcRoot: string,
	destRoot: string,
	entries: Entry[],
	link: LinkMode,
	linkBoundary?: string
): Generator<void, RestoreResult> {
	ensureRoot(destRoot);
	const due = pacer();
	let linked = 0;
	let copied = 0;
	let canLink = link === 'auto';
	const order = (e: Entry) => (e.t === 'd' ? 0 : e.t === 'f' ? 1 : 2);
	for (const e of [...entries].sort((a, b) => order(a) - order(b))) {
		if (unsafePath(e.p)) continue;
		const to = join(destRoot, e.p);
		ensureParent(destRoot, e.p);
		if (e.t === 'd') {
			if (!existsSyncNoFollow(to)) mkdirSync(to, { mode: 0o755 });
		} else if (e.t === 'l') {
			// A dependency link resolves inside the restoring project only: no absolute target, no escape with ..
			if (
				linkBoundary &&
				(isAbsolute(e.to ?? '') || !insideDir(linkBoundary, resolve(dirname(to), e.to ?? '')))
			)
				throw new CacheCorruptError('a link points out of the project');
			clearTarget(to);
			// A folder link on Windows is a junction, which needs an absolute target made from where it now lives
			if (e.dir && process.platform === 'win32')
				symlinkSync(resolve(dirname(to), e.to ?? ''), to, 'junction');
			else symlinkSync(e.to ?? '', to, e.dir ? 'dir' : 'file');
		} else {
			const from = join(srcRoot, e.p);
			clearTarget(to);
			let done = false;
			if (canLink) {
				try {
					const mode = lstatSync(from).mode & 0o555;
					chmodSync(from, mode || 0o444);
					linkSync(from, to);
					done = true;
					linked++;
				} catch (err) {
					// A different volume or a file system without links: copy this and the rest
					const code = (err as NodeJS.ErrnoException).code;
					if (code === 'EXDEV' || code === 'ENOTSUP' || code === 'EPERM' || code === 'EMLINK')
						canLink = false;
				}
			}
			if (!done) {
				copyFileSync(from, to);
				chmodSync(to, (lstatSync(from).mode & 0o777) | 0o600);
				copied++;
			}
		}
		if (due(e.size ?? 0)) yield;
	}
	return { files: entries.filter((e) => e.t === 'f').length, linked, copied };
}

const existsSyncNoFollow = (path: string) => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

function* restoreEntry(
	entry: string,
	sub: string,
	dest: string,
	link: LinkMode,
	linkBoundary?: string
): Generator<void, RestoreResult | null> {
	if (!existsSync(join(entry, '.complete'))) return null;
	const release = acquireUse(entry);
	try {
		const manifest = readManifest(entry);
		if (!manifest) {
			quarantine(entry);
			throw new CacheCorruptError('the manifest is unreadable');
		}
		const root = join(entry, sub);
		try {
			yield* verify(root, manifest.entries);
		} catch (e) {
			if (e instanceof CacheCorruptError) quarantine(entry);
			throw e;
		}
		touch(entry);
		return yield* materialize(root, dest, manifest.entries, link, linkBoundary);
	} finally {
		release();
	}
}

/** Restores a kept build into `dest` (the folder the build ran in). Null when there is no entry. Throws CacheCorruptError for a damaged one. */
export function restoreBuild(
	cacheRoot: string,
	key: string,
	dest: string,
	opts: { link?: LinkMode } = {}
): RestoreResult | null {
	return runSync(restoreEntry(buildEntryDir(cacheRoot, key), 'files', dest, opts.link ?? 'auto'));
}
export const restoreBuildAsync = (
	cacheRoot: string,
	key: string,
	dest: string,
	opts: { link?: LinkMode } = {}
): Promise<RestoreResult | null> =>
	runAsync(restoreEntry(buildEntryDir(cacheRoot, key), 'files', dest, opts.link ?? 'auto'));

// -- DEPENDENCIES -- //

/** True when `path` is `base` or lies below it (both made absolute first). No link is followed. */
function insideDir(base: string, path: string): boolean {
	const rel = relative(resolve(base), resolve(path));
	return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Copies a dependency tree into the entry and lists it. Files are copied, folders made, and a link is NOT copied: it is recorded in the manifest as a
 * link relative to its own folder and made again on restore (Windows junctions hold an absolute target, which would point at the old project).
 * A link must resolve inside the project (the folder holding node_modules): a workspace link to packages/x is recreated relative, so it resolves into the
 * restoring run's own copy. Returns null when a link points outside the project, because such a tree cannot be moved.
 */
function* copyTree(srcRoot: string, dstRoot: string): Generator<void, Entry[] | null> {
	const out: Entry[] = [];
	const due = pacer();
	// A link may point anywhere inside the project (the folder holding node_modules), for example a yarn workspace package; never outside it
	const rootAbs = resolve(dirname(srcRoot));
	let ok = true;
	mkdirSync(dstRoot, { recursive: true });
	function* walk(rel: string): Generator<void> {
		for (const d of readdirSync(join(srcRoot, rel), { withFileTypes: true })) {
			const r = rel ? `${rel}/${d.name}` : d.name;
			const from = join(srcRoot, r);
			const st = lstatSync(from);
			if (st.isSymbolicLink()) {
				const raw = readlinkSync(from).replace(/^\\\\\?\\/, '');
				const abs = isAbsolute(raw) ? resolve(raw) : resolve(dirname(from), raw);
				if (!insideDir(rootAbs, abs)) ok = false;
				let dir = false;
				try {
					dir = statSync(abs).isDirectory();
				} catch {
					/* A link to nothing is kept as a file link */
				}
				out.push({ p: r, t: 'l', to: relative(dirname(from), abs).replace(/\\/g, '/'), dir });
			} else if (st.isDirectory()) {
				mkdirSync(join(dstRoot, r), { recursive: true });
				out.push({ p: r, t: 'd' });
				yield* walk(r);
			} else if (st.isFile()) {
				copyFileSync(from, join(dstRoot, r));
				out.push({ p: r, t: 'f', size: st.size });
				if (due(st.size)) yield;
			}
		}
	}
	yield* walk('');
	return ok ? out : null;
}

/**
 * Keeps the node_modules of `projectDir` under this key. Returns false when there is none, an entry exists, or a link in it points out of the tree
 * (such a tree cannot be moved). Files are checked by size on restore; the dependency tree is too large to hash on every run.
 */
export function publishDeps(cacheRoot: string, key: string, projectDir: string): boolean {
	return runSync(publishDepsGen(cacheRoot, key, projectDir));
}
export const publishDepsAsync = (
	cacheRoot: string,
	key: string,
	projectDir: string
): Promise<boolean> => runAsync(publishDepsGen(cacheRoot, key, projectDir));

function* publishDepsGen(
	cacheRoot: string,
	key: string,
	projectDir: string
): Generator<void, boolean> {
	const entry = depsEntryDir(cacheRoot, key);
	if (hasEntry(cacheRoot, 'deps', key)) return false;
	const src = join(projectDir, 'node_modules');
	try {
		if (!lstatSync(src).isDirectory()) return false;
	} catch {
		return false;
	}
	const tmp = `${entry}.tmp-${process.pid}-${Date.now()}`;
	try {
		mkdirSync(tmp, { recursive: true });
		const entries = yield* copyTree(src, join(tmp, 'node_modules'));
		if (!entries) {
			removeEntry(tmp);
			return false;
		}
		writeFileSync(
			join(tmp, 'manifest.json'),
			JSON.stringify({ version: 1, entries } satisfies Manifest)
		);
		return finish(tmp, entry);
	} catch {
		removeEntry(tmp);
		return false;
	}
}

/** Restores kept dependencies as `<destDir>/node_modules`. Null when there is no entry. Throws CacheCorruptError for a damaged one. */
export function restoreDeps(
	cacheRoot: string,
	key: string,
	destDir: string,
	opts: { link?: LinkMode } = {}
): RestoreResult | null {
	return runSync(
		restoreEntry(
			depsEntryDir(cacheRoot, key),
			'node_modules',
			join(destDir, 'node_modules'),
			opts.link ?? 'auto',
			destDir
		)
	);
}
export const restoreDepsAsync = (
	cacheRoot: string,
	key: string,
	destDir: string,
	opts: { link?: LinkMode } = {}
): Promise<RestoreResult | null> =>
	runAsync(
		restoreEntry(
			depsEntryDir(cacheRoot, key),
			'node_modules',
			join(destDir, 'node_modules'),
			opts.link ?? 'auto',
			destDir
		)
	);

// -- IN-USE MARKERS AND EVICTION -- //

/** Marks an entry as being read right now. Eviction leaves it alone while the process lives. Call the returned function when done (safe twice). */
export function acquireUse(entry: string): () => void {
	const dir = join(entry, 'use');
	const token = randomBytes(6).toString('hex');
	const file = join(dir, `${process.pid}-${token}.json`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			file,
			JSON.stringify({
				pid: process.pid,
				start: new Date().toISOString(),
				token
			} satisfies UseMarker)
		);
		touch(entry);
	} catch {
		/* An entry that cannot be marked is protected by its recent use time */
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		rmSync(file, { force: true });
	};
}

/** True when a live process has marked this entry. Markers of dead processes, or older than 6 hours, are removed. */
function inUse(entry: string): boolean {
	const dir = join(entry, 'use');
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return false;
	}
	let live = false;
	for (const n of names) {
		const file = join(dir, n);
		try {
			const m = JSON.parse(readFileSync(file, 'utf8')) as Partial<UseMarker>;
			const age = Date.now() - Date.parse(m.start ?? '');
			if (typeof m.pid === 'number' && pidAlive(m.pid) && age < USE_MARKER_MAX_MS) live = true;
			else rmSync(file, { force: true });
		} catch {
			// Written whole by the owner, so an unreadable marker is damaged: dropped once it is old
			try {
				if (Date.now() - lstatSync(file).mtimeMs > 60_000) rmSync(file, { force: true });
			} catch {
				/* Gone */
			}
		}
	}
	return live;
}

/**
 * Removes the oldest kept builds and dependencies beyond the number kept, and anything older than `maxAgeDays`. Never removes an entry with a live in-use
 * marker or one used in the last 10 minutes. Half-written `.tmp-` entries (and entries without a .complete note) go after an hour. Returns what was removed.
 */
export function evict(cacheRoot: string, opts: EvictOptions = {}): { removed: string[] } {
	const now = opts.now ?? Date.now();
	const maxAge = (opts.maxAgeDays ?? 14) * DAY_MS;
	const removed: string[] = [];
	for (const [kind, keep] of [
		['builds', opts.builds ?? KEEP_BUILDS],
		['deps', opts.deps ?? KEEP_DEPS]
	] as const) {
		const dir = join(cacheRoot, kind);
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		const done: { name: string; path: string; idle: number }[] = [];
		for (const name of names) {
			const path = join(dir, name);
			let idle: number;
			try {
				idle = now - lstatSync(path).mtimeMs;
			} catch {
				continue;
			}
			if (name.includes('.tmp-') || !existsSync(join(path, '.complete'))) {
				if (idle > TMP_MAX_AGE_MS && removeEntry(path)) removed.push(`${kind}/${name}`);
			} else {
				done.push({ name, path, idle });
			}
		}
		done.sort((a, b) => a.idle - b.idle);
		done.forEach((e, i) => {
			if (e.idle < RECENT_USE_MS || inUse(e.path)) return;
			if ((i >= keep || e.idle > maxAge) && removeEntry(e.path)) removed.push(`${kind}/${e.name}`);
		});
	}
	return { removed };
}

/**
 * Runs a restore and turns a damaged entry into "nothing to restore" (null), so the caller installs or builds instead of failing the run. The entry was already set
 * aside by the restore. Any other error is thrown.
 */
export async function restoreOrNull<T>(
	what: string,
	restore: () => Promise<T | null>,
	log: (line: string) => void
): Promise<T | null> {
	try {
		return await restore();
	} catch (e) {
		if (!(e instanceof CacheCorruptError)) throw e;
		log(`The kept ${what} was damaged and set aside; making it again.`);
		return null;
	}
}
