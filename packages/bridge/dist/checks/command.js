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
import { forgetConnection, recordConnection } from './connections.js';
import { ORG_SLUG, scriptPath, scriptsDir } from './paths.js';
import { pinFiles, resolveProjectConfig } from './recipe.js';
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
    '  run ... also takes [--registration NAME] [--file <script inside the scripts folder>] [--headed]',
    '  project <NAME> --org <slug> (--repo <dir> [--app-dir web] [--board-project KEY] [--recipe] | --url <address> [--extra-hosts a,b]) [--adopt-env --adopt-env-approval <code>] [--upload-pictures --pictures-approval <code>] [--approval <code>] | project list|forget|pin',
    '  approve --action <roots|register|secrets|adopt-env|pictures> --target <name>   (the owner, on a terminal)  |  roots add|list|remove <dir> [--approval <code>]',
    '  secrets import|list|forget --org <slug> --project <NAME> [--from <file> --keys A,B --test-ref <ref> --test-inbox <email> --owner-said "<sentence>" --allow-service-role --approval <code>]',
    '  login <NAME> --org <slug> --seeded  |  service install|uninstall|status [--no-start]  |  import-legacy --from <afb-checks folder> --org <slug> [--dry-run]',
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
            let item = args[1];
            let key = args[2];
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
            const s = server();
            const o = org();
            // The folder of a script names its organisation: a script of one organisation is never run as another's
            if (fileOrg !== null && fileOrg !== o)
                throw new Error(`--file is a script of the organisation ${fileOrg.slice(0, 40)}, but --org says ${o}. Use the same organisation in both.`);
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
                registration: flag('--registration'),
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
        // The registration, approval, sign in and service commands live in their own modules; each takes the arguments after its word
        if (sub === 'project')
            return await projectCommand(args.slice(1), { log, out, json });
        if (sub === 'approve')
            return await approveCommand(args.slice(1), { log, out, json });
        if (sub === 'roots')
            return await rootsCommand(args.slice(1), { log, out, json });
        if (sub === 'login')
            return await loginCommand(args.slice(1), { log, out, json });
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
        if (json)
            out(JSON.stringify({ ok: false, event: 'error', error: message }));
        else
            log(message);
        return 2;
    }
}
