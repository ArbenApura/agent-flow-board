// THE THINGS ONE RUN OWNS, AND WHAT HAPPENS TO THEM WHEN THE RUN ENDS, WHATEVER ENDS IT.
// The layer that makes the resources writes a live marker file first (markers/<run id>.json, in a folder the sandboxed check cannot reach: the process id, the
// start time and what the run made that a crash would leave behind: the preview process, the database container and the private copy). Resources are closed newest first and closing never throws.
// A later run sweeps what a dead process left: only the exact run folders and copies named by a dead marker (or by no marker and old enough), never a
// folder that was not made by a run.
// -- DEP-MODULES -- //
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { pidAlive } from './lock.js';
import { NAME, copiesDir, endedPath, ensureDir, logDirFor, logsDir, markerPath, markersDir, runsDir, under } from './paths.js';
import { dropPooledDatabase, pooledNames } from './dbpool.js';
import { renameRetry } from './fsretry.js';
import { CONTAINER_PREFIX, removeContainer } from './provision.js';
// -- CONSTANTS -- //
/** A run folder with no marker is only an orphan after this long (the marker is written first, so younger ones are being made right now). */
const NO_MARKER_GRACE_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
// -- FUNCTIONS -- //
/** 'r' + a timestamp + random characters: a plain name, and sortable by time. */
export const newRunId = () => 'r' + Date.now().toString(36) + randomBytes(3).toString('hex');
const noop = () => { };
/** Writes a file whole: a temporary file renamed into place, so a reader never sees half of it. */
function writeWhole(file, text) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameRetry(tmp, file);
}
/**
 * Reads the marker of a run and checks it against what the tool itself would have written for that run id. A field that names anything else (a database,
 * a role, a container, a process that is older than the run) is dropped and a note says so, so a marker can never make a sweep touch something that is not the
 * run's own. A marker that does not hold a process id and its own run id is not a marker (null).
 */
export function readMarker(runId) {
    let v;
    try {
        v = JSON.parse(readFileSync(markerPath(runId), 'utf8'));
    }
    catch {
        return null;
    }
    if (!v || typeof v !== 'object')
        return null;
    const m = v;
    if (typeof m.pid !== 'number' || m.runId !== runId)
        return null;
    const startedAt = typeof m.startedAt === 'string' ? m.startedAt : '';
    const notes = [];
    const out = { runId, pid: m.pid, startedAt };
    if (m.previewPid !== undefined) {
        const spawned = Date.parse(String(m.previewStartedAt ?? ''));
        if (Number.isInteger(m.previewPid) &&
            m.previewPid > 1 &&
            m.previewPid !== m.pid &&
            Number.isFinite(spawned) &&
            spawned >= Date.parse(startedAt) - 1000) {
            out.previewPid = m.previewPid;
            out.previewStartedAt = String(m.previewStartedAt);
        }
        else
            notes.push(`The marker of run ${runId} names a preview process that does not check out, so it was ignored.`);
    }
    if (m.containerName !== undefined) {
        if (m.containerName === `${CONTAINER_PREFIX}${runId}`)
            out.containerName = m.containerName;
        else
            notes.push(`The marker of run ${runId} names a container that is not the one this run makes, so it was ignored.`);
    }
    if (m.dbName !== undefined || m.roleName !== undefined || m.poolId !== undefined) {
        const names = pooledNames(runId);
        if (m.dbName === names.dbName &&
            m.roleName === names.roleName &&
            typeof m.poolId === 'string' &&
            NAME.test(m.poolId)) {
            out.dbName = m.dbName;
            out.roleName = m.roleName;
            out.poolId = m.poolId;
        }
        else
            notes.push(`The marker of run ${runId} names a database or role that is not this run's, so it was ignored.`);
    }
    if (typeof m.copyDir === 'string')
        out.copyDir = m.copyDir;
    return { marker: out, notes };
}
export class RunScope {
    runId;
    disposers = [];
    log;
    info = {};
    started = false;
    closed = false;
    constructor(runId = newRunId(), log = noop) {
        if (!NAME.test(runId))
            throw new Error('The run id is not a plain name.');
        this.runId = runId;
        this.log = log;
    }
    /** The folder of this run. */
    get dir() {
        return under(runsDir(), this.runId);
    }
    /** Writes the live marker. Called before anything else is made; every method that makes a resource calls it too, so it can never be skipped. */
    start() {
        if (this.started)
            return;
        ensureDir(this.dir);
        ensureDir(markersDir());
        ensureDir(logDirFor(this.runId));
        this.started = true;
        this.writeMarker();
    }
    writeMarker() {
        const marker = {
            runId: this.runId,
            pid: process.pid,
            startedAt: new Date().toISOString(),
            ...this.info
        };
        writeWhole(markerPath(this.runId), JSON.stringify(marker) + '\n');
    }
    /** Records what a crash would leave behind (the preview process id, the database container, the private copy) so a later sweep can remove it. */
    setInfo(info) {
        // After the scope closed nothing may rewrite the marker: it was removed with the run
        if (this.closed)
            return;
        this.start();
        const stamped = info.previewPid !== undefined && info.previewStartedAt === undefined
            ? { ...info, previewStartedAt: new Date().toISOString() }
            : info;
        this.info = { ...this.info, ...stamped };
        this.writeMarker();
    }
    /** Registers a resource. It is closed when the scope closes, newest first. */
    add(name, dispose) {
        // A resource made after the scope closed is closed at once: nothing will come back to do it
        if (this.closed) {
            void Promise.resolve()
                .then(dispose)
                .catch(() => this.log(`Could not close ${name}.`));
            return;
        }
        this.start();
        this.disposers.push({ name, dispose });
    }
    /** Closes every resource newest first, then removes the marker. Never throws; a failure goes to the log. Safe to call twice. */
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        while (this.disposers.length) {
            const item = this.disposers.pop();
            if (!item)
                break;
            try {
                await item.dispose();
            }
            catch {
                this.log(`Could not close ${item.name}.`);
            }
        }
        try {
            if (this.started) {
                writeWhole(endedPath(this.runId), new Date().toISOString() + '\n');
                rmSync(markerPath(this.runId), { force: true });
                removeTree(logDirFor(this.runId));
            }
        }
        catch {
            this.log('Could not remove the live marker of this run.');
        }
    }
}
/**
 * Removes a folder without ever walking through a link: a symlink or junction is removed as a link (not recursed into), a folder is emptied then removed.
 * Retries a few times because Windows holds files of a process that has only just been killed.
 */
export function removeTree(path) {
    let st;
    try {
        st = lstatSync(path);
    }
    catch {
        return;
    }
    if (st.isSymbolicLink()) {
        try {
            rmSync(path, { recursive: false, force: true });
        }
        catch {
            try {
                unlinkSync(path);
            }
            catch {
                rmdirSync(path);
            }
        }
        return;
    }
    if (!st.isDirectory()) {
        rmSync(path, { force: true, maxRetries: 5, retryDelay: 100 });
        return;
    }
    for (const entry of readdirSync(path))
        removeTree(join(path, entry));
    // Windows holds a folder for a moment after a process that used it was killed
    for (let i = 0;; i++) {
        try {
            rmdirSync(path);
            return;
        }
        catch (e) {
            if (i >= 5 || e.code === 'ENOENT') {
                if (e.code === 'ENOENT')
                    return;
                throw e;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
    }
}
/** Kills a process and everything it started. */
export function killTree(pid) {
    if (!Number.isInteger(pid) || pid <= 1)
        return Promise.resolve();
    if (process.platform === 'win32') {
        // Windows cannot deliver SIGTERM to a child, so the tree is ended by taskkill
        return new Promise((resolve) => {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
        });
    }
    // A child spawned detached leads its own group: the negative id reaches the whole group. A child that is not a leader falls back to itself
    const send = (signal) => {
        try {
            process.kill(-pid, signal);
        }
        catch {
            try {
                process.kill(pid, signal);
            }
            catch {
                /* Already gone */
            }
        }
    };
    send('SIGTERM');
    return new Promise((resolve) => {
        const until = Date.now() + 3_000;
        const timer = setInterval(() => {
            if (!pidAlive(pid)) {
                clearInterval(timer);
                resolve();
            }
            else if (Date.now() > until) {
                clearInterval(timer);
                send('SIGKILL');
                resolve();
            }
        }, 100);
    });
}
/** On a stop signal: closes the scope, then calls onKill (which exits the process). Returns the function that removes the handlers. */
export function installSignalHandlers(scope, onKill) {
    let busy = false;
    const handler = () => {
        if (busy)
            return;
        busy = true;
        void scope.close().finally(() => onKill());
    };
    const signals = ['SIGINT', 'SIGTERM', 'SIGBREAK'];
    for (const s of signals)
        process.on(s, handler);
    return () => {
        for (const s of signals)
            process.off(s, handler);
    };
}
/** Removes a run folder and its private copy by their exact paths. */
function removeRun(id) {
    removeTree(under(copiesDir(), id));
    removeTree(under(runsDir(), id));
    removeTree(logDirFor(id));
    rmSync(markerPath(id), { force: true });
    rmSync(endedPath(id), { force: true });
}
const ageOf = (path) => {
    try {
        return Date.now() - statSync(path).mtimeMs;
    }
    catch {
        return 0;
    }
};
const plainIds = (dir) => {
    if (!existsSync(dir))
        return [];
    return readdirSync(dir).filter((n) => NAME.test(n));
};
/** The run ids that have a folder, a marker or an end note. */
export function allRunIds() {
    const ids = new Set(plainIds(runsDir()));
    if (existsSync(markersDir()))
        for (const f of readdirSync(markersDir())) {
            const m = /^(.+)\.(json|ended)$/.exec(f);
            if (m && NAME.test(m[1]))
                ids.add(m[1]);
        }
    return [...ids];
}
/**
 * Cleans what dead runs left: a run whose marker names a dead process, or that has neither a marker nor an end note and is older than 15 minutes.
 * Stops the recorded preview process tree and database container, then removes only those run folders and copies. Returns how many runs it cleaned.
 */
export async function sweepOrphans(log = noop, deps = {}) {
    let cleaned = 0;
    const seen = new Set();
    for (const id of allRunIds()) {
        seen.add(id);
        const dir = under(runsDir(), id);
        const checked = readMarker(id);
        const marker = checked?.marker ?? null;
        for (const note of checked?.notes ?? [])
            log(note);
        if (marker) {
            if (pidAlive(marker.pid))
                continue;
        }
        else if (existsSync(markerPath(id)) ||
            existsSync(endedPath(id)) ||
            (existsSync(dir) ? ageOf(dir) : Infinity) < NO_MARKER_GRACE_MS) {
            continue; // Finished in order (clearRuns handles it), or too young to judge
        }
        if (marker?.previewPid && pidAlive(marker.previewPid))
            await killTree(marker.previewPid);
        if (marker?.dbName && marker.roleName && marker.poolId) {
            // A pooled run: only its own database and roles go. The pool container is never removed here, other runs live in it
            await dropPooledDatabase({ dbName: marker.dbName, roleName: marker.roleName, poolId: marker.poolId }, { docker: deps.docker });
        }
        else if (marker?.containerName)
            await removeContainer(marker.containerName, deps.docker);
        removeRun(id);
        cleaned++;
        log(`Cleaned the leftovers of run ${id}.`);
    }
    // A copy whose run folder is gone: removed when it is old enough that no run is still making it
    for (const id of plainIds(copiesDir())) {
        if (seen.has(id) || ageOf(under(copiesDir(), id)) < NO_MARKER_GRACE_MS)
            continue;
        removeTree(under(copiesDir(), id));
        cleaned++;
        log(`Removed the orphaned copy of run ${id}.`);
    }
    // The logs of a run that has no folder, marker or copy any more: old enough that no run is still writing them
    for (const id of plainIds(logsDir())) {
        if (seen.has(id) || existsSync(markerPath(id)) || ageOf(logDirFor(id)) < NO_MARKER_GRACE_MS)
            continue;
        removeTree(logDirFor(id));
        cleaned++;
        log(`Removed the orphaned logs of run ${id}.`);
    }
    return cleaned;
}
/**
 * Removes finished run folders (and their copies). A run with the live marker of a running process is always kept; a run whose process died is left to
 * sweepOrphans, which also stops what it left running. By default only runs older than 7 days go; `all` removes every finished one.
 */
export function clearRuns(opts = {}) {
    const limit = (opts.olderThanDays ?? 7) * DAY_MS;
    let removed = 0;
    for (const id of allRunIds()) {
        const dir = under(runsDir(), id);
        if (existsSync(markerPath(id)))
            continue;
        if (!opts.all && (existsSync(dir) ? ageOf(dir) : Infinity) < limit)
            continue;
        removeRun(id);
        removed++;
    }
    return { removed };
}
