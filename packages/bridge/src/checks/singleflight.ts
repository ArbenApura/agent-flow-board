// SINGLE-FLIGHT FOR BUILDS AND INSTALLS ACROSS PROCESSES: WHEN SEVERAL RUNS NEED THE SAME THING, ONE BUILDS AND THE OTHERS WAIT FOR ITS RESULT.
// The lock is a file made whole and linked into place (like lock.ts). Its body holds the process id, the process start time, a token and a HEARTBEAT that the
// builder refreshes on an unref'd timer. A lock is stale only when its heartbeat is missing for `staleMs`: never because a process id looks dead or alive,
// because Windows reuses process ids. The builder writes its outcome to a result file named by its token BEFORE it gives the lock back, so a waiter that sees
// the lock go away reads what happened: a success is handed to every waiter, a deterministic failure is handed to every waiter as the same error, and an
// infrastructure failure (the work threw an error marked `infra: true`) makes one waiter the next builder. A builder that died leaves no result: the lock
// goes stale and one waiter takes it over. The work should be async (spawned processes), because a blocked event loop cannot beat.

// -- DEP-MODULES -- //
import { randomBytes } from 'node:crypto';
import {
	linkSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { assertName, ensureDir, locksDir } from './paths.js';

// -- TYPES -- //

export type FlightOptions = {
	/** How often the builder refreshes its heartbeat. Default 2 s. */
	heartbeatMs?: number;
	/** A lock whose heartbeat is older than this is taken over. Default: 15 s, never under 5 heartbeats. */
	staleMs?: number;
	/** How long this caller waits for somebody else's build before giving up. Default 10 minutes. Does not limit `work` when this caller is the builder. */
	waiterLimitMs?: number;
	/** How often a waiter looks. Default 100 ms. */
	pollMs?: number;
	/** A caller that stops waiting (a stopped run) leaves the loop with an error instead of taking a turn as builder. */
	signal?: AbortSignal;
};
export type FlightResult<T> = { role: 'builder' | 'waiter'; result: T };
type LockBody = { pid: number; start: string; beat: string; token: string };
type Outcome =
	{ ok: true; value: unknown } | { ok: false; infra: boolean; name: string; message: string };

/** Marks a failure of the machine (a full disk, a killed process, a network error) rather than of the code being built: one waiter tries again. */
export class InfraError extends Error {
	readonly infra = true;
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'InfraError';
	}
}

/** What every waiter gets when the builder failed deterministically: the same name and message, not a retry. */
export class SharedBuildError extends Error {
	readonly shared = true;
	readonly originalName: string;
	constructor(name: string, message: string) {
		super(message);
		this.name = 'SharedBuildError';
		this.originalName = name;
	}
}

/** This caller waited as long as it was allowed to for a build that did not finish. */
export class FlightTimeoutError extends Error {
	readonly code = 'FLIGHT_TIMEOUT';
	constructor(name: string, ms: number) {
		super(
			`Gave up waiting ${Math.round(ms / 1000)} seconds for the build "${name}" of another run.`
		);
		this.name = 'FlightTimeoutError';
	}
}

// -- CONSTANTS -- //

/** A lock whose content cannot be read is only stale after this long (it is made whole, so this means a damaged file). */
const UNREADABLE_GRACE_MS = 2_000;
/** Result files are kept this long for slow waiters, then removed by the next builder. */
const RESULT_KEEP_MS = 10 * 60_000;
/** When this process started, to the nearest few milliseconds. */
const PROCESS_START = new Date(Date.now() - process.uptime() * 1000).toISOString();

// -- FUNCTIONS -- //

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const lockFile = (name: string) => join(locksDir(), `sf-${assertName(name, 'flight name')}.lock`);
const resultFile = (name: string, token: string) =>
	join(locksDir(), `sf-${assertName(name, 'flight name')}.${token}.result`);

function readText(file: string): string | null {
	try {
		return readFileSync(file, 'utf8');
	} catch {
		return null;
	}
}

function parseBody(text: string | null): LockBody | null {
	if (text === null) return null;
	try {
		const v = JSON.parse(text) as Partial<LockBody>;
		if (
			!v ||
			typeof v.pid !== 'number' ||
			typeof v.start !== 'string' ||
			typeof v.beat !== 'string' ||
			typeof v.token !== 'string'
		)
			return null;
		return { pid: v.pid, start: v.start, beat: v.beat, token: v.token };
	} catch {
		return null;
	}
}

/** Stale by a missing heartbeat only. The process id is never looked at. */
function isStale(text: string | null, file: string, staleMs: number): boolean {
	const body = parseBody(text);
	if (body) {
		const beat = Date.parse(body.beat);
		return !Number.isFinite(beat) || Date.now() - beat > staleMs;
	}
	try {
		return Date.now() - statSync(file).mtimeMs > UNREADABLE_GRACE_MS;
	} catch {
		return false;
	}
}

/** Writes a file whole: a temporary file renamed into place, so a reader never sees half of it. */
function writeWhole(file: string, text: string): void {
	const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	try {
		renameSync(tmp, file);
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
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

/** Moves the lock aside in one step, so of two contenders only one moves it. A fresh lock that was moved by mistake is linked back. */
function moveAside(file: string, expected: string | null, staleMs: number): void {
	const aside = `${file}.aside.${process.pid}.${randomBytes(4).toString('hex')}`;
	try {
		renameSync(file, aside);
	} catch {
		return;
	}
	const moved = readText(aside);
	if (moved !== null && moved !== expected && !isStale(moved, aside, staleMs)) {
		try {
			linkSync(aside, file);
		} catch {
			/* A newer lock is already there */
		}
	}
	rmSync(aside, { force: true });
}

const bodyText = (token: string, beat: Date) =>
	JSON.stringify({
		pid: process.pid,
		start: PROCESS_START,
		beat: beat.toISOString(),
		token
	} satisfies LockBody) + '\n';

/** Takes the lock without waiting. Returns the token, or null when somebody with a fresh heartbeat holds it. */
function tryAcquire(name: string, staleMs: number): string | null {
	const file = lockFile(name);
	ensureDir(locksDir());
	const token = randomBytes(8).toString('hex');
	const mine = bodyText(token, new Date());
	for (let attempt = 0; attempt < 6; attempt++) {
		if (tryCreate(file, mine)) return token;
		const held = readText(file);
		if (held === null) continue; // Released between the two looks
		if (!isStale(held, file, staleMs)) return null;
		moveAside(file, held, staleMs);
	}
	return null;
}

/** Gives the lock back, but only when it still carries our token (it may have been taken over after a long pause). */
function release(name: string, token: string, staleMs: number): void {
	const file = lockFile(name);
	const text = readText(file);
	if (parseBody(text)?.token !== token) return;
	const aside = `${file}.aside.${process.pid}.${randomBytes(4).toString('hex')}`;
	try {
		renameSync(file, aside);
	} catch {
		return;
	}
	const moved = readText(aside);
	if (moved !== null && parseBody(moved)?.token !== token && !isStale(moved, aside, staleMs)) {
		try {
			linkSync(aside, file);
		} catch {
			/* A newer lock is already there */
		}
	}
	rmSync(aside, { force: true });
}

/** Refreshes the heartbeat of our lock. Returns false when the lock is no longer ours. */
function beat(name: string, token: string): boolean {
	const file = lockFile(name);
	const body = parseBody(readText(file));
	if (!body) return true; // Unreadable for a moment: try again on the next beat
	if (body.token !== token) return false;
	try {
		writeWhole(file, bodyText(token, new Date()));
	} catch {
		/* Windows may refuse the swap while a reader has the file open: the next beat tries again */
	}
	return true;
}

function readOutcome(name: string, token: string): Outcome | null {
	const text = readText(resultFile(name, token));
	if (text === null) return null;
	try {
		const v = JSON.parse(text) as Outcome;
		return v && typeof v === 'object' && typeof v.ok === 'boolean' ? v : null;
	} catch {
		return null;
	}
}

function purgeOldResults(name: string): void {
	const prefix = `sf-${name}.`;
	try {
		for (const n of readdirSync(locksDir())) {
			if (!n.startsWith(prefix) || !n.endsWith('.result')) continue;
			const f = join(locksDir(), n);
			try {
				if (Date.now() - statSync(f).mtimeMs > RESULT_KEEP_MS) rmSync(f, { force: true });
			} catch {
				/* Gone */
			}
		}
	} catch {
		/* No folder yet */
	}
}

const isInfra = (e: unknown) =>
	!!e && typeof e === 'object' && (e as { infra?: unknown }).infra === true;

/**
 * Runs `work` once for everybody who asks for `name` at the same time, across processes. The caller that takes the lock is the builder and its `work`
 * result (which must be JSON-serialisable, for example a cache key) is handed to the waiters. See the header of this file for failures and crashes.
 */
export async function singleFlight<T>(
	name: string,
	work: () => Promise<T>,
	opts: FlightOptions = {}
): Promise<FlightResult<T>> {
	const heartbeatMs = opts.heartbeatMs ?? 2_000;
	const staleMs = Math.max(opts.staleMs ?? 15_000, heartbeatMs * 5);
	const waiterLimitMs = opts.waiterLimitMs ?? 10 * 60_000;
	const pollMs = opts.pollMs ?? 100;
	lockFile(name); // Refuses a name that is not plain before anything is made
	const deadline = Date.now() + waiterLimitMs;
	let watched: string | null = null;
	const handled = new Set<string>();

	for (;;) {
		// 1. The outcome of the build we are waiting for, written before its lock was given back
		if (watched && !handled.has(watched)) {
			const out = readOutcome(name, watched);
			if (out) {
				if (out.ok) return { role: 'waiter', result: out.value as T };
				if (!out.infra) throw new SharedBuildError(out.name, out.message);
				handled.add(watched); // An infrastructure failure: whoever takes the lock first builds again
				watched = null;
			}
		}
		if (opts.signal?.aborted) throw new Error('The run was stopped.');
		// 2. Take the lock and build
		const token = tryAcquire(name, staleMs);
		if (token) return runBuilder(name, token, work, heartbeatMs, staleMs);
		// 3. Somebody else builds: remember which build, look again soon
		const body = parseBody(readText(lockFile(name)));
		if (body && !handled.has(body.token)) watched = body.token;
		if (Date.now() >= deadline) throw new FlightTimeoutError(name, waiterLimitMs);
		await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
	}
}

async function runBuilder<T>(
	name: string,
	token: string,
	work: () => Promise<T>,
	heartbeatMs: number,
	staleMs: number
): Promise<FlightResult<T>> {
	purgeOldResults(name);
	let lost = false;
	const timer = setInterval(() => {
		if (!lost && !beat(name, token)) lost = true;
	}, heartbeatMs);
	timer.unref();
	const record = (outcome: Outcome) => {
		try {
			writeWhole(resultFile(name, token), JSON.stringify(outcome));
		} catch {
			/* Waiters then find no outcome and the lock going away: the next one builds */
		}
	};
	try {
		const value = await work();
		record({ ok: true, value: value ?? null });
		return { role: 'builder', result: value };
	} catch (e) {
		const err = e instanceof Error ? e : new Error(String(e));
		record({ ok: false, infra: isInfra(e), name: err.name, message: err.message });
		throw e;
	} finally {
		clearInterval(timer);
		release(name, token, staleMs);
	}
}
