// THE WORKER'S SCHEDULING LOGIC, PURE: EVERYTHING IT TOUCHES (THE BOARD CONNECTIONS, THE RUNNER, THE MACHINE BROKER, THE SLEEP) IS INJECTED, SO IT IS TESTED WITH FAKES.
// What it decides: how many runs to take (never more than the slots plus the runs it may prepare ahead), to leave a run UNCLAIMED on the board while the machine is
// overloaded, to claim as late as possible (right before the work starts), to beat the board from the moment of the claim through every waiting phase, to let the next
// run install and build while the current one runs its check (two stages per run, `prepare` and `execute`), to let registrations take turns, to stop a run that
// outlives its limit, and to give back only its own held runs when it stops. The board stops a claimed run that does not beat for 10 minutes (BEAT_TIMEOUT_MINUTES in
// the board's checks.ts), so the first beat goes at claim time, not when the work starts, and the beat never depends on the stage.
// -- CONSTANTS -- //
const num = (name, fallback) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
};
/** Idle poll, 5 s. AFB_CHECKS_POLL_MS overrides (the tests). */
export const pollMs = () => num('AFB_CHECKS_POLL_MS', 5_000);
/** Longest backoff after errors, 60 s. */
export const backoffMaxMs = () => num('AFB_CHECKS_BACKOFF_MAX_MS', 60_000);
/** A beat every 30 s. The board reports a run stuck after 10 minutes without one. */
export const beatMs = () => num('AFB_CHECKS_BEAT_MS', 30_000);
/** The longest one run may take, builds and waiting included: 40 minutes. */
export const runLimitMs = () => num('AFB_CHECKS_RUN_LIMIT_MS', 40 * 60_000);
// -- FUNCTIONS -- //
const defaultSleep = (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
        clearTimeout(t);
        signal.removeEventListener('abort', done);
        resolve();
    }
    signal.addEventListener('abort', done, { once: true });
});
/** Waits for a promise to settle, but not longer than ms. The timer is cleared the moment it settles, so it never keeps the process alive. */
const settleWithin = (p, ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    p.then(() => clearTimeout(t), () => clearTimeout(t)).finally(resolve);
});
const message = (e) => (e instanceof Error ? e.message : String(e));
const toError = (e) => (e instanceof Error ? e : new Error(String(e)));
function withTimeout(p, ms, what) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} seconds.`)), ms);
        p.then((v) => {
            clearTimeout(t);
            resolve(v);
        }, (e) => {
            clearTimeout(t);
            reject(toError(e));
        });
    });
}
/** A gate of `limit` places. When one frees, the waiter whose key holds the fewest places goes first (ties by arrival): registrations take turns. */
export class FairGate {
    limit;
    holders = new Map();
    waiters = [];
    seq = 0;
    inside = 0;
    constructor(limit) {
        this.limit = limit;
    }
    acquire(key, signal) {
        if (signal?.aborted)
            return Promise.reject(Object.assign(new Error('Stopped.'), { name: 'AbortError' }));
        return new Promise((resolve, reject) => {
            const w = {
                key,
                seq: this.seq++,
                go: () => {
                    signal?.removeEventListener('abort', onAbort);
                    this.inside++;
                    this.holders.set(key, (this.holders.get(key) ?? 0) + 1);
                    let freed = false;
                    resolve(() => {
                        if (freed)
                            return;
                        freed = true;
                        this.inside--;
                        this.holders.set(key, (this.holders.get(key) ?? 1) - 1);
                        this.next();
                    });
                }
            };
            const onAbort = () => {
                this.waiters = this.waiters.filter((x) => x !== w);
                reject(Object.assign(new Error('Stopped.'), { name: 'AbortError' }));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            this.waiters.push(w);
            this.next();
        });
    }
    next() {
        while (this.inside < this.limit && this.waiters.length) {
            this.waiters.sort((a, b) => (this.holders.get(a.key) ?? 0) - (this.holders.get(b.key) ?? 0) || a.seq - b.seq);
            this.waiters.shift()?.go();
        }
    }
}
export function createScheduler(deps, o) {
    const slots = Math.max(1, Math.floor(o.slots));
    const prefetch = Math.max(0, Math.floor(o.prefetch ?? 1));
    const poll = o.pollMs ?? pollMs();
    const backoffMax = o.backoffMaxMs ?? backoffMaxMs();
    const beatEvery = o.beatMs ?? beatMs();
    const limitMs = o.runLimitMs ?? runLimitMs();
    const callMs = o.callTimeoutMs ?? 25_000;
    const stepWait = o.stepWaitMs ?? 3_000;
    const grace = o.graceMs ?? 5_000;
    const sleep = deps.sleep ?? defaultSleep;
    const now = deps.now ?? (() => Date.now());
    const isFatal = deps.fatal ?? ((e) => e?.code === 'UNAUTHENTICATED');
    const isGone = deps.gone ?? ((e) => /already finished/i.test(message(e)));
    const runs = new Map();
    const prepareGate = new FairGate(slots);
    const backoff = new Map();
    const dead = new Map();
    const stepping = new Set();
    let reserved = 0;
    let stopping = false;
    let wakeUp = null;
    let overloadSaid = null;
    let offset = 0;
    const wake = () => {
        const w = wakeUp;
        wakeUp = null;
        w?.();
    };
    const nap = (ms, signal) => Promise.race([
        sleep(ms, signal),
        new Promise((resolve) => {
            wakeUp = resolve;
        })
    ]);
    const count = (stage) => [...runs.values()].filter((r) => r.stage === stage).length;
    const status = () => ({
        slots,
        claimed: runs.size,
        preparing: count('prepare') + count('prepare-wait'),
        waitingForSlot: count('slot-wait'),
        executing: count('execute')
    });
    /** Whether one more run may be claimed right now. Checked right before the claim, so a run the machine cannot start stays queued on the board. */
    function capacity() {
        if (stopping)
            return false;
        const ready = deps.broker.ready();
        if (!ready.ok) {
            if (overloadSaid !== ready.code)
                deps.log(ready.why);
            overloadSaid = ready.code;
            return false;
        }
        overloadSaid = null;
        const pending = count('prepare-wait') + count('prepare') + count('slot-wait');
        const load = deps.broker.totals().busy + pending + reserved;
        // A run that waits for a slot is not in the machine total yet, so it is counted once, as pending
        return load < slots + prefetch;
    }
    function startRun(conn, job) {
        const ac = new AbortController();
        const rec = { job, conn, ac, stage: 'prepare-wait', reason: null, reported: false };
        runs.set(job.id, rec);
        const ctx = {
            runId: job.id,
            signal: ac.signal,
            log: (l) => deps.log(l),
            reason: () => rec.reason
        };
        const stop = (why) => {
            if (rec.reason)
                return;
            rec.reason = why;
            // The reason travels on the signal, so a run knows whether it was stopped, timed out or given up on
            ac.abort(why);
        };
        rec.done = (async () => {
            // The beat starts here, at the claim, and runs until the run is over: waiting for a turn, a slot or the disk never silences it
            let told = false;
            const beat = () => void Promise.resolve()
                .then(() => conn.beat(job.id))
                .catch((e) => {
                if (isGone(e)) {
                    if (!told)
                        deps.log(`The board gave up on this run: ${message(e)}`);
                    told = true;
                    stop('gone');
                }
            });
            beat();
            const beatTimer = setInterval(beat, beatEvery);
            const limitTimer = setTimeout(() => stop('timeout'), limitMs);
            const aborted = new Promise((_, reject) => {
                ac.signal.addEventListener('abort', () => reject(Object.assign(new Error('The run was stopped.'), { name: 'AbortError' })), { once: true });
            });
            aborted.catch(() => undefined);
            const key = job.registration ?? conn.key;
            const work = (async () => {
                const free = await prepareGate.acquire(key, ac.signal);
                let prepared;
                try {
                    rec.stage = 'prepare';
                    prepared = await deps.runner.prepare(job, ctx);
                }
                finally {
                    free();
                }
                rec.stage = 'slot-wait';
                wake();
                const slot = await deps.broker.acquire({ runId: job.id, kind: 'check', registration: key }, { signal: ac.signal });
                try {
                    rec.stage = 'execute';
                    await deps.runner.execute(job, prepared, ctx);
                }
                finally {
                    slot.release();
                }
            })();
            work.catch(() => undefined);
            try {
                await Promise.race([work, aborted]);
                rec.reported = true;
            }
            catch (e) {
                if (rec.reason === 'timeout') {
                    const mins = Math.max(1, Math.round(limitMs / 60_000));
                    const why = limitMs < 60_000 ? `${Math.round(limitMs / 1000)} seconds` : `${mins} minutes`;
                    await deps.runner
                        .fail(job, new Error(`The run took longer than ${why} and was stopped.`), ctx)
                        .catch(() => undefined);
                }
                else if (rec.reason === null) {
                    deps.log(`could not run ${job.id}: ${message(e)}`);
                    await deps.runner.fail(job, toError(e), ctx).catch(() => undefined);
                }
                rec.reported = true;
            }
            finally {
                clearInterval(beatTimer);
                clearTimeout(limitTimer);
                // An abandoned stage gets a moment to end by itself before the run's resources are closed
                if (rec.reason)
                    await settleWithin(work, grace);
                try {
                    await deps.runner.cleanup?.(job, ctx);
                }
                catch (e) {
                    deps.log(`could not clean up ${job.id}: ${message(e)}`);
                }
                runs.delete(job.id);
                wake();
            }
        })();
    }
    /** One look at one board: ask for the count, then take as many as the machine can start. Returns how many were taken. */
    async function step(conn) {
        let taken = 0;
        if (!capacity())
            return { taken, blocked: true };
        let waiting;
        try {
            waiting = await withTimeout(conn.peek(), callMs, `${conn.key}: the board`);
            backoff.delete(conn.key);
            while (waiting-- > 0) {
                // Late and synchronous: the capacity is read again and a place is reserved before the claim goes out
                if (!capacity())
                    return { taken, blocked: true };
                reserved++;
                try {
                    const job = await withTimeout(conn.claim(), callMs, `${conn.key}: the board`);
                    if (!job)
                        break;
                    if (stopping) {
                        await conn.release([job.id]).catch(() => undefined);
                        break;
                    }
                    startRun(conn, job);
                    taken++;
                }
                finally {
                    reserved--;
                }
            }
        }
        catch (e) {
            if (isFatal(e)) {
                dead.set(conn.key, conn.fingerprint ?? '');
                deps.log(`${conn.key}: ${message(e)}`);
            }
            else {
                const prev = backoff.get(conn.key)?.wait ?? poll;
                const wait = Math.min(backoffMax, Math.max(prev * 2, poll * 2));
                backoff.set(conn.key, { wait, until: now() + wait });
                deps.log(`${conn.key}: ${message(e)}`);
            }
        }
        return { taken, blocked: false };
    }
    async function pass() {
        // The connections are read again on every pass, so a board connected or forgotten meanwhile is picked up without a restart
        const conns = deps.connections();
        const keys = new Set(conns.map((c) => c.key));
        for (const k of [...dead.keys()])
            if (!keys.has(k))
                dead.delete(k);
        const live = conns.filter((c) => {
            const d = dead.get(c.key);
            if (d !== undefined && d === (c.fingerprint ?? ''))
                return false;
            if (d !== undefined)
                dead.delete(c.key);
            return !stepping.has(c.key) && (backoff.get(c.key)?.until ?? 0) <= now();
        });
        // The boards take turns at being asked first
        const ordered = live.length
            ? [...live.slice(offset % live.length), ...live.slice(0, offset % live.length)]
            : [];
        offset++;
        let taken = 0;
        let blocked = false;
        const steps = ordered.map(async (c) => {
            stepping.add(c.key);
            try {
                const r = await step(c);
                taken += r.taken;
                blocked ||= r.blocked;
            }
            finally {
                stepping.delete(c.key);
            }
        });
        // A board that answers slowly does not hold the others back
        await settleWithin(Promise.all(steps), stepWait);
        return { taken, blocked };
    }
    async function run({ signal, once = false }) {
        stopping = false;
        let total = 0;
        const onAbort = () => {
            stopping = true;
            wake();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            while (!signal.aborted) {
                const { taken, blocked } = await pass();
                total += taken;
                if (once) {
                    if (!taken && !(blocked && runs.size))
                        break;
                    if (!taken)
                        await nap(poll, signal);
                    continue;
                }
                // Something was taken: look again at once. Otherwise the idle poll, cut short when a run ends and frees room
                await nap(taken ? 0 : poll, signal);
            }
            if (once && !signal.aborted)
                await Promise.all([...runs.values()].map((r) => r.done));
        }
        finally {
            signal.removeEventListener('abort', onAbort);
            stopping = signal.aborted;
            if (signal.aborted) {
                // Give back exactly the runs this scheduler holds and has not reported, grouped by the connection they were claimed on
                const byConn = new Map();
                for (const r of runs.values()) {
                    if (r.reported)
                        continue;
                    r.reason ??= 'stopped';
                    byConn.set(r.conn, [...(byConn.get(r.conn) ?? []), r.job.id]);
                }
                await Promise.all([...byConn].map(([c, ids]) => c.release(ids).catch(() => undefined)));
                for (const r of runs.values())
                    r.ac.abort('stopped');
                await Promise.all([...runs.values()].map((r) => r.done));
            }
        }
        return total;
    }
    return {
        run,
        status,
        heldIds: () => [...runs.values()].filter((r) => !r.reported).map((r) => r.job.id)
    };
}
