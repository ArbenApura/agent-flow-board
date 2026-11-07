// THE OFFLINE WRITE QUEUE (SPEC 6.3). A WRITE WHILE THE BOARD IS UNREACHABLE IS QUEUED AND SAID TO BE QUEUED, NEVER ANSWERED WITH A MADE UP RESULT.
// Replay keeps the original order. A write that fails on replay holds the later writes for the same item; other items continue.
// -- DEP-MODULES -- //
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
// -- CONSTANTS -- //
/** A lock file older than this belongs to a process that died inside the lock, because the work inside it takes milliseconds. */
export const LOCK_STALE_MS = 10_000;
/** The longest a caller waits for the lock before it takes the lock over. */
export const LOCK_WAIT_MS = 5_000;
// -- FUNCTIONS -- //
/** Waits without spinning, for the sync methods of the queue. */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export class Queue {
    file;
    lockTimes;
    constructor(file, lockTimes = {
        staleMs: LOCK_STALE_MS,
        waitMs: LOCK_WAIT_MS
    }) {
        this.file = file;
        this.lockTimes = lockTimes;
    }
    /**
     * Runs fn while this process holds the lock file next to the queue (an exclusive create). Two bridges of two tools share one
     * queue file, and without the lock their read, change, write steps can overwrite each other. A lock left by a dead process
     * is taken over once it is stale.
     */
    withLock(fn) {
        const lock = `${this.file}.lock`;
        mkdirSync(dirname(this.file), { recursive: true });
        const giveUp = Date.now() + this.lockTimes.waitMs;
        for (;;) {
            try {
                const fd = openSync(lock, 'wx', 0o600);
                writeSync(fd, String(process.pid));
                closeSync(fd);
                break;
            }
            catch (e) {
                if (e.code !== 'EEXIST')
                    throw e;
                let stale = Date.now() > giveUp;
                try {
                    stale ||= Date.now() - statSync(lock).mtimeMs > this.lockTimes.staleMs;
                }
                catch {
                    continue; // The holder just let go
                }
                if (stale) {
                    // Renaming is atomic, so when two callers find the same stale lock only one of them removes it
                    const aside = `${lock}.stale-${process.pid}-${Date.now()}`;
                    try {
                        renameSync(lock, aside);
                        rmSync(aside, { force: true });
                    }
                    catch {
                        /* Another caller took it over first */
                    }
                    continue;
                }
                sleepSync(20);
            }
        }
        try {
            return fn();
        }
        finally {
            rmSync(lock, { force: true });
        }
    }
    read() {
        if (!existsSync(this.file))
            return [];
        try {
            return JSON.parse(readFileSync(this.file, 'utf8'));
        }
        catch {
            return [];
        }
    }
    write(list) {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify(list, null, 1), { mode: 0o600 });
    }
    list = () => this.read();
    enqueue(name, args) {
        return this.withLock(() => this.enqueueLocked(name, args));
    }
    enqueueLocked(name, args) {
        const list = this.read();
        const id = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const key = String(args.item ?? args.id ?? args.sessionId ?? 'none');
        // The id doubles as the request id, so replaying after a half finished send can never write twice
        const entry = {
            id,
            at: new Date().toISOString(),
            name,
            args: {
                ...args,
                requestId: typeof args.requestId === 'string' ? args.requestId : `afb-${id}`
            },
            key,
            state: 'queued'
        };
        list.push(entry);
        this.write(list);
        return entry;
    }
    drop(id) {
        return this.withLock(() => {
            const list = this.read();
            const next = list.filter((e) => e.id !== id);
            if (next.length === list.length)
                return false;
            this.write(next);
            return true;
        });
    }
    /** Puts a held write back in the line so the next replay tries it again. */
    retry(id) {
        return this.withLock(() => {
            const list = this.read();
            const e = list.find((x) => x.id === id);
            if (!e)
                return false;
            e.state = 'queued';
            delete e.reason;
            this.write(list);
            return true;
        });
    }
    /** Sends queued writes in order. Stops at the first sign the board is still unreachable. */
    async replay(send) {
        // The lock is not held while writes are sent, which can take long. What was decided is merged into the file afterwards.
        const list = this.read();
        const gone = new Set();
        const heldNow = new Map();
        const heldKeys = new Set(list.filter((e) => e.state === 'held').map((e) => e.key));
        let sent = 0;
        let held = 0;
        let offline = false;
        for (const e of list) {
            if (offline || e.state === 'held' || heldKeys.has(e.key)) {
                if (!offline && e.state !== 'held')
                    held++;
                continue;
            }
            const r = await send(e);
            if (r.kind === 'ok') {
                sent++;
                gone.add(e.id);
            }
            else if (r.kind === 'refused') {
                heldNow.set(e.id, r.reason);
                heldKeys.add(e.key);
                held++;
            }
            else {
                offline = true;
            }
        }
        this.withLock(() => {
            const current = this.read();
            const next = current
                .filter((e) => !gone.has(e.id))
                .map((e) => {
                const reason = heldNow.get(e.id);
                return reason === undefined ? e : { ...e, state: 'held', reason };
            });
            this.write(next);
        });
        return { sent, held, offline };
    }
}
