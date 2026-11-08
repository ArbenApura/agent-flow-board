// THE THINGS ONE RUN OWNS, AND WHAT HAPPENS TO THEM WHEN THE RUN ENDS, WHATEVER ENDS IT.
// The layer that makes the resources writes a live marker file first (runs/<run id>/ACTIVE: the process id, the start time and what the run made that a
// crash would leave behind: the preview process, the database container and the private copy). Resources are closed newest first and closing never throws.
// A later run sweeps what a dead process left: only the exact run folders and copies named by a dead marker (or by no marker and old enough), never a
// folder that was not made by a run.
// -- DEP-MODULES -- //
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { pidAlive } from './lock.js';
import { NAME, copiesDir, ensureDir, runsDir, under } from './paths.js';
import { removeContainer } from './provision.js';
// -- CONSTANTS -- //
const MARKER = 'ACTIVE';
/** Written when a run ends in order, so a finished run's folder is never mistaken for one whose marker was lost. */
const ENDED = 'ENDED';
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
    renameSync(tmp, file);
}
function readMarker(dir) {
    try {
        const v = JSON.parse(readFileSync(join(dir, MARKER), 'utf8'));
        if (!v || typeof v !== 'object')
            return null;
        const m = v;
        return typeof m.pid === 'number' && typeof m.runId === 'string' ? m : null;
    }
    catch {
        return null;
    }
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
        writeWhole(join(this.dir, MARKER), JSON.stringify(marker) + '\n');
    }
    /** Records what a crash would leave behind (the preview process id, the database container, the private copy) so a later sweep can remove it. */
    setInfo(info) {
        this.start();
        this.info = { ...this.info, ...info };
        this.writeMarker();
    }
    /** Registers a resource. It is closed when the scope closes, newest first. */
    add(name, dispose) {
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
                writeWhole(join(this.dir, ENDED), new Date().toISOString() + '\n');
                rmSync(join(this.dir, MARKER), { force: true });
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
/**
 * Cleans what dead runs left: a run whose marker names a dead process, or that has neither a marker nor an end note and is older than 15 minutes.
 * Stops the recorded preview process tree and database container, then removes only those run folders and copies. Returns how many runs it cleaned.
 */
export async function sweepOrphans(log = noop) {
    let cleaned = 0;
    const seen = new Set();
    for (const id of plainIds(runsDir())) {
        seen.add(id);
        const dir = under(runsDir(), id);
        const marker = readMarker(dir);
        if (marker) {
            if (pidAlive(marker.pid))
                continue;
        }
        else if (existsSync(join(dir, MARKER)) ||
            existsSync(join(dir, ENDED)) ||
            ageOf(dir) < NO_MARKER_GRACE_MS) {
            continue; // Finished in order (clearRuns handles it), or too young to judge
        }
        if (marker?.previewPid && pidAlive(marker.previewPid))
            await killTree(marker.previewPid);
        if (marker?.containerName)
            await removeContainer(marker.containerName);
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
    return cleaned;
}
/**
 * Removes finished run folders (and their copies). A run with the live marker of a running process is always kept; a run whose process died is left to
 * sweepOrphans, which also stops what it left running. By default only runs older than 7 days go; `all` removes every finished one.
 */
export function clearRuns(opts = {}) {
    const limit = (opts.olderThanDays ?? 7) * DAY_MS;
    let removed = 0;
    for (const id of plainIds(runsDir())) {
        const dir = under(runsDir(), id);
        if (existsSync(join(dir, MARKER)))
            continue;
        if (!opts.all && ageOf(dir) < limit)
            continue;
        removeRun(id);
        removed++;
    }
    return { removed };
}
