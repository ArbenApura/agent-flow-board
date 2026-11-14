#!/usr/bin/env node
// agent-flow-board mcp --server <url> [--org <slug>]   forward MCP over stdio to the server (to /mcp/<slug> with --org)
// agent-flow-board login --server <url> [--org <slug>] sign in by device code
// agent-flow-board login --json --server <url> --org <slug>   for an agent: line 1 holds userCode and verifier, it approves through MCP
// agent-flow-board setup --org <slug> --server <url> [--dir <repo>] [--shared]   write the Claude hooks into the repo's .claude/settings.local.json
// agent-flow-board logout --server <url> [--org <slug>]
// agent-flow-board queue list | retry <id> | drop <id>
// agent-flow-board hook claude|antigravity|gemini [event]   one hook event from stdin, one JSON object to stdout
// agent-flow-board hooks print claude|antigravity|gemini [--org <slug>]   the settings to paste into the tool
// agent-flow-board git-hook install|uninstall|check          the warn-only post-commit hook
// agent-flow-board check connect|run|pull|bind|watch|status|doctor|clear|setup|disconnect   browser checks on this machine (see check usage)
// agent-flow-board mockup push <file.html> --server <url> --org <slug> --item <ref>   upload one mockup file (never queued)
// agent-flow-board mockup kit <file.html> --server <url> --org <slug> --project <key>   upload the project's kit (its built stylesheet and fonts)
// agent-flow-board mockup pull <mockup id> --out <file.html> --server <url> --org <slug>   save a mockup's HTML to one new file outside any repo
// agent-flow-board mockup url <mockup id> --server <url> --org <slug> [--version <n>] [--screenshot] [--ttl <sec>]   mint a short-lived signed mockup address
// agent-flow-board mockup inspect <mockup id>[@version] --server <url> --org <slug> [--screen S] [--state T] [--width W] [--height H]   inspect rendered DOM box/styles/text
// -- DEP-MODULES -- //
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBridge } from './bridge.js';
import { ADAPTERS, runHook } from './hooks/adapters.js';
import { callHook } from './hooks/call.js';
import { checkCommit, installGitHook, lastCommitMessage, uninstallGitHook } from './hooks/gitHook.js';
import { hookSettings } from './hooks/settings.js';
import { runSetup } from './hooks/setup.js';
import { applyStatusFile } from './hooks/statusFile.js';
import { deviceLogin } from './device.js';
import { listParts, pullParts, pushBundle, pushShell } from './bundle.js';
import { mintMockupUrlCli, pullMockup, pushKit, pushMockup } from './mockup.js';
import { Queue } from './queue.js';
import { captureRenders, DEFAULT_RENDER_WIDTHS, screensOfPage } from './renders.js';
import { accountKey, configDir, pickStore } from './tokenStore.js';
// -- FUNCTIONS -- //
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const cmd = args[0];
const log = (s) => process.stderr.write(s + '\n');
function serverUrl() {
    const s = flag('--server') ?? process.env.AFB_SERVER;
    if (!s) {
        log('Say which server to use: --server https://board.example.com (or set AFB_SERVER).');
        process.exit(2);
    }
    return s.replace(/\/$/, '');
}
/** An organisation slug as the app writes it. Anything else is ignored by a hook and refused by the other commands. */
const ORG_SLUG = /^[a-z0-9][a-z0-9-]{1,38}$/;
/** The organisation this run is for (--org), or undefined for the plain server sign in as before. */
function orgFlag(strict = true) {
    const o = flag('--org');
    if (o === undefined)
        return undefined;
    if (ORG_SLUG.test(o))
        return o;
    if (strict) {
        log('--org takes an organisation slug: lowercase letters, digits and dashes.');
        process.exit(2);
    }
    return undefined;
}
const store = pickStore();
/**
 * The saved sign in for a server and organisation. Only the MCP bridge (legacy true) also tries an older sign in saved under the plain
 * host, because /mcp/<slug> answers 403 if it is the wrong organisation. Hooks have no such check, so they never borrow it.
 */
const tokenFor = (server, org, legacy = false) => process.env.AFB_TOKEN ??
    store.get(accountKey(server, org)) ??
    (org && legacy ? store.get(accountKey(server)) : null);
const queue = new Queue(join(configDir(), 'queue.json'));
const fetchImpl = (input, init) => fetch(input, init);
async function readStdin() {
    const chunks = [];
    for await (const c of process.stdin)
        chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8').trim();
    try {
        return text ? JSON.parse(text) : {};
    }
    catch {
        return {};
    }
}
/** Asks the organisation's own address whether this sign in belongs to it. Only a 403 means another organisation. */
async function belongsToOrg(server, org, token) {
    try {
        const res = await fetchImpl(`${server}/mcp/${org}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
        });
        // Only a refusal means another organisation, or no valid sign in
        return res.status !== 403 && res.status !== 401;
    }
    catch {
        // The board cannot be reached right now: keep the sign in, the first call checks again
        return true;
    }
}
async function main() {
    if (cmd === 'check') {
        // Loaded only here, so the hooks and the MCP forwarder never load the check code or Playwright
        const { checkMain } = await import('./checks/command.js');
        const code = await checkMain({
            args: args.slice(1),
            store,
            fetch: fetchImpl,
            personalToken: (server, org) => tokenFor(server.replace(/\/$/, ''), org, true),
            log,
            out: (line) => process.stdout.write(line + '\n')
        });
        // A browser or a preview may still hold a handle open: the exit code is what the caller reads, so end now
        process.exitCode = code;
        setTimeout(() => process.exit(code), 300).unref();
        return;
    }
    if (cmd === 'hook') {
        // A hook prints exactly one JSON object and always exits 0, so it can never break the tool that runs it
        let out = {};
        try {
            const adapter = ADAPTERS[args[1] ?? ''];
            const server = (flag('--server') ?? process.env.AFB_SERVER ?? '').replace(/\/$/, '');
            if (adapter && server) {
                const token = tokenFor(server, orgFlag(false));
                out = await runHook(adapter, args[2] ?? '', await readStdin(), async (event) => {
                    const asked = Date.now();
                    const answer = await callHook({ server, token, fetch: fetchImpl }, event);
                    // The status goes to this conversation's file, never to the tool. A failed write never fails the hook.
                    applyStatusFile(join(configDir(), 'status'), event, answer, asked);
                    return answer;
                });
            }
        }
        catch {
            out = {};
        }
        process.stdout.write(JSON.stringify(out));
        return;
    }
    if (cmd === 'hooks' && args[1] === 'print') {
        const text = hookSettings(args[2] ?? '', serverUrl());
        if (!text) {
            log('Say which tool: claude, antigravity or gemini.');
            process.exit(2);
        }
        process.stdout.write(text + '\n');
        return;
    }
    if (cmd === 'git-hook') {
        const repo = flag('--dir') ?? process.cwd();
        if (args[1] === 'install') {
            const r = installGitHook(repo);
            log(r.created ? `Installed ${r.path}.` : `Already installed in ${r.path}.`);
        }
        else if (args[1] === 'uninstall') {
            log(uninstallGitHook(repo) ? 'Removed.' : 'Nothing to remove.');
        }
        else if (args[1] === 'check') {
            // Warn only: print the warning to the terminal and never fail the commit
            const warning = checkCommit(lastCommitMessage(repo));
            if (warning)
                log(warning);
        }
        else {
            log('Usage: agent-flow-board git-hook install|uninstall|check [--dir <repo>]');
            process.exit(2);
        }
        return;
    }
    if (cmd === 'mockup') {
        // One upload over /api/v1 with this machine's own sign in. It is never queued, so a failure is said out loud and run again
        if (!['push', 'kit', 'pull', 'url', 'inspect', 'bundle', 'shell', 'parts'].includes(args[1] ?? '') ||
            !args[2] ||
            args[2].startsWith('--')) {
            log('Usage: agent-flow-board mockup push <file.html> --server <url> --org <slug> (--item <ref> | --project <key> | --mockup <id>) [--another] [--title <text>] [--keep <text> | --keep-file <path>] [--free <text> | --free-file <path>] [--screenshot <file.png>] [--tailwind-entry <app.css> [--project-root <dir>] | --style-file <built.css>] [--renders [--widths 408,820,1280,1600] [--render-states a,b]]\n       agent-flow-board mockup bundle <dir with mockup.json> --server <url> --org <slug> (--item <ref> | --project <key> | --mockup <id>) [the same options as push]\n       agent-flow-board mockup shell <file.html> --server <url> --org <slug> --project <key>\n       agent-flow-board mockup parts <mockup id> --server <url> --org <slug> [--version <n>]\n       agent-flow-board mockup pull <mockup id> --parts <new folder> --server <url> --org <slug> [--version <n>]\n       agent-flow-board mockup kit <file.html> --server <url> --org <slug> --project <key> [--commit <hash>] [--summary <text>]\n       agent-flow-board mockup pull <mockup id> --out <file.html> --server <url> --org <slug> [--version <n>] [--session <id>]\n       agent-flow-board mockup url <mockup id> --server <url> --org <slug> [--version <n>] [--screenshot] [--ttl <seconds>]\n       agent-flow-board mockup inspect <mockup id>[@version] --server <url> --org <slug> [--screen S] [--state T] [--width W] [--height H]');
            process.exit(2);
        }
        const server = serverUrl();
        const org = orgFlag();
        if (!org) {
            log('Say which organisation: --org <slug>.');
            process.exit(2);
        }
        if (args[1] === 'inspect') {
            const version = flag('--version');
            if (version !== undefined && !/^[1-9][0-9]*$/.test(version)) {
                log('The --version must be a whole number of 1 or more.');
                process.exit(2);
            }
            const widthRaw = flag('--width');
            const heightRaw = flag('--height');
            const width = widthRaw !== undefined ? Number(widthRaw) : undefined;
            const height = heightRaw !== undefined ? Number(heightRaw) : undefined;
            if (width !== undefined && (!Number.isInteger(width) || width < 240 || width > 3840)) {
                log('The --width must be a whole number between 240 and 3840.');
                process.exit(2);
            }
            if (height !== undefined && (!Number.isInteger(height) || height < 240 || height > 3840)) {
                log('The --height must be a whole number between 240 and 3840.');
                process.exit(2);
            }
            const token = tokenFor(server, org, true);
            if (!token) {
                log(`Not signed in to ${org} on ${server}. Run: agent-flow-board login --json --server ${server} --org ${org}`);
                process.exit(1);
            }
            const { inspectMockupCli } = await import('./checks/inspect.js');
            const dump = await inspectMockupCli({
                server,
                org,
                token,
                mockup: args[2],
                version: version ? Number(version) : undefined,
                screen: flag('--screen'),
                state: flag('--state'),
                width,
                height,
                fetch: fetchImpl,
                log
            });
            process.stdout.write(JSON.stringify(dump) + '\n');
            return;
        }
        if (args[1] === 'url') {
            const version = flag('--version');
            if (version !== undefined && !/^[1-9][0-9]*$/.test(version)) {
                log('The --version must be a whole number of 1 or more.');
                process.exit(2);
            }
            const ttl = flag('--ttl');
            if (ttl !== undefined && !/^[1-9][0-9]*$/.test(ttl)) {
                log('The --ttl must be a whole number of seconds between 1 and 300.');
                process.exit(2);
            }
            const minted = await mintMockupUrlCli({
                server,
                org,
                token: tokenFor(server, org, true) ?? '',
                fetch: fetchImpl,
                mockup: args[2],
                version: version ? Number(version) : undefined,
                screenshot: args.includes('--screenshot'),
                ttlSeconds: ttl ? Number(ttl) : undefined
            });
            process.stdout.write(JSON.stringify(minted) + '\n');
            return;
        }
        if (args[1] === 'bundle' || args[1] === 'shell' || args[1] === 'parts') {
            // A mockup made of parts, the project shell, and the list of a version's parts (AFB-20261114-0409)
            const token = tokenFor(server, org, true) ?? '';
            if (args[1] === 'shell') {
                const project = flag('--project');
                if (!project) {
                    log('Say which project: --project <key>.');
                    process.exit(2);
                }
                process.stdout.write(JSON.stringify(await pushShell({ server, org, token, fetch: fetchImpl, file: args[2], project, log })) + '\n');
                return;
            }
            if (args[1] === 'parts') {
                const version = flag('--version');
                process.stdout.write(JSON.stringify(await listParts({
                    server,
                    org,
                    token,
                    fetch: fetchImpl,
                    mockup: args[2],
                    version: version ? Number(version) : undefined
                })) + '\n');
                return;
            }
            const widths = (flag('--widths') ?? '')
                .split(',')
                .map((w) => Number.parseInt(w, 10))
                .filter((w) => Number.isInteger(w) && w >= 200 && w <= 4000);
            const pushed = await pushBundle({
                server,
                org,
                token,
                fetch: fetchImpl,
                dir: args[2],
                item: flag('--item'),
                project: flag('--project'),
                mockup: flag('--mockup'),
                another: args.includes('--another'),
                title: flag('--title'),
                keepNotes: flag('--keep-file')
                    ? readFileSync(flag('--keep-file'), 'utf8')
                    : flag('--keep'),
                freeNotes: flag('--free-file')
                    ? readFileSync(flag('--free-file'), 'utf8')
                    : flag('--free'),
                screenshot: flag('--screenshot'),
                tailwindEntry: flag('--tailwind-entry'),
                projectRoot: flag('--project-root'),
                styleFile: flag('--style-file'),
                log
            });
            let renders;
            if (args.includes('--renders')) {
                const { readBundle } = await import('./bundle.js');
                const marked = readBundle(args[2]).parts.filter((p) => p.kind === 'head' || p.kind === 'skeleton');
                renders = await captureRenders({
                    server,
                    org,
                    token,
                    fetch: fetchImpl,
                    mockup: pushed.mockupId,
                    version: pushed.version,
                    screens: marked.flatMap((p) => screensOfPage(p.content)).slice(0, 12),
                    widths: widths.length ? widths : DEFAULT_RENDER_WIDTHS,
                    states: (flag('--render-states') ?? '').split(',').filter(Boolean),
                    log
                });
            }
            process.stdout.write(JSON.stringify(renders ? { ...pushed, renders } : pushed) + '\n');
            return;
        }
        if (args[1] === 'pull' && flag('--parts')) {
            const version = flag('--version');
            const pulled = await pullParts({
                server,
                org,
                token: tokenFor(server, org, true) ?? '',
                fetch: fetchImpl,
                mockup: args[2],
                out: flag('--parts'),
                version: version ? Number(version) : undefined,
                log
            });
            process.stdout.write(JSON.stringify(pulled) + '\n');
            return;
        }
        if (args[1] === 'pull') {
            // The HTML of a mockup, read to the end and saved to one new file outside any repo (AFB-20261111-0017)
            const out = flag('--out');
            if (!out) {
                log('Say where to save it: --out <file.html>, in a temporary folder outside the repo.');
                process.exit(2);
            }
            const version = flag('--version');
            if (version !== undefined && !/^[1-9][0-9]*$/.test(version)) {
                log('The --version must be a whole number of 1 or more.');
                process.exit(2);
            }
            const session = flag('--session');
            if (args.includes('--session') && (!session || session.startsWith('--'))) {
                log('Give the session id after --session.');
                process.exit(2);
            }
            const pulled = await pullMockup({
                server,
                org,
                token: tokenFor(server, org, true) ?? '',
                fetch: fetchImpl,
                mockup: args[2],
                out,
                version: version ? Number(version) : undefined,
                session,
                log
            });
            process.stdout.write(JSON.stringify(pulled) + '\n');
            return;
        }
        if (args[1] === 'kit') {
            const project = flag('--project');
            if (!project) {
                log('Say which project: --project <key>.');
                process.exit(2);
            }
            const kit = await pushKit({
                server,
                org,
                token: tokenFor(server, org, true) ?? '',
                fetch: fetchImpl,
                file: args[2],
                project,
                commit: flag('--commit'),
                summary: flag('--summary'),
                log
            });
            process.stdout.write(JSON.stringify(kit) + '\n');
            return;
        }
        const text = (inline, file) => {
            const path = flag(file);
            return path ? readFileSync(path, 'utf8') : flag(inline);
        };
        const result = await pushMockup({
            server,
            org,
            token: tokenFor(server, org, true) ?? '',
            fetch: fetchImpl,
            file: args[2],
            item: flag('--item'),
            project: flag('--project'),
            mockup: flag('--mockup'),
            another: args.includes('--another'),
            title: flag('--title'),
            keepNotes: text('--keep', '--keep-file'),
            freeNotes: text('--free', '--free-file'),
            screenshot: flag('--screenshot'),
            tailwindEntry: flag('--tailwind-entry'),
            projectRoot: flag('--project-root'),
            styleFile: flag('--style-file'),
            log
        });
        let renders;
        if (args.includes('--renders')) {
            // What a browser sees of every screen at every width is saved with the version (AFB-20261114-0409)
            const widths = (flag('--widths') ?? '')
                .split(',')
                .map((w) => Number.parseInt(w, 10))
                .filter((w) => Number.isInteger(w) && w >= 200 && w <= 4000);
            renders = await captureRenders({
                server,
                org,
                token: tokenFor(server, org, true) ?? '',
                fetch: fetchImpl,
                mockup: result.mockupId,
                version: result.version,
                screens: screensOfPage(readFileSync(args[2], 'utf8')),
                widths: widths.length ? widths : DEFAULT_RENDER_WIDTHS,
                states: (flag('--render-states') ?? '').split(',').filter(Boolean),
                log
            });
        }
        process.stdout.write(JSON.stringify(renders ? { ...result, renders } : result) + '\n');
        return;
    }
    if (cmd === 'queue') {
        const sub = args[1];
        if (sub === 'retry' && args[2])
            log(queue.retry(args[2]) ? 'Queued again.' : 'No such queued write.');
        else if (sub === 'drop' && args[2])
            log(queue.drop(args[2]) ? 'Dropped.' : 'No such queued write.');
        else
            for (const e of queue.list())
                log(`${e.id}  ${e.state.padEnd(6)}  ${e.name}  ${e.key}${e.reason ? `  held: ${e.reason}` : ''}`);
        return;
    }
    if (cmd === 'logout') {
        const server = serverUrl();
        const org = orgFlag();
        store.delete(accountKey(server, org));
        // An older sign in under the plain host may be what this organisation was using, so it goes too
        if (org)
            store.delete(accountKey(server));
        log('Signed out.');
        return;
    }
    if (cmd === 'setup') {
        const server = serverUrl();
        const org = orgFlag();
        if (!org) {
            log('setup needs --org <slug>: the organisation the hooks send to.');
            process.exit(2);
        }
        const token = tokenFor(server, org);
        if (!token) {
            log(`Not signed in to ${org} on ${server}. Run: agent-flow-board login --json --server ${server} --org ${org}`);
            process.exit(1);
        }
        if (!(await belongsToOrg(server, org, token))) {
            log(`The saved sign in is not for ${org}. Run the login for ${org} again.`);
            process.exit(1);
        }
        const result = runSetup({
            repo: flag('--dir') ?? process.cwd(),
            server,
            org,
            shared: args.includes('--shared'),
            configDir: configDir()
        });
        process.stdout.write(JSON.stringify(result) + '\n');
        if (!result.ok) {
            log(`Setup failed: ${result.error}`);
            process.exit(1);
        }
        log(result.changed
            ? `Wrote ${result.file}: ${result.added} hook(s) added, ${result.replaced} replaced, ${result.kept} other hook(s) kept.${result.backup ? ` The old file is backed up at ${result.backup}.` : ''}`
            : `${result.file} already has these hooks. Nothing was changed.`);
        return;
    }
    if (cmd !== 'mcp' && cmd !== 'login') {
        log('Usage: agent-flow-board mcp|login|logout --server <url>, setup --org <slug>, queue list|retry <id>|drop <id>, mockup push <file.html>, or check connect|run|watch|status');
        process.exit(2);
    }
    const server = serverUrl();
    const org = orgFlag();
    const account = accountKey(server, org);
    // login --json is for an agent: the first line on stdout holds the code and the verifier it needs to approve the sign in through MCP
    const asJson = cmd === 'login' && args.includes('--json');
    if (asJson && !org) {
        log('login --json needs --org <slug>: the agent approves the sign in for that organisation.');
        process.exit(2);
    }
    const login = async () => {
        const r = await deviceLogin(server, fetchImpl, log, asJson
            ? {
                pkce: true,
                onCode: (c) => process.stdout.write(JSON.stringify(c) + '\n')
            }
            : {});
        // The device approval lets the person choose the organisation, so it is checked against the one asked for before it is kept
        if (org && !(await belongsToOrg(server, org, r.token))) {
            throw new Error(`That sign in is for a different organisation than ${org}. It was not saved. Run the sign in again and choose ${org} when the approval page asks.`);
        }
        store.set(account, r.token);
        log('Signed in.');
        return r.token;
    };
    if (cmd === 'login') {
        await login();
        // The second line says it worked, with no token
        if (asJson)
            process.stdout.write(JSON.stringify({ signedIn: true, server, org }) + '\n');
        return;
    }
    await runBridge({
        server,
        org,
        fetch: fetchImpl,
        getToken: () => tokenFor(server, org, true),
        login,
        queue,
        stdin: process.stdin,
        stdout: process.stdout,
        log
    });
    // A background sign in may still be polling when the tool closes the bridge, and it must not keep this process alive
    setTimeout(() => process.exit(0), 500).unref();
}
main().catch((e) => {
    log(String(e instanceof Error ? e.message : e));
    process.exit(1);
});
