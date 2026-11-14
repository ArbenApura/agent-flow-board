// THE `check` COMMAND GROUP: connect, run, pull, bind, watch, status, doctor, clear, setup
// Loaded only when the first argument is `check`, so the hooks and the MCP forwarder never load any of it (and never load Playwright).
// Nothing here waits on a terminal: every command takes its input from flags and ends on its own.
// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
// -- MODULES -- //
import { bindFolder } from './bind.js';
import { ensureBrowser } from './browser.js';
import { connectChecks, loadRunnerToken, runnerAccount } from './connect.js';
import { forgetConnection, listConnections, recordConnection } from './connections.js';
import { RunnerBoard } from './board.js';
import { publishSigninKey } from './signinKey.js';
import { ORG_SLUG, scriptPath, scriptsDir } from './paths.js';
import { pinFiles, resolveProjectConfig } from './recipe.js';
import { listRegistrations } from './registry.js';
import { rerunOnChange } from './rerun.js';
import { registrationHeader } from './routing.js';
import { inspectAppRegistration } from './inspectApp.js';
import { fetchMockupContract, manifestFromContract, runCompare } from './compare.js';
import { runCheck } from './run.js';
import { watchChecks } from './watch.js';
import { approveCommand, projectCommand, rootsCommand } from './commands.js';
import { clearCommand, healthCommand } from './doctor.js';
import { importLegacyCommand } from './importlegacy.js';
import { loginCommand } from './login.js';
import { secretsCommand } from './secretscmd.js';
import { serviceCommand } from './service.js';
// -- CONSTANTS -- //
export const CHECK_USAGE = [
    'Usage: agent-flow-board check <command>',
    '  connect --server <url> --org <slug> [--project KEY,KEY] [--json]   make this machine a runner (an agent approves the code)',
    '  run <item> <key> --server <url> --org <slug> [--step 1.2] [--run <id>] [--dir <repo>] [--json]   run one check in this repo',
    '  pull <item> <key> --server <url> --org <slug> [--accept-hash <sha256>]   read the board copy of a script; accept it by hash',
    '  bind --org <slug> --project <KEY> [--dir <repo>]   remember the folder of a board project for "check watch"',
    '  watch [--parallel N] [--once]   take queued runs from the boards this machine is connected to',
    '  rerun-on-change <PATH> --check <KEY> --item <ITEM> --org <slug> [--registration NAME] [--profile NAME]   re-run a local dev check on file changes (distinct from watch)',
    '  inspect <REGISTRATION> --org <slug> [--profile NAME] [--path /route] [--screen S] [--state T] [--width W] [--height H]   dump rendered DOM box/styles/text from the app',
    '  compare --mockup ID[@VERSION] --registration NAME --org <slug> [--server <url>] [--profile NAME] [--screens s1,s2] [--states t1,t2] [--widths 390,1280] [--manifest <file.json>] [--brief <file.md>] [--item <ref> --key <KEY>]   compare mockup vs app',
    '  run ... also takes [--registration NAME] [--profile NAME] [--mockup ID[@VERSION]] [--file <script inside the scripts folder>] [--headed] [--local]   (--local runs here with no board call; automatic by default for a dev registration)',
    '  project <NAME> --org <slug> (--repo <dir> [--app-dir web] [--board-project KEY] [--recipe] | --url <address> [--extra-hosts a,b]) [--adopt-env --adopt-env-approval <code>] [--upload-pictures --pictures-approval <code>] [--approval <code>] | project list|forget|pin',
    '  approve --request --action <roots|register|secrets|adopt-env|pictures|login|dev> --target <name> [--why "<sentence>"] [--wait <minutes>]   (asks the owner on the board; no terminal)',
    '  approve --request-many "<action>:<target>;<action>:<target>"  |  approve --resume <id,id> [--wait <minutes>]   (exit 3 = still waiting)',
    '  approve --action <roots|register|secrets|adopt-env|pictures|login|dev> --target <name>   (the owner, on a terminal)  |  roots add|list|remove <dir> [--approval <code>]',
    '  secrets import|list|forget --org <slug> --project <NAME> [--from <file> --keys A,B --test-ref <ref> --test-inbox <email> --owner-said "<sentence>" --allow-service-role --approval <code>]',
    '  login <NAME> --org <slug> [--profile <profile>] [--seeded [url|cmd] | --approval <code>] [--timeout <minutes>]   (--profile saves sealed per-role state, e.g. patient, doctor, staff)',
    '  service install|uninstall|status [--no-start]  |  import-legacy --from <afb-checks folder> --org <slug> [--dry-run]',
    '  status [--json]  |  doctor [--fix] [--json]  |  clear [runs|profiles|auth|dbs|previews|all] [--all] [--yes]  |  setup  |  disconnect --server <url> --org <slug>'
].join('\n');
// -- FUNCTIONS -- //
/** The value of --parallel: undefined when the flag is absent (the machine decides), else a whole number from 1 up. */
export function parallelFlag(raw) {
    if (raw === undefined)
        return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1)
        throw new Error(`--parallel takes a whole number of 1 or more, not "${raw.slice(0, 20)}".`);
    return n;
}
/** Runs one check command and returns the exit code: 0 done, 1 a check failed or a problem was listed, 2 could not run. */
export async function checkMain(ctx) {
    const { args, log, out } = ctx;
    const sub = args[0];
    // A flag that is given takes the next word as its value; a missing value, or another flag in its place (--step --json), is an error and never a silent default
    const flag = (name) => {
        if (!args.includes(name))
            return undefined;
        const v = args[args.indexOf(name) + 1];
        if (v === undefined || v.startsWith('--'))
            throw new Error(`Say ${name} <value>.`);
        return v;
    };
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
            // The sign in key of this machine goes to the board with the connection. A board that does not know it yet, or a failure, never stops a connect
            const runnerToken = loadRunnerToken(ctx.store, s, o);
            if (runnerToken)
                await publishSigninKey(new RunnerBoard(s, runnerToken, ctx.fetch)).catch(() => undefined);
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
            // `--file <script>` names a script inside the scripts folder (<org>/<item>/<key>.mjs) instead of the item and the key
            // The item and the key are the first two words that are not flags or flag values, so a switch such as `--local` or `--org x` may stand before them
            const valueFlags = new Set([
                '--org',
                '--server',
                '--registration',
                '--profile',
                '--file',
                '--step',
                '--run',
                '--dir',
                '--mockup'
            ]);
            const words = args
                .slice(1)
                .filter((a, i, all) => !a.startsWith('--') && !valueFlags.has(all[i - 1] ?? ''));
            let item = words[0];
            let key = words[1];
            let fileOrg = null;
            const fileFlag = flag('--file');
            if (fileFlag) {
                const rel = relative(scriptsDir(), resolve(fileFlag)).split(/[\\/]/);
                const base = rel[2]?.replace(/\.mjs$/, '');
                if (rel.length !== 3 || rel.includes('..') || !base)
                    throw new Error(`--file must be a script inside ${scriptsDir()}, in the form <org>/<item>/<key>.mjs.`);
                fileOrg = rel[0] ?? null;
                item = rel[1];
                key = base;
            }
            if (!item || !key || item.startsWith('--') || key.startsWith('--'))
                throw new Error('Usage: agent-flow-board check run <item> <key> --server <url> --org <slug> (or --file <script>)');
            // `--local` runs the script here with no board call at all: no server, no connection, no token, no run on the board
            const localRun = has('--local');
            if (localRun && (flag('--run') || flag('--step') || flag('--server')))
                throw new Error('--local runs here with no board, so it takes no --run, --step or --server (nothing is asked for, closed or reported).');
            const o = org();
            // The folder of a script names its organisation: a script of one organisation is never run as another's
            if (fileOrg !== null && fileOrg !== o)
                throw new Error(`--file is a script of the organisation ${fileOrg.slice(0, 40)}, but --org says ${o}. Use the same organisation in both.`);
            const mockupFlag = flag('--mockup');
            if (localRun && mockupFlag)
                throw new Error('--local runs here with no board, so it cannot fetch a hosted --mockup URL from the board.');
            // On a dev registration with no --server/--run/--step, local mode is the default loop
            let effectiveLocal = localRun;
            if (!effectiveLocal &&
                !mockupFlag &&
                !flag('--server') &&
                !flag('--run') &&
                !flag('--step')) {
                const targetFile = scriptPath(o, item, key);
                const scriptReg = existsSync(targetFile)
                    ? registrationHeader(readFileSync(targetFile, 'utf8'))
                    : null;
                const wantedReg = flag('--registration') ?? scriptReg;
                if (wantedReg) {
                    const foundReg = listRegistrations(o).find((r) => r.name.toLowerCase() === wantedReg.toLowerCase());
                    if (foundReg?.devUrl)
                        effectiveLocal = true;
                }
            }
            let s = '';
            let token = '';
            if (!effectiveLocal) {
                s = server();
                const held = loadRunnerToken(ctx.store, s, o);
                if (!held)
                    throw new Error(`This machine is not connected to ${o} on ${s}. Run: agent-flow-board check connect --server ${s} --org ${o} --json`);
                token = held;
            }
            const outcome = await runCheck({
                mode: effectiveLocal ? 'local' : 'board',
                server: s,
                org: o,
                item,
                key,
                dir: resolve(flag('--dir') ?? process.cwd()),
                step: flag('--step'),
                runId: effectiveLocal ? undefined : flag('--run'),
                registration: flag('--registration'),
                profile: flag('--profile'),
                mockup: mockupFlag,
                runnerToken: token,
                personalToken: effectiveLocal ? null : ctx.personalToken(s, o),
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
        // The registration, approval, sign in and service commands live in their own modules; each takes the arguments after its word
        if (sub === 'project')
            return await projectCommand(args.slice(1), { log, out, json });
        if (sub === 'inspect') {
            const regName = args[1];
            if (!regName || regName.startsWith('--'))
                throw new Error('Usage: agent-flow-board check inspect <registration> --org <slug> [--profile NAME] [--path /route] [--screen S] [--state T] [--width W] [--height H]');
            const widthRaw = flag('--width');
            const heightRaw = flag('--height');
            const width = widthRaw !== undefined ? Number(widthRaw) : undefined;
            const height = heightRaw !== undefined ? Number(heightRaw) : undefined;
            if (width !== undefined && (!Number.isInteger(width) || width < 240 || width > 3840))
                throw new Error('--width must be a whole number between 240 and 3840.');
            if (height !== undefined && (!Number.isInteger(height) || height < 240 || height > 3840))
                throw new Error('--height must be a whole number between 240 and 3840.');
            const res = await inspectAppRegistration({
                org: org(),
                registration: regName,
                profile: flag('--profile'),
                routePath: flag('--path'),
                screen: flag('--screen'),
                state: flag('--state'),
                width,
                height,
                headed: has('--headed'),
                log
            });
            out(JSON.stringify(res.dump));
            return 0;
        }
        if (sub === 'compare') {
            const mockupArg = need('--mockup');
            const regName = need('--registration');
            const o = org();
            const s = server();
            const itemArg = flag('--item');
            const keyArg = flag('--key');
            const isBoard = !has('--local') && Boolean(itemArg && keyArg);
            const runnerTok = isBoard ? loadRunnerToken(ctx.store, s, o) : null;
            if (isBoard && !runnerTok)
                throw new Error(`This machine is not connected to ${o} on ${s}. Run: agent-flow-board check connect --server ${s} --org ${o} --json`);
            const manifestPath = flag('--manifest');
            let manifest = manifestPath
                ? JSON.parse(readFileSync(resolve(manifestPath), 'utf8'))
                : undefined;
            // A mockup that carries a contract gives compare its pairs, its free lines and how each state is reached; the command line wins
            const personal = ctx.personalToken(s, o);
            const contract = personal
                ? await fetchMockupContract({
                    server: s,
                    org: o,
                    token: personal,
                    fetch: ctx.fetch,
                    mockup: mockupArg,
                    log
                })
                : null;
            if (contract) {
                manifest = manifestFromContract(contract, manifest);
                log('Using the pairing, free lines and states of the mockup contract.');
            }
            const briefPath = flag('--brief');
            const briefText = briefPath ? readFileSync(resolve(briefPath), 'utf8') : undefined;
            const pathArg = flag('--path');
            const screensRaw = flag('--screens');
            const screens = screensRaw
                ? screensRaw
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean)
                    .map((name) => ({ name, screen: name, ...(pathArg ? { path: pathArg } : {}) }))
                : pathArg
                    ? [{ name: 'default', screen: '', path: pathArg }]
                    : undefined;
            const statesRaw = flag('--states');
            const states = statesRaw
                ? statesRaw
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean)
                : undefined;
            const widthsRaw = flag('--widths');
            const widths = widthsRaw
                ? widthsRaw.split(',').map((w) => {
                    const n = Number(w.trim());
                    if (!Number.isInteger(n) || n < 240 || n > 3840)
                        throw new Error(`Invalid width "${w}" in --widths (must be 240..3840).`);
                    return n;
                })
                : contract?.widths?.length
                    ? contract.widths
                    : undefined;
            const outcome = await runCompare({
                mode: isBoard ? 'board' : 'local',
                server: s,
                org: o,
                mockup: mockupArg,
                registration: regName,
                profile: flag('--profile'),
                screens,
                states,
                widths,
                manifest,
                briefText,
                dir: resolve(flag('--dir') ?? process.cwd()),
                item: itemArg,
                key: keyArg,
                step: flag('--step'),
                runId: flag('--run'),
                runnerToken: runnerTok ?? '',
                personalToken: ctx.personalToken(s, o),
                fetch: ctx.fetch,
                log,
                headed: has('--headed'),
                reducedMotion: has('--reduced-motion')
            });
            if (json)
                out(JSON.stringify({
                    ok: outcome.exitCode === 0,
                    runId: outcome.runId,
                    resultPath: outcome.resultPath,
                    message: outcome.message,
                    report: outcome.report
                }));
            else
                log(outcome.message);
            if (outcome.resultPath)
                out(`RESULT ${outcome.resultPath}`);
            return outcome.exitCode;
        }
        if (sub === 'approve') {
            // Asking on the board uses this machine's own runner connection; with one connection --server and --org may be left out
            const only = listConnections();
            const board = () => {
                const s = flag('--server') ??
                    process.env.AFB_SERVER ??
                    (only.length === 1 ? only[0]?.server : undefined);
                const o = flag('--org') ?? (only.length === 1 ? only[0]?.org : undefined);
                if (!s || !o || !ORG_SLUG.test(o))
                    throw new Error('Say which board: --server <url> --org <slug> (or connect this machine to one board only).');
                const token = loadRunnerToken(ctx.store, s.replace(/\/$/, ''), o);
                if (!token)
                    throw new Error(`This machine is not connected to ${o} on ${s}. Run: agent-flow-board check connect --server ${s} --org ${o} --json`);
                return new RunnerBoard(s, token, ctx.fetch);
            };
            // Ctrl-C or a kill withdraws the request, so no card is left on the board for an agent that is gone
            const ac = new AbortController();
            const stop = () => ac.abort();
            process.once('SIGINT', stop);
            process.once('SIGTERM', stop);
            try {
                return await approveCommand(args.slice(1), {
                    log,
                    out,
                    json,
                    board,
                    org: flag('--org') ?? (only.length === 1 ? only[0]?.org : undefined),
                    signal: ac.signal
                });
            }
            finally {
                process.off('SIGINT', stop);
                process.off('SIGTERM', stop);
            }
        }
        if (sub === 'roots')
            return await rootsCommand(args.slice(1), { log, out, json });
        if (sub === 'login') {
            const only = listConnections();
            const board = () => {
                const s = flag('--server') ??
                    process.env.AFB_SERVER ??
                    (only.length === 1 ? only[0]?.server : undefined);
                const o = flag('--org') ?? (only.length === 1 ? only[0]?.org : undefined);
                if (!s || !o || !ORG_SLUG.test(o))
                    throw new Error('Say which board: --server <url> --org <slug>.');
                const token = loadRunnerToken(ctx.store, s.replace(/\/$/, ''), o);
                if (!token)
                    throw new Error('This machine is not connected to that board. Run: agent-flow-board check connect --server ' +
                        s +
                        ' --org ' +
                        o +
                        ' --json');
                return new RunnerBoard(s, token, ctx.fetch);
            };
            return await loginCommand(args.slice(1), { log, out, json, board });
        }
        if (sub === 'service')
            return await serviceCommand(args.slice(1), { log, out, json });
        if (sub === 'secrets')
            return await secretsCommand(args.slice(1), { log, out, json });
        if (sub === 'import-legacy')
            return await importLegacyCommand(args.slice(1), { log, out, json });
        if (sub === 'clear')
            return await clearCommand(args.slice(1), { log, out, json, store: ctx.store });
        if (sub === 'status' || sub === 'doctor')
            return await healthCommand(args, { log, out, json, store: ctx.store });
        if (sub === 'bind') {
            const o = org();
            const project = need('--project');
            const dir = resolve(flag('--dir') ?? process.cwd());
            const cfg = resolveProjectConfig(dir);
            bindFolder(o, project, cfg.repo, pinFiles(cfg.repo));
            log(`Bound ${o}/${project} to ${cfg.repo}.`);
            return 0;
        }
        if (sub === 'rerun-on-change') {
            const watchPathArg = args[1];
            if (!watchPathArg || watchPathArg.startsWith('--'))
                throw new Error('Usage: agent-flow-board check rerun-on-change <PATH> --check <KEY> --item <ITEM> --org <slug> [--registration NAME] [--profile NAME]');
            const checkKey = need('--check');
            const itemRef = need('--item');
            const o = org();
            const registrationName = flag('--registration');
            const profileName = flag('--profile');
            const rawDebounce = flag('--debounce-ms');
            const debounceMs = rawDebounce !== undefined ? Number(rawDebounce) : undefined;
            if (debounceMs !== undefined && (!Number.isFinite(debounceMs) || debounceMs < 0))
                throw new Error('--debounce-ms takes a non-negative number.');
            const ac = new AbortController();
            const stop = () => ac.abort();
            process.once('SIGINT', stop);
            process.once('SIGTERM', stop);
            try {
                const summary = await rerunOnChange({
                    watchPath: watchPathArg,
                    checkKey,
                    item: itemRef,
                    org: o,
                    registration: registrationName,
                    profile: profileName,
                    debounceMs,
                    signal: ac.signal,
                    log,
                    runCheck: async ({ runNumber }) => {
                        const t0 = Date.now();
                        const outcome = await runCheck({
                            mode: 'local',
                            server: '',
                            org: o,
                            item: itemRef,
                            key: checkKey,
                            dir: resolve(flag('--dir') ?? process.cwd()),
                            registration: registrationName,
                            profile: profileName,
                            runnerToken: '',
                            personalToken: null,
                            fetch: ctx.fetch,
                            log,
                            headed: has('--headed')
                        });
                        const elapsedMs = Date.now() - t0;
                        log(`[${runNumber === 1 ? 'cold' : 'warm'}] ${itemRef} ${checkKey} finished in ${elapsedMs}ms (${outcome.message})`);
                        return outcome.exitCode;
                    }
                });
                if (json)
                    out(JSON.stringify({ ok: true, ...summary }));
                return 0;
            }
            finally {
                process.off('SIGINT', stop);
                process.off('SIGTERM', stop);
            }
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
                // Without --parallel the slots come from the machine (CPUs and free memory); a value that is not a whole number above 0 is refused, never turned into 3
                parallel: parallelFlag(flag('--parallel')),
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
        log(CHECK_USAGE);
        return 2;
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const boardCode = e && typeof e === 'object' && 'code' in e && typeof e.code === 'string' ? e.code : undefined;
        const boardDetails = e && typeof e === 'object' && 'details' in e && e.details && typeof e.details === 'object'
            ? e.details
            : undefined;
        const nextCommand = boardDetails && typeof boardDetails.nextCommand === 'string'
            ? boardDetails.nextCommand
            : undefined;
        if (json) {
            out(JSON.stringify({
                ok: false,
                event: 'error',
                ...(boardCode ? { code: boardCode } : {}),
                error: message,
                ...(boardDetails ? { details: boardDetails } : {})
            }));
        }
        else {
            log(boardCode ? `${boardCode} - ${message}` : message);
            if (nextCommand)
                log(`Next - ${nextCommand}`);
        }
        return 2;
    }
}
