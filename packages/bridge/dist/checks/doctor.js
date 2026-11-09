// `check status` AND `check doctor [--fix]` AND `check clear ...`: THE HEALTH OF THIS MACHINE'S CHECK SETUP, FOUND, FIXED WHERE IT IS SAFE, AND PRINTED AS ONE RESULT AN AGENT CAN READ.
// What --fix removes is only what a record names exactly: a run folder or private copy of a run whose marker names a dead process (or that has ended), a container or pooled
// database by the name its own marker recorded (afb-checks- prefix, never the person's database, never a container without a marker), a marker whose process id is dead,
// a stale worker lock, and the oldest finished runs beyond the newest 30. It never lists Docker to find things to remove, never prunes, never removes a live run or anything
// younger than two minutes, and never touches the scripts folder. Every message carries names and counts only: no value, no token, no path of a secret.
// -- DEP-MODULES -- //
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
// -- MODULES -- //
import { verifyAudit } from './audit.js';
import { localFingerprint } from './signinKey.js';
import { machineTotals } from './broker.js';
import { listBrowserMarkers, sweepBrowserMarkers } from './browserpool.js';
import { ensureBrowser, playwrightRuntimeDir } from './browser.js';
import { loadRunnerToken, runnerAccount } from './connect.js';
import { forgetConnection, listConnections } from './connections.js';
import { listPools, sweepPool } from './dbpool.js';
import { acquireLock, lockHolderPid, pidAlive } from './lock.js';
import { NAME, brokerDir, checksHome, copiesDir, endedPath, locksDir, logDirFor, markerPath, poolDir, runsDir, under } from './paths.js';
import { fileNameFor, listProfiles, removeProfile } from './profiles.js';
import { findRegistration, nameClash, nameShadowsBoard, pinRegistration, pinState, readRegistrations, repoHeldBySibling } from './registry.js';
import { rootHolding } from './roots.js';
import { permissionFlag } from './sandbox.js';
import { allRunIds, clearRuns, readMarker, removeTree, sweepOrphans } from './scope.js';
import { listSecrets, storeProblems } from './secrets.js';
import { readServiceStatus } from './service.js';
import { sweepWarm } from './warm.js';
// -- CONSTANTS -- //
/** How many finished runs keep their folder (pictures and result). Older ones are removed by `doctor --fix`. */
export const KEEP_RUNS = 30;
/** Nothing younger than this is removed: it may only be starting. */
export const GRACE_MS = 2 * 60_000;
const NO_MARKER_GRACE_MS = 15 * 60_000;
const CLEAR_TARGETS = ['runs', 'profiles', 'auth', 'dbs', 'previews', 'all'];
const BOOLEAN = new Set(['--fix', '--json', '--yes', '--all', '--dry-run']);
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
// -- FUNCTIONS: SMALL HELPERS -- //
const cut = (s, n = 200) => (s.length > n ? `${s.slice(0, n)}...` : s);
function flagValue(args, name) {
    const i = args.indexOf(name);
    if (i < 0)
        return undefined;
    const v = args[i + 1];
    return v === undefined || v.startsWith('--') ? undefined : v;
}
/** The words that are not flags or flag values. */
function positional(args) {
    const out = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i] ?? '';
        if (a.startsWith('--')) {
            if (!BOOLEAN.has(a))
                i++;
            continue;
        }
        out.push(a);
    }
    return out;
}
const readJson = (file) => {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
};
const ageOf = (path, now) => {
    try {
        return now - statSync(path).mtimeMs;
    }
    catch {
        return 0;
    }
};
const plainIds = (dir) => {
    try {
        return readdirSync(dir).filter((n) => NAME.test(n));
    }
    catch {
        return [];
    }
};
/** The default rule for a board address: https, or http only on this machine, and no user name in it. */
export function trustedBoard(server) {
    try {
        const u = new URL(server);
        if (u.username || u.password)
            return false;
        if (u.protocol === 'https:')
            return true;
        return u.protocol === 'http:' && LOOPBACK.includes(u.hostname);
    }
    catch {
        return false;
    }
}
function emit(ctx, json, result, lines) {
    if (json)
        ctx.out(JSON.stringify(result));
    else
        for (const l of lines)
            ctx.log(l);
}
function readRuns(alive) {
    const live = new Set();
    const dead = [];
    const finished = [];
    for (const id of allRunIds()) {
        const dir = under(runsDir(), id);
        const marker = readMarker(id)?.marker;
        if (existsSync(markerPath(id))) {
            if (marker && alive(marker.pid))
                live.add(id);
            else
                dead.push(id);
            continue;
        }
        let mtime = 0;
        try {
            mtime = statSync(dir).mtimeMs;
        }
        catch {
            /* Gone */
        }
        finished.push({ id, mtime });
    }
    finished.sort((a, b) => b.mtime - a.mtime);
    return { live, dead, finished };
}
/** Copies no live run uses, old enough, whose run is gone or ended. Dead runs are named separately (their copy goes with them). */
function strayCopies(view, now, grace) {
    const out = [];
    for (const id of plainIds(copiesDir())) {
        if (view.live.has(id) || view.dead.includes(id))
            continue;
        const copy = under(copiesDir(), id);
        if (ageOf(copy, now) < grace)
            continue;
        const run = under(runsDir(), id);
        if (existsSync(run) && !existsSync(endedPath(id)) && ageOf(run, now) < NO_MARKER_GRACE_MS)
            continue;
        out.push(id);
    }
    return out;
}
function runsBeyond(view, keep, now, grace) {
    return view.finished
        .slice(keep)
        .filter((r) => now - r.mtime >= grace)
        .map((r) => r.id);
}
function removeRunFolders(id) {
    removeTree(under(copiesDir(), id));
    removeTree(under(runsDir(), id));
    removeTree(logDirFor(id));
    rmSync(markerPath(id), { force: true });
    rmSync(endedPath(id), { force: true });
}
// -- FUNCTIONS: MARKERS OF OTHER MODULES -- //
/**
 * Every JSON file under a folder (to a depth of four) that is a marker with a process id: { pid, ... }. Files without a numeric `pid` (pool markers name `ownerPid`,
 * which their own sweep reads) are left alone. Returns the dead ones, as names relative to the folder.
 */
function deadMarkers(root, alive) {
    const out = [];
    const walk = (dir, depth) => {
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const n of names) {
            const full = join(dir, n);
            let st;
            try {
                st = lstatSync(full);
            }
            catch {
                continue;
            }
            if (st.isSymbolicLink())
                continue;
            if (st.isDirectory()) {
                if (depth < 4)
                    walk(full, depth + 1);
                continue;
            }
            if (!n.endsWith('.json') || n.includes('.tmp'))
                continue;
            const v = readJson(full);
            const pid = v && typeof v === 'object' ? v.pid : undefined;
            if (typeof pid === 'number' && !alive(pid))
                out.push(full.slice(root.length + 1));
        }
    };
    walk(root, 0);
    return out;
}
function removeMarkers(root, names) {
    for (const n of names)
        rmSync(join(root, n), { force: true });
}
/** The worker locks (machine-*.lock) whose process is gone. */
function staleWorkerLocks() {
    let names;
    try {
        names = readdirSync(locksDir());
    }
    catch {
        return [];
    }
    return names
        .filter((n) => /^machine-[A-Za-z0-9_-]{1,56}\.lock$/.test(n))
        .map((n) => n.slice(0, -'.lock'.length))
        .filter((name) => lockHolderPid(name) === null);
}
function dropWorkerLock(name) {
    // A stale lock is taken over (moved aside) by the same rule every worker uses, then given back
    const lock = acquireLock(name, { staleMs: 60_000 });
    if (!lock)
        return false;
    lock.release();
    return true;
}
// -- FUNCTIONS: DOCTOR -- //
/**
 * Runs every check. With `fix` it repairs what it may. Each problem has one plain sentence and the exact next step. `deps` lets a test stand in for docker, the browser
 * install, the board trust rule and the clock.
 */
export async function runDoctor(ctx, opts, deps = {}) {
    const fix = opts.fix;
    const now = (deps.now ?? Date.now)();
    const alive = deps.pidAlive ?? pidAlive;
    const grace = deps.graceMs ?? GRACE_MS;
    const keep = deps.keepRuns ?? KEEP_RUNS;
    const fixed = [];
    const problems = [];
    const found = (problem, next) => problems.push({ problem, next });
    const did = (text) => fixed.push(text);
    const guard = async (what, fn) => {
        try {
            await fn();
        }
        catch (e) {
            found(`${what} could not be checked: ${cut(e instanceof Error ? e.message : String(e))}`, 'Run: agent-flow-board check doctor --fix --json');
        }
    };
    // -- THE AUDIT CHAIN: EVIDENCE ONLY, NOTHING TO REPAIR -- //
    await guard('The audit log', () => {
        if (!verifyAudit().ok)
            found('The audit log does not verify (it was edited or cut).', 'Do not edit it. Move checks/audit.log and audit.log.head aside to start a new chain.');
    });
    // -- THE SANDBOX -- //
    if (!(deps.hasPermissionModel ?? (() => Boolean(permissionFlag())))())
        found('This Node has no permission model, so check scripts cannot be sandboxed.', 'Install Node 20.18 or later (or any Node 22).');
    // -- THE BROWSER INSTALL -- //
    await guard('The browser install', async () => {
        if ((deps.browserInstalled ?? (() => Boolean(playwrightRuntimeDir())))())
            return;
        if (fix) {
            try {
                await (deps.ensureBrowser ?? ensureBrowser)(ctx.log);
                did('The browser was installed.');
            }
            catch (e) {
                found(`The browser could not be installed: ${cut(e instanceof Error ? e.message : String(e))}`, 'Check the network, then run: agent-flow-board check setup');
            }
        }
        else
            found('The browser is not installed.', 'Run: agent-flow-board check doctor --fix');
    });
    // -- WHAT DEAD RUNS LEFT: FOLDERS, COPIES, CONTAINERS, PREVIEWS -- //
    await guard('The runs', async () => {
        const view = readRuns(alive);
        if (fix) {
            if (view.dead.length) {
                const n = await sweepOrphans(ctx.log, { docker: deps.docker });
                if (n)
                    did(`${n} run(s) left by a process that is gone were cleaned up (folder, copy, preview, database).`);
            }
            const fresh = readRuns(alive);
            const stray = strayCopies(fresh, now, grace);
            for (const id of stray)
                removeTree(under(copiesDir(), id));
            if (stray.length)
                did(`${stray.length} private copy(ies) of a repo, left by runs that are gone, were removed.`);
            const old = runsBeyond(fresh, keep, now, grace);
            for (const id of old)
                removeRunFolders(id);
            if (old.length)
                did(`${old.length} old run folder(s) were removed (the newest ${keep} are kept).`);
        }
        else {
            if (view.dead.length)
                found(`${view.dead.length} run(s) were left by a process that is gone (folders, copies, maybe a preview or a database).`, 'Run: agent-flow-board check doctor --fix');
            const stray = strayCopies(view, now, grace);
            if (stray.length)
                found(`${stray.length} private copy(ies) of a repo belong to runs that are gone.`, 'Run: agent-flow-board check doctor --fix');
            const old = runsBeyond(view, keep, now, grace);
            if (old.length)
                found(`${old.length} finished run folder(s) are beyond the newest ${keep}.`, 'Run: agent-flow-board check doctor --fix');
        }
    });
    // -- THE POOLS: DATABASE, BROWSER, WARM PREVIEWS, AND ANY MARKER WITH A DEAD PROCESS ID -- //
    await guard('The pools', async () => {
        const deadPools = listPools().filter((p) => !p.ownerAlive && p.liveRuns === 0 && now - Date.parse(p.marker.createdAt) >= grace);
        const deadBrowsers = listBrowserMarkers().filter((b) => !b.ownerAlive);
        const marks = [
            ...deadMarkers(brokerDir(), alive).map((n) => ['broker', n]),
            ...deadMarkers(poolDir(), alive).map((n) => ['pool', n])
        ];
        if (!fix) {
            if (deadPools.length)
                found(`${deadPools.length} pooled database container(s) have no owner and no live run: ${deadPools.map((p) => p.marker.containerName).join(', ')}.`, 'Run: agent-flow-board check doctor --fix');
            if (deadBrowsers.length + marks.length)
                found(`${deadBrowsers.length + marks.length} marker(s) of processes that are gone are left in the pool and broker folders.`, 'Run: agent-flow-board check doctor --fix');
            return;
        }
        const removedPools = await (deps.sweepPools ?? (() => sweepPool({ docker: deps.docker })))();
        if (removedPools.length)
            did(`Pooled database container(s) removed by their recorded name: ${removedPools.join(', ')}.`);
        const warm = await (deps.sweepWarm ?? sweepWarm)();
        if (warm)
            did(`${warm} warm preview(s) that expired or lost their owner were stopped.`);
        const b = (deps.sweepBrowsers ?? sweepBrowserMarkers)();
        const brokerNames = marks.filter(([w]) => w === 'broker').map(([, n]) => n);
        const poolNames = marks.filter(([w]) => w === 'pool').map(([, n]) => n);
        removeMarkers(brokerDir(), brokerNames);
        removeMarkers(poolDir(), poolNames);
        if (b + brokerNames.length + poolNames.length)
            did(`${b + brokerNames.length + poolNames.length} marker(s) of processes that are gone were removed (slots, browsers, pools).`);
    });
    // -- THE WORKER LOCK -- //
    await guard('The worker lock', () => {
        const stale = staleWorkerLocks();
        if (!stale.length)
            return;
        if (!fix) {
            found('The lock of a worker that is no longer running is still there.', 'Run: agent-flow-board check doctor --fix');
            return;
        }
        const gone = stale.filter(dropWorkerLock).length;
        if (gone)
            did(`${gone} stale worker lock(s) were removed.`);
    });
    // -- THE BOARDS: A CREDENTIAL FOR A BOARD THAT IS NOT TRUSTED, A CONNECTION WITH NO TOKEN -- //
    await guard('The connections', () => {
        const trusted = deps.trustedBoard ?? trustedBoard;
        const tokenOf = deps.token ??
            (ctx.store ? (s, o) => loadRunnerToken(ctx.store, s, o) : null);
        for (const c of listConnections()) {
            if (!trusted(c.server)) {
                if (fix) {
                    ctx.store?.delete(runnerAccount(c.server, c.org));
                    forgetConnection(c.server, c.org);
                    did(`The credential for ${c.org} on a board that is not trusted was forgotten.`);
                }
                else
                    found(`${c.org} is connected to a board address that is not trusted (it must be https, or http on this machine).`, 'Run: agent-flow-board check doctor --fix');
                continue;
            }
            if (tokenOf && !tokenOf(c.server, c.org))
                found(`${c.org} on ${c.server} has no runner token.`, `Run: agent-flow-board check connect --server ${c.server} --org ${c.org} --json`);
        }
    });
    // -- THE REGISTRATIONS: DAMAGE, COLLISIONS, FOLDERS, PIN, SEALED STORES -- //
    await guard('The registrations', () => {
        const { registrations, problems: damaged } = readRegistrations();
        for (const d of damaged)
            found(d, 'Register it again: agent-flow-board check project <NAME> --org <slug> --repo <dir>');
        for (const r of registrations) {
            const id = `${r.org}/${r.name}`;
            const collisions = collisionsOf(r);
            for (const c of collisions)
                found(c, `Run: agent-flow-board check project forget ${r.name} --org ${r.org} --remove (or register it with its own clone or app folder)`);
            if (r.repo) {
                if (!existsSync(r.repo))
                    found(`${id}: the repo folder is not there any more.`, `Run: agent-flow-board check project forget ${r.name} --org ${r.org} --remove, then register it again.`);
                else if (!rootHolding(r.repo))
                    found(`${id}: the repo is not inside a folder the owner approved.`, 'Ask the owner: check approve --request --action roots --target <parent folder>, then check roots add <folder> --approval <code>.');
                else {
                    const pin = pinState(r);
                    if (pin === 'changed') {
                        if (fix) {
                            try {
                                pinRegistration(r.org, r.name);
                                did(`${id}: the files that decide what runs had changed. They passed the guardrails and were pinned again.`);
                            }
                            catch (e) {
                                found(`${id}: the files that decide what runs changed and were refused: ${cut(e instanceof Error ? e.message : String(e))}`, 'Fix what it names, then run: agent-flow-board check doctor --fix');
                            }
                        }
                        else
                            found(`${id}: the files that decide what runs changed since they were pinned.`, 'Run: agent-flow-board check doctor --fix (they are checked against the guardrails first)');
                    }
                }
            }
            for (const p of storeProblems(r.org, r.name))
                found(cut(p), `Import the sealed values again: agent-flow-board check secrets import --project ${r.name} --org ${r.org} (doctor never removes a store)`);
        }
    });
    // -- THE SERVICE: REPORT ONLY -- //
    await guard('The service', () => {
        const s = readServiceStatus();
        if (s && s.state === 'stopped' && s.message)
            found(`The worker service stopped: ${cut(s.message)}`, 'Run: agent-flow-board check service status');
    });
    return { ok: problems.length === 0, fixed, problems };
}
/** Plain sentences for every uniqueness rule this registration breaks (a file edited by hand, or a rule added after it was made). */
function collisionsOf(r) {
    const out = [];
    const id = `${r.org}/${r.name}`;
    if (r.repo) {
        const sibling = repoHeldBySibling(r.org, r.name, r.repo, r.appDir);
        if (sibling)
            out.push(`${id} and ${sibling} name the same repo folder. Two registrations never share a folder.`);
    }
    const clash = nameClash(r.org, r.name);
    if (clash)
        out.push(`${id} and ${clash} differ only by letter case.`);
    const shadow = nameShadowsBoard(r.org, r.name, r.boardProject);
    if (shadow)
        out.push(`${id} and ${shadow} shadow each other's board project.`);
    return out;
}
// -- FUNCTIONS: STATUS -- //
function registrationStatus(r) {
    const count = (fn, fallback) => {
        try {
            return fn().length;
        }
        catch {
            return fallback;
        }
    };
    const secrets = count(() => listSecrets(r.org, r.name).keys, null);
    const signIns = count(() => listProfiles(r.org, r.name), 0) ?? 0;
    let pin = 'n/a';
    if (r.repo) {
        try {
            pin = pinState(r);
        }
        catch {
            pin = 'unreadable';
        }
    }
    return {
        org: r.org,
        name: r.name,
        boardProject: r.boardProject,
        kind: r.url ? 'site' : 'repo',
        ...(r.repo ? { folder: basename(r.repo) } : {}),
        ...(r.appDir ? { appDir: r.appDir } : {}),
        pin,
        signIns,
        secrets,
        adoptEnv: r.adoptEnv
    };
}
/** The state of this machine: registrations, the machine's slots, the service, the connections, the audit chain. Runs the read-only doctor checks too. */
export async function runStatus(ctx, deps = {}) {
    const base = await runDoctor(ctx, { fix: false }, deps);
    const tokenOf = deps.token ??
        (ctx.store ? (s, o) => loadRunnerToken(ctx.store, s, o) : null);
    const slots = (() => {
        try {
            return machineTotals();
        }
        catch {
            return null;
        }
    })();
    const svc = readServiceStatus();
    const audit = verifyAudit();
    return {
        ...base,
        home: checksHome(),
        registrations: readRegistrations().registrations.map(registrationStatus),
        slots,
        service: svc ? { state: svc.state, message: svc.message } : null,
        connections: listConnections().map((c) => ({
            server: c.server,
            org: c.org,
            connected: tokenOf ? Boolean(tokenOf(c.server, c.org)) : null
        })),
        audit: { ok: audit.ok, lines: audit.lines },
        browser: (deps.browserInstalled ?? (() => Boolean(playwrightRuntimeDir())))()
    };
}
/**
 * `check status [--json]` and `check doctor [--fix] [--json]`. The first word of `args` is `status` or `doctor` (status when absent). Exit 0, or 1 when `doctor` lists a problem.
 * Supersedes statusOrDoctor in command.ts.
 */
export async function healthCommand(args, ctx, deps = {}) {
    const word = args[0] === 'doctor' ? 'doctor' : 'status';
    const json = ctx.json ?? args.includes('--json');
    const fix = args.includes('--fix');
    try {
        if (word === 'doctor') {
            // Two doctors at once would race on the same files
            const lock = fix ? acquireLock('doctor', { staleMs: 10 * 60_000 }) : null;
            if (fix && !lock) {
                emit(ctx, json, {
                    ok: false,
                    fixed: [],
                    problems: [
                        { problem: 'Another doctor is running.', next: 'Wait for it, then run doctor again.' }
                    ]
                }, ['Another doctor is running. Wait for it, then run doctor again.']);
                return 1;
            }
            try {
                const r = await runDoctor(ctx, { fix }, deps);
                emit(ctx, json, r, [
                    ...r.fixed.map((f) => `Fixed: ${f}`),
                    ...r.problems.map((p) => `Problem: ${p.problem} Next: ${p.next}`),
                    r.ok
                        ? 'Nothing is wrong.'
                        : 'Some problems are left. They are listed above with the exact next step.'
                ]);
                return r.ok ? 0 : 1;
            }
            finally {
                lock?.release();
            }
        }
        const s = await runStatus(ctx, deps);
        emit(ctx, json, s, [
            `State folder: ${s.home}`,
            `Registrations: ${s.registrations.map((r) => `${r.org}/${r.name} -> ${r.boardProject} (${r.kind === 'site' ? 'live site' : (r.folder ?? '')}${r.appDir ? `/${r.appDir}` : ''}, pin ${r.pin})`).join('; ') || 'none'}`,
            `Slots: ${s.slots ? `${s.slots.busy} of ${s.slots.slots} busy` : 'unknown'}`,
            `Service: ${s.service ? s.service.state : 'not installed'}`,
            `Connections: ${s.connections.map((c) => `${c.org}@${c.server}${c.connected === false ? ' (no token)' : ''}`).join(', ') || 'none'}`,
            ...(localFingerprint()
                ? [
                    `Sign-in key: ${localFingerprint()} (compare with the code on the board before typing a password there)`
                ]
                : []),
            `Audit chain: ${s.audit.ok ? 'ok' : 'BROKEN'} (${s.audit.lines} lines)`,
            ...s.problems.map((p) => `Problem: ${p.problem} Next: ${p.next}`),
            s.problems.length ? '' : 'Nothing is wrong.'
        ].filter((l) => l !== ''));
        return 0;
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (json)
            ctx.out(JSON.stringify({ ok: false, event: 'error', error: message }));
        else
            ctx.log(message);
        return 2;
    }
}
// -- FUNCTIONS: CLEAR -- //
export const CLEAR_USAGE = 'Usage: agent-flow-board check clear [runs|profiles|auth|dbs|previews|all] [--registration NAME --org <slug> [--site <address>]] [--yes] [--all]\n' +
    '  runs      finished run folders and their copies (older than 7 days; every finished one with --all)\n' +
    '  profiles  saved sign-ins of one registration (--registration, --org; --site for one address)\n' +
    '  auth      the saved sign-ins of one registration and the runner token of its organisation\n' +
    '  dbs       databases and containers the tool recorded, by their recorded names\n' +
    '  previews  previews, browsers and warm previews that are left\n' +
    '  all       runs (all finished), dbs and previews; never sign-ins or sealed secrets\n' +
    '  profiles, auth, dbs and all need --yes. The scripts folder, sealed secrets and the audit log are never touched.';
/**
 * `check clear runs|profiles|auth|dbs|previews|all [--yes] [--all]`. Removes only exact recorded folders, markers, names and files; a live run is always kept. With no target it
 * clears finished runs, as the earlier `clear` did.
 */
export async function clearCommand(args, ctx, deps = {}) {
    const json = ctx.json ?? args.includes('--json');
    const words = positional(args[0] === 'clear' ? args.slice(1) : args);
    const target = (words[0] ?? 'runs');
    const done = [];
    const left = [];
    try {
        if (!CLEAR_TARGETS.includes(target)) {
            ctx.log(CLEAR_USAGE);
            return 2;
        }
        const all = args.includes('--all');
        const yes = args.includes('--yes');
        const needsYes = target === 'profiles' || target === 'auth' || target === 'dbs' || target === 'all';
        if (needsYes && !yes) {
            emit(ctx, json, { ok: false, error: 'This deletes data. Add --yes to confirm.' }, [
                `This removes ${target === 'all' ? 'runs, databases and previews' : target}. Add --yes to confirm (nothing waits on a terminal).`
            ]);
            return 2;
        }
        const alive = deps.pidAlive ?? pidAlive;
        if (target === 'runs' || target === 'all') {
            const r = clearRuns({ all: all || target === 'all' });
            done.push(`${r.removed} finished run folder(s) removed`);
        }
        if (target === 'dbs' || target === 'all') {
            // A run that is working keeps its database: only runs whose marker names a dead process are cleaned, and pools with no owner and no live run
            const n = await sweepOrphans(ctx.log, { docker: deps.docker });
            const pools = await (deps.sweepPools ?? (() => sweepPool({ docker: deps.docker, minAgeMs: 0 })))();
            done.push(`${n} dead run(s) cleaned (their databases by recorded name), ${pools.length} pooled container(s) removed`);
            if (readRuns(alive).live.size)
                left.push('the databases of runs that are working');
        }
        if (target === 'previews' || target === 'all') {
            const n = await sweepOrphans(ctx.log, { docker: deps.docker });
            const warm = await (deps.sweepWarm ?? sweepWarm)();
            const b = (deps.sweepBrowsers ?? sweepBrowserMarkers)();
            const marks = deadMarkers(poolDir(), alive);
            removeMarkers(poolDir(), marks);
            done.push(`${n} dead run(s) cleaned, ${warm} warm preview(s) stopped, ${b + marks.length} marker(s) removed`);
        }
        if (target === 'profiles' || target === 'auth') {
            const org = flagValue(args, '--org');
            const name = flagValue(args, '--registration');
            if (!org || !name) {
                ctx.log(`clear ${target} needs the registration: --registration NAME --org <slug>.`);
                return 2;
            }
            const reg = findRegistration(org, name);
            if (!reg) {
                ctx.log(`There is no registration ${name} in ${org}.`);
                return 2;
            }
            const site = flagValue(args, '--site');
            const entries = listProfiles(org, reg.name).filter((p) => !site || p.file === fileNameFor(site));
            let gone = 0;
            for (const p of entries)
                if (removeProfile(org, reg.name, p.file))
                    gone++;
            done.push(`${gone} saved sign-in(s) of ${org}/${reg.name} removed`);
            if (target === 'auth') {
                let tokens = 0;
                for (const c of listConnections().filter((x) => x.org === org)) {
                    ctx.store?.delete(runnerAccount(c.server, c.org));
                    forgetConnection(c.server, c.org);
                    tokens++;
                }
                done.push(`${tokens} connection(s) of ${org} forgotten (connect again to work for them)`);
            }
        }
        emit(ctx, json, { ok: true, target, done, left }, [
            ...done.map((d) => `Done: ${d}.`),
            left.length ? `Left alone because a run is still using them: ${left.join(', ')}.` : 'Done.'
        ]);
        return 0;
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (json)
            ctx.out(JSON.stringify({ ok: false, event: 'error', error: message }));
        else
            ctx.log(message);
        return 2;
    }
}
