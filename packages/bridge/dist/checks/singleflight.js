// SINGLE-FLIGHT FOR BUILDS AND INSTALLS ACROSS PROCESSES: WHEN SEVERAL RUNS NEED THE SAME THING, ONE BUILDS AND THE OTHERS WAIT FOR ITS RESULT.
// The lock is a file made whole and linked into place (like lock.ts). Its body holds the process id, the process start time, a token and a HEARTBEAT that the
// builder refreshes on an unref'd timer. A lock is stale only when its heartbeat is missing for `staleMs`: never because a process id looks dead or alive,
// because Windows reuses process ids. The builder writes its outcome to a result file named by its token BEFORE it gives the lock back, so a waiter that sees
// the lock go away reads what happened: a success is handed to every waiter, a deterministic failure is handed to every waiter as the same error, and an
// infrastructure failure (the work threw an error marked `infra: true`) makes one waiter the next builder. A builder that died leaves no result: the lock
// goes stale and one waiter takes it over. The work should be async (spawned processes), because a blocked event loop cannot beat.
// -- DEP-MODULES -- //
import { randomBytes } from 'node:crypto';
import { linkSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { assertName, ensureDir, locksDir } from './paths.js';
/** Marks a failure of the machine (a full disk, a killed process, a network error) rather than of the code being built: one waiter tries again. */
export class InfraError extends Error {
    infra = true;
    constructor(message, options) {
        super(message, options);
        this.name = 'InfraError';
    }
}
/** What every waiter gets when the builder failed deterministically: the same name and message, not a retry. */
export class SharedBuildError extends Error {
    shared = true;
    originalName;
    constructor(name, message) {
        super(message);
        this.name = 'SharedBuildError';
        this.originalName = name;
    }
}
/** This caller waited as long as it was allowed to for a build that did not finish. */
export class FlightTimeoutError extends Error {
    code = 'FLIGHT_TIMEOUT';
    constructor(name, ms) {
        super(`Gave up waiting ${Math.round(ms / 1000)} seconds for the build "${name}" of another run.`);
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lockFile = (name) => join(locksDir(), `sf-${assertName(name, 'flight name')}.lock`);
const resultFile = (name, token) => join(locksDir(), `sf-${assertName(name, 'flight name')}.${token}.result`);
function readText(file) {
    try {
        return readFileSync(file, 'utf8');
    }
    catch {
        return null;
    }
}
function parseBody(text) {
    if (text === null)
        return null;
    try {
        const v = JSON.parse(text);
        if (!v ||
            typeof v.pid !== 'number' ||
            typeof v.start !== 'string' ||
            typeof v.beat !== 'string' ||
            typeof v.token !== 'string')
            return null;
        return { pid: v.pid, start: v.start, beat: v.beat, token: v.token };
    }
    catch {
        return null;
    }
}
/** Stale by a missing heartbeat only. The process id is never looked at. */
function isStale(text, file, staleMs) {
    const body = parseBody(text);
    if (body) {
        const beat = Date.parse(body.beat);
        return !Number.isFinite(beat) || Date.now() - beat > staleMs;
    }
    try {
        return Date.now() - statSync(file).mtimeMs > UNREADABLE_GRACE_MS;
    }
    catch {
        return false;
    }
}
/** Writes a file whole: a temporary file renamed into place, so a reader never sees half of it. */
function writeWhole(file, text) {
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    try {
        renameSync(tmp, file);
    }
    catch (e) {
        rmSync(tmp, { force: true });
        throw e;
    }
}
/** Creates the lock file with its whole content at once. False when somebody holds it. */
function tryCreate(file, text) {
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    try {
        linkSync(tmp, file);
        return true;
    }
    catch (e) {
        if (e.code === 'EEXIST')
            return false;
        throw e;
    }
    finally {
        rmSync(tmp, { force: true });
    }
}
/** Moves the lock aside in one step, so of two contenders only one moves it. A fresh lock that was moved by mistake is linked back. */
function moveAside(file, expected, staleMs) {
    const aside = `${file}.aside.${process.pid}.${randomBytes(4).toString('hex')}`;
    try {
        renameSync(file, aside);
    }
    catch {
        return;
    }
    const moved = readText(aside);
    if (moved !== null && moved !== expected && !isStale(moved, aside, staleMs)) {
        try {
            linkSync(aside, file);
        }
        catch {
            /* A newer lock is already there */
        }
    }
    rmSync(aside, { force: true });
}
const bodyText = (token, beat) => JSON.stringify({
    pid: process.pid,
    start: PROCESS_START,
    beat: beat.toISOString(),
    token
}) + '\n';
/** Takes the lock without waiting. Returns the token, or null when somebody with a fresh heartbeat holds it. */
function tryAcquire(name, staleMs) {
    const file = lockFile(name);
    ensureDir(locksDir());
    const token = randomBytes(8).toString('hex');
    const mine = bodyText(token, new Date());
    for (let attempt = 0; attempt < 6; attempt++) {
        if (tryCreate(file, mine))
            return token;
        const held = readText(file);
        if (held === null)
            continue; // Released between the two looks
        if (!isStale(held, file, staleMs))
            return null;
        moveAside(file, held, staleMs);
    }
    return null;
}
/** Gives the lock back, but only when it still carries our token (it may have been taken over after a long pause). */
function release(name, token, staleMs) {
    const file = lockFile(name);
    const text = readText(file);
    if (parseBody(text)?.token !== token)
        return;
    const aside = `${file}.aside.${process.pid}.${randomBytes(4).toString('hex')}`;
    try {
        renameSync(file, aside);
    }
    catch {
        return;
    }
    const moved = readText(aside);
    if (moved !== null && parseBody(moved)?.token !== token && !isStale(moved, aside, staleMs)) {
        try {
            linkSync(aside, file);
        }
        catch {
            /* A newer lock is already there */
        }
    }
    rmSync(aside, { force: true });
}
/** Refreshes the heartbeat of our lock. Returns false when the lock is no longer ours. */
function beat(name, token) {
    const file = lockFile(name);
    const body = parseBody(readText(file));
    if (!body)
        return true; // Unreadable for a moment: try again on the next beat
    if (body.token !== token)
        return false;
    try {
        writeWhole(file, bodyText(token, new Date()));
    }
    catch {
        /* Windows may refuse the swap while a reader has the file open: the next beat tries again */
    }
    return true;
}
function readOutcome(name, token) {
    const text = readText(resultFile(name, token));
    if (text === null)
        return null;
    try {
        const v = JSON.parse(text);
        return v && typeof v === 'object' && typeof v.ok === 'boolean' ? v : null;
    }
    catch {
        return null;
    }
}
function purgeOldResults(name) {
    const prefix = `sf-${name}.`;
    try {
        for (const n of readdirSync(locksDir())) {
            if (!n.startsWith(prefix) || !n.endsWith('.result'))
                continue;
            const f = join(locksDir(), n);
            try {
                if (Date.now() - statSync(f).mtimeMs > RESULT_KEEP_MS)
                    rmSync(f, { force: true });
            }
            catch {
                /* Gone */
            }
        }
    }
    catch {
        /* No folder yet */
    }
}
const isInfra = (e) => !!e && typeof e === 'object' && e.infra === true;
/**
 * Runs `work` once for everybody who asks for `name` at the same time, across processes. The caller that takes the lock is the builder and its `work`
 * result (which must be JSON-serialisable, for example a cache key) is handed to the waiters. See the header of this file for failures and crashes.
 */
export async function singleFlight(name, work, opts = {}) {
    const heartbeatMs = opts.heartbeatMs ?? 2_000;
    const staleMs = Math.max(opts.staleMs ?? 15_000, heartbeatMs * 5);
    const waiterLimitMs = opts.waiterLimitMs ?? 10 * 60_000;
    const pollMs = opts.pollMs ?? 100;
    lockFile(name); // Refuses a name that is not plain before anything is made
    const deadline = Date.now() + waiterLimitMs;
    let watched = null;
    const handled = new Set();
    for (;;) {
        // 1. The outcome of the build we are waiting for, written before its lock was given back
        if (watched && !handled.has(watched)) {
            const out = readOutcome(name, watched);
            if (out) {
                if (out.ok)
                    return { role: 'waiter', result: out.value };
                if (!out.infra)
                    throw new SharedBuildError(out.name, out.message);
                handled.add(watched); // An infrastructure failure: whoever takes the lock first builds again
                watched = null;
            }
        }
        if (opts.signal?.aborted)
            throw new Error('The run was stopped.');
        // 2. Take the lock and build
        const token = tryAcquire(name, staleMs);
        if (token)
            return runBuilder(name, token, work, heartbeatMs, staleMs);
        // 3. Somebody else builds: remember which build, look again soon
        const body = parseBody(readText(lockFile(name)));
        if (body && !handled.has(body.token))
            watched = body.token;
        if (Date.now() >= deadline)
            throw new FlightTimeoutError(name, waiterLimitMs);
        await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
}
async function runBuilder(name, token, work, heartbeatMs, staleMs) {
    purgeOldResults(name);
    let lost = false;
    const timer = setInterval(() => {
        if (!lost && !beat(name, token))
            lost = true;
    }, heartbeatMs);
    timer.unref();
    const record = (outcome) => {
        try {
            writeWhole(resultFile(name, token), JSON.stringify(outcome));
        }
        catch {
            /* Waiters then find no outcome and the lock going away: the next one builds */
        }
    };
    try {
        const value = await work();
        record({ ok: true, value: value ?? null });
        return { role: 'builder', result: value };
    }
    catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        record({ ok: false, infra: isInfra(e), name: err.name, message: err.message });
        throw e;
    }
    finally {
        clearInterval(timer);
        release(name, token, staleMs);
    }
}
