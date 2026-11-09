// `check watch`: TAKE QUEUED RUNS FROM EVERY CONNECTED BOARD (THE RUN BUTTON ON THE BOARD), ON THE MACHINE'S SLOTS
// One worker per machine. The scheduler (scheduler.ts) decides how many runs to take: never more than the machine's slots, none while the disk or memory preflight
// fails, registrations taking turns, a heartbeat to the board from the moment of the claim, a 40 minute limit, and only its own held runs given back when it stops.
// A queued run for a project with a registration is routed by the registration rules (run.ts); a project with none runs in the folder where `check run` was used
// before, and with neither the run ends "could not run" and the current directory is never a fallback.
// -- DEP-MODULES -- //
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { appendAudit } from './audit.js';
import { boundFolder, pinStatus } from './bind.js';
import { BoardError, RunnerBoard } from './board.js';
import { acquireSlot, canTake, machineTotals, maxSlots } from './broker.js';
import { closeAllBrowsers } from './browserpool.js';
import { listConnections } from './connections.js';
import { loadRunnerToken } from './connect.js';
import { closePoolIfIdle, configureDatabasePool } from './dbpool.js';
import { machineLock } from './lock.js';
import { checksHome } from './paths.js';
import { renameRetry } from './fsretry.js';
import { readRegistrations } from './registry.js';
import { auditHeaders, registrationsHeaderFor, runCheck } from './run.js';
import { createScheduler } from './scheduler.js';
import { sweepOrphans } from './scope.js';
// -- CONSTANTS -- //
const STATUS_EVERY_MS = 15_000;
/** The line the worker prints for a terminal stop. */
export const terminalLine = (kind) => `AFB_TERMINAL: ${kind}`;
// -- FUNCTIONS -- //
/** worker.json: what the service and `status` read to see whether the worker is busy. Written whole, never half. */
function writeWorkerStatus(slots, runs) {
    try {
        const file = join(checksHome(), 'worker.json');
        mkdirSync(checksHome(), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        const totals = machineTotals();
        writeFileSync(tmp, JSON.stringify({
            pid: process.pid,
            slots,
            busy: totals.busy,
            runs,
            at: new Date().toISOString()
        }));
        renameRetry(tmp, file);
    }
    catch {
        /* A status that cannot be written must never stop the worker */
    }
}
/** Runs the worker until the signal aborts (or one pass with `once`). Returns how many runs it took. */
export async function watchChecks(o) {
    const lock = machineLock('watch');
    if (!lock)
        throw new Error('Another "check watch" is already running on this machine. Only one worker runs per machine.');
    const slots = maxSlots(o.parallel);
    // The database pool is sized to the slots (its max_connections) and kept warm by this worker between runs; it is closed when the worker stops
    configureDatabasePool({ slots, removeWhenIdle: false });
    const owners = new Map();
    let taken = 0;
    // A stop no restart can fix: the worker prints one sentinel line, then the plain sentence, and ends with that sentence as its error
    const inner = new AbortController();
    let terminal = null;
    const stopFor = (kind, message) => {
        if (terminal)
            return;
        terminal = { kind, message };
        o.log(terminalLine(kind));
        o.log(message);
        inner.abort();
    };
    if (o.signal.aborted)
        inner.abort();
    else
        o.signal.addEventListener('abort', () => inner.abort(), { once: true });
    // The boards that answered 401, by the fingerprint of the token they refused: a new `check connect` gives a new token and clears it
    const refused = new Map();
    let known = new Map();
    const noteBoardError = (key, fingerprint, e) => {
        if (!(e instanceof BoardError))
            return;
        if (e.code === 'UPGRADE_REQUIRED') {
            stopFor('needs-newer', `This machine needs a newer bridge to talk to this board. ${e.message}`);
        }
        else if (e.status === 401) {
            refused.set(key, fingerprint);
            if ([...known].every(([k, fp]) => refused.get(k) === fp))
                stopFor('rejected', 'The board no longer accepts this machine for checks. Run: agent-flow-board check connect --server <url> --org <slug> --json');
        }
    };
    // The same beat refreshes the worker lock, so a crashed worker whose process id was reused does not lock out the next `check watch`
    const status = setInterval(() => {
        writeWorkerStatus(slots, taken);
        lock.touch();
    }, STATUS_EVERY_MS);
    status.unref();
    try {
        // A worker with nothing to serve is not a worker that will have something later: a restart cannot fix it, so it says so and stops (not for one pass with --once)
        if (!o.once) {
            const all = listConnections();
            if (!all.length)
                stopFor('not-set-up', 'Not set up: this machine is not connected to any board. Run: agent-flow-board check connect --server <url> --org <slug> --json');
            else if (!all.some((c) => loadRunnerToken(o.store, c.server, c.org)))
                stopFor('not-connected', 'Not connected: no connection of this machine has a runner token. Run: agent-flow-board check connect --server <url> --org <slug> --json');
            if (terminal)
                throw new Error(terminal.message);
        }
        await sweepOrphans(o.log);
        appendAudit('watch-start', { slots });
        writeWorkerStatus(slots, 0);
        const scheduler = createScheduler({
            // The connections are read again on every loop, so a new `check connect` is picked up without a restart
            connections: () => {
                known = new Map();
                return listConnections().flatMap((c) => {
                    const token = loadRunnerToken(o.store, c.server, c.org);
                    if (!token)
                        return [];
                    const key = `${c.server}|${c.org}`;
                    const fingerprint = token.slice(-8);
                    known.set(key, fingerprint);
                    // The idle worker tells the board its registrations and audit head too: without them the board takes the bridge for an old tool and refuses a run that names a registration
                    const board = new RunnerBoard(c.server, token, o.fetch, () => ({
                        'x-afb-tool-slots': `${machineTotals().slots}:${machineTotals().busy}`,
                        ...auditHeaders(),
                        ...registrationsHeaderFor(c.org)
                    }));
                    return [
                        {
                            key,
                            fingerprint,
                            peek: () => board.peek().catch((e) => {
                                noteBoardError(key, fingerprint, e);
                                throw e;
                            }),
                            claim: async () => {
                                const job = await board.claimNext().catch((e) => {
                                    noteBoardError(key, fingerprint, e);
                                    throw e;
                                });
                                if (job) {
                                    owners.set(job.id, { server: c.server, org: c.org, token });
                                    taken++;
                                }
                                return job;
                            },
                            beat: (id) => board.beat(id),
                            release: (ids) => board.release(ids)
                        }
                    ];
                });
            },
            runner: {
                // Copy, install and build happen inside the run itself; the overlap of the next run's build with this run's check is decided by the benchmark (step 5.7)
                prepare: async () => null,
                execute: async (job, _prepared, ctx) => {
                    const owner = owners.get(job.id);
                    if (!owner)
                        throw new Error('The run is not known to this worker.');
                    await handle(o, owner, job, ctx.log, ctx.signal);
                },
                fail: async (job, error) => {
                    const owner = owners.get(job.id);
                    if (!owner)
                        return;
                    await new RunnerBoard(owner.server, owner.token, o.fetch)
                        .finish(job.id, { result: 'error', reason: error.message.slice(0, 1900) })
                        .catch(() => undefined);
                },
                cleanup: async (job) => {
                    owners.delete(job.id);
                }
            },
            broker: {
                acquire: (req, opts) => acquireSlot(req, opts),
                ready: () => canTake(),
                totals: () => machineTotals()
            },
            log: o.log
        }, { slots, prefetch: 0 });
        await scheduler.run({ signal: inner.signal, once: o.once });
        // A worker that stopped for a reason a restart cannot fix ends with that reason, so the command exits with it
        if (terminal)
            throw new Error(terminal.message);
        return taken;
    }
    finally {
        clearInterval(status);
        // The scheduler gave back only its own unreported runs. The browsers and the database pool container this worker kept warm are closed now
        await closeAllBrowsers().catch(() => undefined);
        await closePoolIfIdle().catch(() => undefined);
        appendAudit('watch-stop', { taken });
        lock.release();
    }
}
async function handle(o, owner, job, log, signal) {
    const board = new RunnerBoard(owner.server, owner.token, o.fetch);
    const fail = (reason) => board.finish(job.id, { result: 'error', reason }).catch(() => undefined);
    const projectKey = job.project.key;
    const read = readRegistrations(owner.org);
    const registered = read.registrations.some((r) => r.boardProject === projectKey);
    let dir = process.cwd();
    if (!registered && read.problems.length)
        // A registration that is damaged or was changed by hand is not "no registration": the folder of an earlier `check run` is not taken in its place
        return void (await fail(`${read.problems.join(' ')} No other registration serves ${projectKey}, so the run was not started. Register the project again with: agent-flow-board check project`));
    if (!registered) {
        // No registration for this project: the folder where `check run` was used before, and only if its files did not change since
        const bound = boundFolder(owner.org, projectKey);
        if (!bound || !existsSync(bound.folder))
            return void (await fail(`This machine has no folder for ${projectKey}. In the project's folder run: agent-flow-board check run ${job.item.ref} ${job.check.key} --org ${owner.org}`));
        if (pinStatus(owner.org, projectKey) !== 'ok')
            return void (await fail(`The files that decide what runs in ${bound.folder} changed since they were approved. In that folder run: agent-flow-board check run ${job.item.ref} ${job.check.key} --org ${owner.org}`));
        dir = bound.folder;
    }
    log(`${owner.org}: running ${job.item.ref} ${job.check.key}`);
    const outcome = await runCheck({
        server: owner.server,
        org: owner.org,
        item: job.item.ref,
        key: job.check.key,
        dir,
        step: job.stepKey ?? undefined,
        claimed: job,
        scheduled: true,
        signal,
        runnerToken: owner.token,
        personalToken: null,
        fetch: o.fetch,
        log
    });
    log(`${owner.org}: ${job.item.ref} ${job.check.key}: ${outcome.message}`);
}
