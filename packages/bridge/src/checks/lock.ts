// FILE LOCKS FOR THE CHECK COMMANDS: A SHORT EXCLUSIVE LOCK (THE AUDIT CHAIN) AND THE ONE-WORKER-PER-MACHINE LOCK OF `check watch`.
// Two lessons are built in. A lock file that is created empty and written afterwards looks stale to a second process, so the file is written whole into a
// temporary file and linked into place in one step. A stale lock that is unlinked and then created again lets two contenders in, so a stale lock is RENAMED
// aside, what was moved is compared with the stale one that was seen, and a fresh lock that was moved by mistake is put back.

// -- DEP-MODULES -- //
import { randomBytes } from 'node:crypto';
import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { assertName, ensureDir, locksDir } from './paths.js';

// -- TYPES -- //

export type Lock = {
	/** The lock file. */
	readonly file: string;
	/** Gives the lock back. Safe to call twice, and never removes a lock that now belongs to somebody else. */
	release(): void;
};
type LockBody = { pid: number; at: string; token: string };

// -- CONSTANTS -- //

/** A lock whose content cannot be read is only treated as stale after this long (it is created whole, so this means a damaged file). */
const UNREADABLE_GRACE_MS = 2_000;
/** For a lock that only a dead process may lose, such as the worker lock. */
export const NEVER_STALE_MS = Number.MAX_SAFE_INTEGER;

// -- FUNCTIONS -- //

/** True when a process with this id exists (it may belong to another user, which still counts as alive). */
export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM';
	}
}

const lockPath = (name: string) => join(locksDir(), `${assertName(name, 'lock name')}.lock`);

function parseBody(text: string): LockBody | null {
	try {
		const v: unknown = JSON.parse(text);
		if (!v || typeof v !== 'object') return null;
		const b = v as Partial<LockBody>;
		if (typeof b.pid !== 'number' || typeof b.at !== 'string' || typeof b.token !== 'string')
			return null;
		return { pid: b.pid, at: b.at, token: b.token };
	} catch {
		return null;
	}
}

function readText(file: string): string | null {
	try {
		return readFileSync(file, 'utf8');
	} catch {
		return null;
	}
}

function isStale(text: string | null, file: string, staleMs: number): boolean {
	const body = text === null ? null : parseBody(text);
	if (body) return !pidAlive(body.pid) || Date.now() - Date.parse(body.at) > staleMs;
	// Unreadable or damaged: given a moment, then stale
	try {
		return Date.now() - statSync(file).mtimeMs > UNREADABLE_GRACE_MS;
	} catch {
		return false;
	}
}

/** Creates the lock file with its whole content at once. False when somebody holds it. */
function tryCreate(file: string, text: string): boolean {
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	try {
		linkSync(tmp, file);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
		throw e;
	} finally {
		rmSync(tmp, { force: true });
	}
}

/**
 * Moves the lock file aside under a name of its own. Returns what was moved, or null when somebody else moved it first. When what was moved is not
 * `expected` (somebody made a new lock between the look and the move), it is linked back.
 */
function moveAside(
	file: string,
	expected: string | null,
	keep: (moved: string) => boolean
): string | null {
	const aside = `${file}.aside.${process.pid}.${randomBytes(4).toString('hex')}`;
	try {
		renameSync(file, aside);
	} catch {
		return null;
	}
	const moved = readText(aside);
	if (moved !== null && moved !== expected && keep(moved)) {
		try {
			linkSync(aside, file);
		} catch {
			/* A newer lock is already there: the one that was moved is dropped */
		}
	}
	rmSync(aside, { force: true });
	return moved ?? '';
}

/**
 * Takes the lock `name` without waiting. Returns null when a live holder has it. A lock whose process is gone, or that is older than `staleMs`,
 * is taken over.
 */
export function acquireLock(name: string, { staleMs }: { staleMs: number }): Lock | null {
	const file = lockPath(name);
	ensureDir(locksDir());
	const token = randomBytes(8).toString('hex');
	const mine =
		JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token } satisfies LockBody) +
		'\n';
	for (let attempt = 0; attempt < 6; attempt++) {
		if (tryCreate(file, mine)) return makeLock(file, token);
		const held = readText(file);
		if (held === null && !statExists(file)) continue; // Released between the two looks
		if (!isStale(held, file, staleMs)) return null;
		// Stale: moved aside in one step, so of two contenders only one moves it. A fresh lock that was moved by mistake goes back
		moveAside(file, held, (moved) => !isStale(moved, file, staleMs));
	}
	return null;
}

const statExists = (file: string) => {
	try {
		statSync(file);
		return true;
	} catch {
		return false;
	}
};

function makeLock(file: string, token: string): Lock {
	let released = false;
	return {
		file,
		release() {
			if (released) return;
			released = true;
			// Moved aside first, so a lock that was taken over from us in the meantime is never removed by mistake
			const text = readText(file);
			if (text === null || parseBody(text)?.token !== token) return;
			moveAside(file, text, () => true);
		}
	};
}

const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs `fn` while holding the lock, waiting up to `waitMs` for another holder. Throws one plain sentence when it could not get the lock. */
export function withLockSync<T>(
	name: string,
	fn: () => T,
	{ staleMs = 15_000, waitMs = 20_000 } = {}
): T {
	const until = Date.now() + waitMs;
	let lock = acquireLock(name, { staleMs });
	while (!lock) {
		if (Date.now() > until)
			throw new Error(
				`Another process kept the "${name}" lock for more than ${Math.round(waitMs / 1000)} seconds.`
			);
		nap(15);
		lock = acquireLock(name, { staleMs });
	}
	try {
		return fn();
	} finally {
		lock.release();
	}
}

/** The process id that holds a lock, or null when nobody does. For the plain sentence of a refused second worker. */
export function lockHolderPid(name: string): number | null {
	const text = readText(lockPath(name));
	const body = text === null ? null : parseBody(text);
	return body && pidAlive(body.pid) ? body.pid : null;
}

/**
 * The one-worker-per-machine lock of `check watch`. Only a dead process loses it (the work inside runs for hours), so the stale age is never reached.
 * Returns null when another worker holds it; the caller says so in one plain line.
 */
export function machineLock(name: string): Lock | null {
	return acquireLock(`machine-${name}`, { staleMs: NEVER_STALE_MS });
}
