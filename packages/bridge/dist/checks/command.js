// THE `check` COMMAND GROUP: connect, run, pull, bind, watch, status, doctor, clear, setup
// Loaded only when the first argument is `check`, so the hooks and the MCP forwarder never load any of it (and never load Playwright).
// Nothing here waits on a terminal: every command takes its input from flags and ends on its own.
// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
// -- MODULES -- //
import { verifyAudit } from './audit.js';
import { bindFolder, listBindings, pinStatus } from './bind.js';
import { ensureBrowser, playwrightRuntimeDir } from './browser.js';
import { connectChecks, loadRunnerToken, runnerAccount } from './connect.js';
import { forgetConnection, listConnections, recordConnection } from './connections.js';
import { ORG_SLUG, checksHome, scriptPath } from './paths.js';
import { pinFiles, resolveProjectConfig } from './recipe.js';
import { runCheck } from './run.js';
import { clearRuns, sweepOrphans } from './scope.js';
import { permissionFlag } from './sandbox.js';
import { watchChecks } from './watch.js';
// -- CONSTANTS -- //
export const CHECK_USAGE = [
    'Usage: agent-flow-board check <command>',
    '  connect --server <url> --org <slug> [--project KEY,KEY] [--json]   make this machine a runner (an agent approves the code)',
    '  run <item> <key> --server <url> --org <slug> [--step 1.2] [--run <id>] [--dir <repo>] [--json]   run one check in this repo',
    '  pull <item> <key> --server <url> --org <slug> [--accept-hash <sha256>]   read the board copy of a script; accept it by hash',
    '  bind --org <slug> --project <KEY> [--dir <repo>]   remember the folder of a board project for "check watch"',
    '  watch [--parallel N] [--once]   take queued runs from the boards this machine is connected to',
    '  status [--json]  |  doctor [--fix] [--json]  |  clear [--all]  |  setup  |  disconnect --server <url> --org <slug>'
].join('\n');
// -- FUNCTIONS -- //
/** Runs one check command and returns the exit code: 0 done, 1 a check failed or a problem was listed, 2 could not run. */
export async function checkMain(ctx) {
    const { args, log, out } = ctx;
    const sub = args[0];
    const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const has = (name) => args.includes(name);
    const json = has('--json');
    const need = (name) => {
        const v = flag(name);
        if (!v || v.startsWith('--'))
            throw new Error(`Say ${name} <value>.`);
        return v;
    };
    const server = () => {
        const s = flag('--server') ?? process.env.AFB_SERVER;
        if (!s)
            throw new Error('Say which board to use: --server https://board.example.com (or set AFB_SERVER).');
        return s.replace(/\/$/, '');
    };
    const org = () => {
        const o = need('--org');
        if (!ORG_SLUG.test(o))
            throw new Error('--org takes an organisation slug: lowercase letters, digits and dashes.');
        return o;
    };
    try {
        if (sub === 'connect') {
            const s = server();
            const o = org();
            const projects = flag('--project')
                ?.split(',')
                .map((p) => p.trim())
                .filter(Boolean);
            const done = await connectChecks({
                server: s,
                org: o,
                projects,
                json,
                store: ctx.store,
                fetch: ctx.fetch,
                log,
                out
            });
            recordConnection({ server: s, org: o, name: done.name });
            return 0;
        }
        if (sub === 'disconnect') {
            const s = server();
            const o = org();
            ctx.store.delete(runnerAccount(s, o));
            forgetConnection(s, o);
            log('Disconnected. The runner on the board is removed from the board settings.');
            return 0;
        }
        if (sub === 'run') {
            const item = args[1];
            const key = args[2];
            if (!item || !key || item.startsWith('--') || key.startsWith('--'))
                throw new Error('Usage: agent-flow-board check run <item> <key> --server <url> --org <slug>');
            const s = server();
            const o = org();
            const token = loadRunnerToken(ctx.store, s, o);
            if (!token)
                throw new Error(`This machine is not connected to ${o} on ${s}. Run: agent-flow-board check connect --server ${s} --org ${o} --json`);
            const outcome = await runCheck({
                server: s,
                org: o,
                item,
                key,
                dir: resolve(flag('--dir') ?? process.cwd()),
                step: flag('--step'),
                runId: flag('--run'),
                runnerToken: token,
                personalToken: ctx.personalToken(s, o),
                fetch: ctx.fetch,
                log,
                headed: has('--headed')
            });
            if (json)
                out(JSON.stringify({
                    ok: outcome.exitCode === 0,
                    runId: outcome.runId,
                    message: outcome.message
                }));
            else
                log(outcome.message);
            // The last line is always the result file, so an agent can read it
            if (outcome.resultPath)
                out(`RESULT ${outcome.resultPath}`);
            return outcome.exitCode;
        }
        if (sub === 'pull') {
            const item = args[1];
            const key = args[2];
            if (!item || !key)
                throw new Error('Usage: agent-flow-board check pull <item> <key> --server <url> --org <slug> [--accept-hash <sha256>]');
            const s = server();
            const o = org();
            const personal = ctx.personalToken(s, o);
            if (!personal)
                throw new Error(`Not signed in to ${o} on ${s}. Run: agent-flow-board login --json --server ${s} --org ${o}`);
            const res = await ctx.fetch(`${s}/api/v1/orgs/${encodeURIComponent(o)}/items/${encodeURIComponent(item)}/browser-checks`, {
                headers: { authorization: `Bearer ${personal}` },
                signal: AbortSignal.timeout(30_000)
            });
            const body = (await res.json().catch(() => ({})));
            if (!res.ok)
                throw new Error(body.error?.message ?? `The board answered ${res.status}.`);
            const script = body.checks?.find((c) => c.key === key)?.script;
            if (!script)
                throw new Error(`The board has no saved script for ${item} ${key}.`);
            const hash = createHash('sha256').update(script).digest('hex');
            const target = scriptPath(o, item, key);
            const local = existsSync(target) ? readFileSync(target, 'utf8') : null;
            const accept = flag('--accept-hash');
            if (accept) {
                if (accept !== hash)
                    throw new Error('The board script changed since you read it (its hash is different), so nothing was written. Pull again.');
                mkdirSync(dirname(target), { recursive: true });
                writeFileSync(target, script);
                log(`Wrote ${target}.`);
                return 0;
            }
            // The script is text written by someone else: it is shown as data and never run until it is accepted by its hash
            out(JSON.stringify({
                item,
                key,
                hash,
                local: local === null ? 'none' : local === script ? 'same' : 'different',
                target,
                script
            }));
            return 0;
        }
        if (sub === 'bind') {
            const o = org();
            const project = need('--project');
            const dir = resolve(flag('--dir') ?? process.cwd());
            const cfg = resolveProjectConfig(dir);
            bindFolder(o, project, cfg.repo, pinFiles(cfg.repo));
            log(`Bound ${o}/${project} to ${cfg.repo}.`);
            return 0;
        }
        if (sub === 'watch') {
            const ac = new AbortController();
            const stop = () => ac.abort();
            process.once('SIGINT', stop);
            process.once('SIGTERM', stop);
            const n = await watchChecks({
                store: ctx.store,
                fetch: ctx.fetch,
                log,
                parallel: Number(flag('--parallel') ?? 3) || 3,
                once: has('--once'),
                signal: ac.signal
            });
            log(`Took ${n} run(s).`);
            return 0;
        }
        if (sub === 'setup') {
            await ensureBrowser(log);
            log('The browser is ready.');
            return 0;
        }
        if (sub === 'status' || sub === 'doctor')
            return await statusOrDoctor(ctx, sub === 'doctor', has('--fix'), json);
        if (sub === 'clear') {
            const r = clearRuns({ all: has('--all') });
            log(`Removed ${r.removed} finished run folder(s).`);
            return 0;
        }
        log(CHECK_USAGE);
        return 2;
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (json)
            out(JSON.stringify({ ok: false, event: 'error', error: message }));
        else
            log(message);
        return 2;
    }
}
async function statusOrDoctor(ctx, doctor, fix, json) {
    const problems = [];
    const audit = verifyAudit();
    if (!audit.ok)
        problems.push({
            problem: 'The audit log does not verify (it was edited or cut).',
            next: 'Do not edit it. Move checks/audit.log aside to start a new chain.'
        });
    if (!permissionFlag())
        problems.push({
            problem: 'This Node has no permission model, so check scripts cannot be sandboxed.',
            next: 'Install Node 20.18 or later (or any Node 22).'
        });
    if (!playwrightRuntimeDir()) {
        if (doctor && fix)
            await ensureBrowser(ctx.log);
        else
            problems.push({
                problem: 'The browser is not installed.',
                next: 'Run: agent-flow-board check setup'
            });
    }
    const swept = doctor && fix ? await sweepOrphans(ctx.log) : 0;
    const connections = listConnections().map((c) => ({
        ...c,
        connected: Boolean(loadRunnerToken(ctx.store, c.server, c.org))
    }));
    for (const c of connections)
        if (!c.connected)
            problems.push({
                problem: `${c.org} on ${c.server} has no runner token.`,
                next: `Run: agent-flow-board check connect --server ${c.server} --org ${c.org} --json`
            });
    const bindings = listBindings().map((b) => ({
        org: b.org,
        project: b.projectKey,
        folder: b.folder,
        pin: pinStatus(b.org, b.projectKey)
    }));
    for (const b of bindings)
        if (b.pin !== 'ok')
            problems.push({
                problem: `${b.org}/${b.project}: the files that decide what runs changed in ${b.folder}.`,
                next: `In that folder run a check once: agent-flow-board check run <item> <key> --org ${b.org}`
            });
    const state = {
        home: checksHome(),
        connections,
        bindings,
        audit: { ok: audit.ok, lines: audit.lines },
        browser: Boolean(playwrightRuntimeDir()),
        swept,
        problems
    };
    if (json)
        ctx.out(JSON.stringify(state));
    else {
        ctx.log(`State folder: ${state.home}`);
        ctx.log(`Connections: ${connections.map((c) => `${c.org}@${c.server}${c.connected ? '' : ' (no token)'}`).join(', ') || 'none'}`);
        ctx.log(`Bound folders: ${bindings.map((b) => `${b.org}/${b.project} -> ${b.folder} (${b.pin})`).join('; ') || 'none'}`);
        for (const p of problems)
            ctx.log(`Problem: ${p.problem} Next: ${p.next}`);
        if (!problems.length)
            ctx.log('Nothing is wrong.');
    }
    return doctor && problems.length ? 1 : 0;
}
