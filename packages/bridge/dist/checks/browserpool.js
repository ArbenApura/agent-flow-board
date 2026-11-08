// THE BROWSER POOL: RUNS THAT NEED THE SAME REACHABLE HOSTS SHARE ONE CHROMIUM SERVER, EACH RUN WITH A FRESH CONTEXT OF ITS OWN.
// Why sharing is safe: the server is started with Playwright's launchServer and never with the shared-browser option, so every connection to its endpoint
// gets contexts of its own and sees none of another connection's (proved by the opt-in real browser test). Why the key holds the hosts: the host
// resolver rule is a launch argument of the browser, so a browser started for one set of hosts can never reach the hosts of another set.
// A registration for a live site (`dedicated: true`) always gets a browser of its own.
//
// FILE LAYOUT (poolDir()): browser-<id>.json, one per launched browser, written whole when the browser is up and removed when it closes or crashes:
//   { kind: 'browser', id, pid (the process that owns the pool), key, headed, hosts, dedicated, startedAt }
// The websocket endpoint is NOT written: it is a capability. Sharing one browser across processes is the machine broker's job; until it exists a pool
// lives in one process, and the marker only lets doctor see (and sweep, when the owner is dead) what was left.
// -- DEP-MODULES -- //
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { launchBrowserServer } from './browser.js';
import { pidAlive } from './lock.js';
import { ensureDir, poolDir } from './paths.js';
// -- CONSTANTS -- //
/** A shared browser with no runs on it stays up this long, so the next run of a burst does not pay for a new launch. */
const DEFAULT_IDLE_MS = 15_000;
const MARKER_PREFIX = 'browser-';
// -- FUNCTIONS -- //
/** The pool key: the sorted, lower-cased host set and the headed flag. Two runs share a browser only when this is equal. */
export function browserKey(hosts, headed) {
    const set = [...new Set(hosts.map((h) => h.trim().toLowerCase()).filter(Boolean))].sort();
    return `${headed ? 'headed' : 'headless'}|${set.join(',')}`;
}
function writeWhole(file, text) {
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
}
const markerFile = (id) => join(poolDir(), `${MARKER_PREFIX}${id}.json`);
/** Every browser marker on this machine, with whether the process that owns it is alive. For doctor. */
export function listBrowserMarkers() {
    const out = [];
    let names;
    try {
        names = readdirSync(poolDir());
    }
    catch {
        return out;
    }
    for (const n of names) {
        if (!n.startsWith(MARKER_PREFIX) || !n.endsWith('.json'))
            continue;
        try {
            const v = JSON.parse(readFileSync(join(poolDir(), n), 'utf8'));
            const m = v;
            if (m && m.kind === 'browser' && typeof m.id === 'string' && typeof m.pid === 'number')
                out.push({ marker: m, ownerAlive: pidAlive(m.pid) });
        }
        catch {
            /* A damaged marker is not listed */
        }
    }
    return out;
}
/** Removes the markers of browsers whose owner process is gone (the browser died with it). Returns how many. */
export function sweepBrowserMarkers() {
    let removed = 0;
    for (const { marker, ownerAlive } of listBrowserMarkers()) {
        if (ownerAlive || !/^[a-f0-9]{6,16}$/.test(marker.id))
            continue;
        rmSync(markerFile(marker.id), { force: true });
        removed++;
    }
    return removed;
}
export class BrowserPool {
    entries = new Map();
    all = new Set();
    launcher;
    idleMs;
    markers;
    constructor(opts = {}) {
        this.launcher = opts.launcher ?? ((o) => launchBrowserServer(o));
        this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
        this.markers = opts.markers ?? true;
    }
    /** How many browsers are up (or starting), counting dedicated ones. */
    get size() {
        return this.all.size;
    }
    launch(entry) {
        entry.server = this.launcher({
            headed: entry.request.headed,
            hosts: entry.request.hosts
        }).then((server) => {
            if (this.markers)
                this.writeMarker(entry);
            // A crash takes only this entry out: the next acquire of its key launches a new browser, runs that hold this one fail on their own
            server.onClose?.(() => this.markGone(entry));
            return server;
        }, (e) => {
            this.markGone(entry);
            throw e;
        });
        // The rejection is handled by the acquire that awaits it
        entry.server.catch(() => { });
    }
    writeMarker(entry) {
        try {
            ensureDir(poolDir());
            const marker = {
                kind: 'browser',
                id: entry.id,
                pid: process.pid,
                key: entry.key,
                headed: entry.request.headed,
                hosts: entry.request.hosts,
                dedicated: entry.request.dedicated,
                startedAt: new Date().toISOString()
            };
            writeWhole(markerFile(entry.id), JSON.stringify(marker) + '\n');
        }
        catch {
            /* The marker is for doctor only: a browser still works without it */
        }
    }
    markGone(entry) {
        if (entry.gone)
            return;
        entry.gone = true;
        if (entry.idleTimer)
            clearTimeout(entry.idleTimer);
        if (this.entries.get(entry.key) === entry)
            this.entries.delete(entry.key);
        this.all.delete(entry);
        if (this.markers)
            rmSync(markerFile(entry.id), { force: true });
    }
    async closeEntry(entry) {
        this.markGone(entry);
        try {
            await (await entry.server).close();
        }
        catch {
            /* Already closed or never started */
        }
    }
    async acquire(req = {}) {
        const headed = req.headed === true;
        const hosts = [
            ...new Set((req.hosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean))
        ].sort();
        const dedicated = req.dedicated === true;
        const key = browserKey(hosts, headed);
        let entry = dedicated ? undefined : this.entries.get(key);
        if (!entry || entry.gone) {
            entry = {
                id: randomBytes(4).toString('hex'),
                key,
                request: { headed, hosts, dedicated },
                server: Promise.resolve(null),
                refs: 0,
                gone: false
            };
            if (!dedicated)
                this.entries.set(key, entry);
            this.all.add(entry);
            this.launch(entry);
        }
        const mine = entry;
        mine.refs++;
        if (mine.idleTimer) {
            clearTimeout(mine.idleTimer);
            mine.idleTimer = undefined;
        }
        let server;
        try {
            server = await mine.server;
        }
        catch (e) {
            mine.refs--;
            throw e;
        }
        let released = false;
        return {
            wsEndpoint: () => server.wsEndpoint(),
            release: async () => {
                if (released)
                    return;
                released = true;
                mine.refs--;
                if (mine.refs > 0 || mine.gone)
                    return;
                if (dedicated || this.idleMs <= 0)
                    return this.closeEntry(mine);
                // The grace period: a run that starts a moment later reuses this browser
                mine.idleTimer = setTimeout(() => {
                    if (mine.refs === 0)
                        void this.closeEntry(mine);
                }, this.idleMs);
                mine.idleTimer.unref();
            }
        };
    }
    /** Closes every browser at once, whatever holds it. For the end of a worker or a run. */
    async closeAll() {
        await Promise.all([...this.all].map((e) => this.closeEntry(e)));
    }
}
let shared = null;
/** The pool of this process. */
export function browserPool() {
    shared ??= new BrowserPool();
    return shared;
}
/**
 * A browser for one run. The same sorted host set and headed flag share one Chromium; `dedicated` (a live site) never shares. Call `release()` when the
 * run ends; the browser closes after a short idle grace once nobody holds it.
 */
export function acquireBrowser(req = {}) {
    return browserPool().acquire(req);
}
/** Closes every browser of this process's pool. */
export async function closeAllBrowsers() {
    await shared?.closeAll();
}
