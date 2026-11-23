// THE BROWSER OF A CHECK: ONE CHROMIUM SERVER STARTED BY THE PARENT, WHICH THE SANDBOXED CHILD ONLY CONNECTS TO.
// Playwright is not a dependency of the bridge (it is large and most people never run a check). It is found next to the bridge when it is there,
// and otherwise installed once into ~/.agent-flow-board/checks/runtime. Nothing in this file imports Playwright at load time.
// IMPORTED DEP-MODULES
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
// IMPORTED MODULES
import { acquireLock } from './lock.js';
import { checksHome, ensureDir } from './paths.js';
// -- CONSTANTS -- //
/** The Playwright version the runtime install pins, so a check behaves the same on every machine. */
export const PLAYWRIGHT_VERSION = '1.64.0';
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** Written when the runtime and the Chromium download both finished. Only this note says the install is whole (a download that was cut leaves files behind). */
const COMPLETE_NOTE = '.complete';
/** One machine installs once: the lock outlives the longest install, and a waiter gives up after a little longer than that. */
const INSTALL_LOCK_STALE_MS = 2 * INSTALL_TIMEOUT_MS + 60_000;
const INSTALL_LOCK_WAIT_MS = 2 * INSTALL_TIMEOUT_MS + 120_000;
// -- FUNCTIONS -- //
/** Where the runtime install lives. It is a folder of the bridge's own state, never a repo. */
const runtimeDir = () => join(checksHome(), 'runtime');
/**
 * Where the browsers live: a folder of the bridge's own, so a project's own `npx playwright install` (which fills the shared Playwright cache, often with another browser
 * version) is never mistaken for ours, and ours is never removed by theirs.
 */
export const browsersDir = () => join(checksHome(), 'browsers');
/**
 * The folder the browsers are looked for and installed in: the bridge's own, unless the person set PLAYWRIGHT_BROWSERS_PATH themselves (on purpose, for example in a CI image
 * or a test run), which is then respected and shown in the doctor line.
 */
export const activeBrowsersDir = () => process.env.PLAYWRIGHT_BROWSERS_PATH || browsersDir();
/** Points Playwright at the bridge's own browsers folder. Playwright reads this variable when it is loaded and when its installer runs, so it is set before both. */
function useOwnBrowsers() {
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH)
        process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir();
}
/** What a person is told before the browser is downloaded: the size, where it comes from and where it goes. */
export const downloadNote = () => `The browser download is about 320 MB (Chromium about 200 MB plus its headless shell about 120 MB) from Playwright's download servers, and it is kept in ${activeBrowsersDir()}.`;
/**
 * The one yes for the whole browser download. The bridge never reads a terminal (an agent runs it, and the owner is never handed a command), so the yes is the flag `--yes`;
 * without it nothing is downloaded. The size and the source are said first, so the yes is an informed one.
 */
export function confirmBrowserDownload(yes, log) {
    log(downloadNote());
    return Boolean(yes);
}
/**
 * Clears the bridge's own browser install (its browsers folder and its note) so the next install starts from nothing. Only the bridge's own folder: when the person
 * pointed PLAYWRIGHT_BROWSERS_PATH somewhere else on purpose, that folder is never touched.
 */
export function resetOwnBrowserInstall() {
    rmSync(join(runtimeDir(), COMPLETE_NOTE), { force: true });
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH ||
        process.env.PLAYWRIGHT_BROWSERS_PATH === browsersDir())
        removeOwnFolder('browsers');
}
/**
 * Removes one of the bridge's own two folders (runtime or browsers) and nothing else. The real path of the folder must sit inside the checks home, so a link or a
 * path taken from the environment never makes this delete a shared Playwright cache or another project's files.
 */
export function removeOwnFolder(name) {
    const target = name === 'runtime' ? runtimeDir() : browsersDir();
    if (!existsSync(target))
        return false;
    let home;
    let real;
    try {
        home = realpathSync(checksHome());
        real = realpathSync(target);
    }
    catch {
        return false;
    }
    if (real !== join(home, name) || !real.startsWith(home + sep))
        return false;
    try {
        // Windows can hold a file for a moment (a browser of an older bridge, a scan by a security program): a few tries, then a plain sentence
        rmSync(real, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    catch (e) {
        throw new Error(`The old ${name} folder of the bridge could not be removed (${e.code ?? 'in use'}). Close any mockup render that is running, then try again.`, { cause: e });
    }
    return true;
}
const looksInstalled = (nodeModules) => existsSync(join(nodeModules, 'playwright-core', 'package.json'));
/** The version of the playwright-core in a node_modules folder, or '' when it cannot be read. */
function versionIn(nodeModules) {
    try {
        const v = JSON.parse(readFileSync(join(nodeModules, 'playwright-core', 'package.json'), 'utf8'));
        return v && typeof v === 'object' ? String(v.version ?? '') : '';
    }
    catch {
        return '';
    }
}
/**
 * Which of two Playwright folders to use. The one next to the bridge is used when it is the pinned version; when it is another version and the runtime
 * install holds the pinned one, the runtime copy wins (the browser pool relies on the isolation of that exact version). With neither pinned, the one next to
 * the bridge is returned (assertPlaywrightVersion then says what is wrong), else the runtime copy, else null.
 */
export function choosePlaywrightDir(beside, runtime, versionOf = versionIn) {
    if (beside && versionOf(beside) === PLAYWRIGHT_VERSION)
        return beside;
    if (runtime && versionOf(runtime) === PLAYWRIGHT_VERSION)
        return runtime;
    return beside ?? runtime;
}
/**
 * The node_modules folder that holds playwright-core (and @playwright/test when it is there): next to the bridge first (when it is the pinned version),
 * then the runtime install. The sandboxed child is allowed to read this folder and nothing else outside its own. Null when Playwright is not installed anywhere.
 */
export function playwrightRuntimeDir() {
    let beside = null;
    try {
        const pkg = createRequire(import.meta.url).resolve('playwright-core/package.json');
        // .../node_modules/playwright-core/package.json -> .../node_modules
        beside = dirname(dirname(pkg));
    }
    catch {
        /* Not next to the bridge: try the runtime install */
    }
    const own = join(runtimeDir(), 'node_modules');
    return choosePlaywrightDir(beside, looksInstalled(own) ? own : null);
}
/** The folders whose playwright-core version was already compared with the pin. */
const versionChecked = new Set();
/**
 * Throws when the playwright-core in `dir` is not the pinned version. The browser pool relies on the isolation of that exact version
 * (every connection to a launched server gets contexts of its own), so another version is refused rather than trusted.
 */
export function assertPlaywrightVersion(dir) {
    if (versionChecked.has(dir))
        return;
    let found = '';
    try {
        const v = JSON.parse(readFileSync(join(dir, 'playwright-core', 'package.json'), 'utf8'));
        found = v && typeof v === 'object' ? String(v.version ?? '') : '';
    }
    catch {
        /* Unreadable: reported below */
    }
    if (found !== PLAYWRIGHT_VERSION)
        throw new Error(`The mockup renders need Playwright ${PLAYWRIGHT_VERSION} but found ${found || 'no readable version'} in ${dir}. Delete that folder and render again: the bridge installs it once.`);
    versionChecked.add(dir);
}
/** Loads playwright-core from the folder playwrightRuntimeDir names, by absolute path. */
export async function loadPlaywright() {
    const dir = playwrightRuntimeDir();
    if (!dir)
        throw new Error('Playwright is not installed yet. Render a mockup again and the bridge will install it once.');
    assertPlaywrightVersion(dir);
    useOwnBrowsers();
    const req = createRequire(join(dir, 'package.json'));
    return req(join(dir, 'playwright-core'));
}
/**
 * Starts the browser once and closes it again, so "installed" means "starts" and not "a file is there". Never longer than `timeoutMs`: a browser that hangs
 * (an antivirus, a sandbox failure, missing system libraries) is closed and reported as a problem instead of hanging the caller.
 */
export async function browserLaunches(timeoutMs = 20_000) {
    let browser = null;
    let timer;
    try {
        const { chromium } = await loadPlaywright();
        const launch = chromium.launch({ headless: true, timeout: timeoutMs });
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                // A launch that finishes after the limit is closed again, so no browser is left running
                void launch.then((b) => b.close()).catch(() => undefined);
                reject(new Error(`it did not start within ${Math.round(timeoutMs / 1000)} seconds`));
            }, timeoutMs + 2_000);
        });
        browser = await Promise.race([launch, timeout]);
        return { ok: true, detail: 'it starts' };
    }
    catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        const libs = /error while loading shared libraries|missing dependencies|install-deps/i.test(text);
        return {
            ok: false,
            detail: libs
                ? 'it cannot start because this computer is missing system libraries (Linux: run "npx playwright install-deps chromium" yourself, it needs administrator rights)'
                : `it does not start: ${text.split('\n')[0]?.slice(0, 200) ?? 'unknown error'}`
        };
    }
    finally {
        if (timer)
            clearTimeout(timer);
        await browser?.close().catch(() => undefined);
    }
}
/** What the bridge can say about its browser without starting anything slow. */
export async function browserState() {
    const dir = playwrightRuntimeDir();
    let executable = null;
    if (dir) {
        try {
            executable = (await loadPlaywright()).chromium.executablePath();
        }
        catch {
            executable = null;
        }
    }
    return {
        runtimeVersion: dir ? versionIn(dir) || null : null,
        pinned: PLAYWRIGHT_VERSION,
        executable,
        executableExists: Boolean(executable && existsSync(executable)),
        browsersDir: browsersDir(),
        complete: existsSync(join(runtimeDir(), COMPLETE_NOTE))
    };
}
/** The Chromium rule that makes every host unresolvable except the preview's, localhost and the hosts named. */
export function hostResolverRule(hosts = []) {
    const exclude = [...new Set(['127.0.0.1', 'localhost', ...hosts])]
        .map((h) => `EXCLUDE ${h}`)
        .join(', ');
    return `--host-resolver-rules=MAP * ~NOTFOUND, ${exclude}`;
}
/**
 * A browser the parent starts, so a check's process only connects to it and never has to start a program itself.
 * Every host except the preview's (and the hosts named) is unresolvable, whatever a check does with routes.
 */
export async function launchBrowserServer({ headed = false, hosts = [] } = {}) {
    const { chromium } = await loadPlaywright();
    // Never pass the shared-browser option: without it every connection gets contexts of its own and sees none of another connection's
    const server = await chromium.launchServer({
        headless: !headed,
        args: [hostResolverRule(hosts), '--disable-background-networking', '--no-first-run']
    });
    return {
        wsEndpoint: () => server.wsEndpoint(),
        close: () => server.close(),
        onClose: (callback) => void server.on('close', callback)
    };
}
/** Says whether an installer failure looks like no network or a proxy, so the one-line error can tell the person what to look at. */
export function describeInstallFailure(output) {
    if (/ENOSPC|no space left|not enough space|disk full/i.test(output))
        return 'the disk is full (free some space, the browser takes about 720 MB on disk, so keep about 1 GB free)';
    if (/EACCES|EPERM|EBUSY|permission denied|operation not permitted/i.test(output))
        return 'a file could not be written (a security program may be holding it; check the folder permissions)';
    if (/proxy|407|tunnel|ECONNRESET|self[- ]signed|certificate/i.test(output))
        return 'it looks like a proxy problem (check HTTPS_PROXY and the proxy settings)';
    if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ETIMEDOUT|getaddrinfo|offline|network/i.test(output))
        return 'it looks like this machine is offline';
    return 'see the last lines above';
}
/** Runs a program with the exact arguments (no shell, no stdin) and sends every output line to `log`. Resolves with the exit code and the last output. */
function runLogged(file, args, log, cwd, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(file, args, {
            cwd,
            env,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let tail = '';
        const feed = (chunk) => {
            for (const line of chunk.toString('utf8').split(/\r?\n/)) {
                const t = line.trim();
                if (!t)
                    continue;
                tail = `${tail}\n${t}`.slice(-2000);
                log(t);
            }
        };
        child.stdout.on('data', feed);
        child.stderr.on('data', feed);
        // On Windows child.kill() leaves the downloader's own children running, so the whole tree is ended
        const timer = setTimeout(() => {
            if (process.platform === 'win32' && child.pid)
                spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
                    windowsHide: true,
                    stdio: 'ignore'
                }).on('error', () => child.kill());
            else
                child.kill();
        }, INSTALL_TIMEOUT_MS);
        child.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, tail });
        });
    });
}
/** The npm that belongs to this Node: its npm-cli.js, so no shell is needed. Null when it is not where Node keeps it. */
function npmCli() {
    const root = dirname(process.execPath);
    const candidates = [
        join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(root, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ];
    return candidates.find((c) => existsSync(c)) ?? null;
}
/**
 * Installs Playwright into the runtime folder of the bridge's state.
 * This is the ONE place npm is used: it installs a runtime for the installed bridge into ~/.agent-flow-board, never into a repo,
 * so the Yarn-only rule of the repos does not apply here.
 */
async function installRuntime(log) {
    const dir = ensureDir(runtimeDir());
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest))
        writeFileSync(manifest, JSON.stringify({ private: true }, null, 2));
    log(`Installing Playwright ${PLAYWRIGHT_VERSION} into ${dir} (first use only)...`);
    // @playwright/test brings the expect that checks use; playwright-core is what the parent drives
    const npmArgs = [
        'install',
        '--no-audit',
        '--no-fund',
        '--prefix',
        dir,
        `playwright-core@${PLAYWRIGHT_VERSION}`,
        `@playwright/test@${PLAYWRIGHT_VERSION}`
    ];
    const cli = npmCli();
    const out = await new Promise((resolve) => {
        const done = (error, stdout, stderr) => resolve({ error, text: `${stdout}\n${stderr}` });
        if (cli)
            execFile(process.execPath, [cli, ...npmArgs], { windowsHide: true, timeout: INSTALL_TIMEOUT_MS, shell: false }, (e, so, se) => done(e, so, se));
        else
            execFile('npm', npmArgs, { windowsHide: true, timeout: INSTALL_TIMEOUT_MS, shell: process.platform === 'win32' }, (e, so, se) => done(e, so, se));
    });
    if (out.error || !looksInstalled(join(dir, 'node_modules'))) {
        const last = out.text.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        throw new Error(`Could not install Playwright: ${describeInstallFailure(out.text)}. ${last}`);
    }
}
/** The pinned Playwright folder, or null: the runtime has to be installed (again) when the only copy is another version. */
function pinnedDir() {
    const dir = playwrightRuntimeDir();
    return dir && versionIn(dir) === PLAYWRIGHT_VERSION ? dir : null;
}
async function installChromium(dir, log) {
    log(downloadNote());
    log('Installing the Chromium browser for Playwright (first use only)...');
    const cli = join(dir, 'playwright-core', 'cli.js');
    if (!existsSync(cli))
        throw new Error('Playwright is installed but its installer (cli.js) is missing. Delete the runtime folder under ~/.agent-flow-board/checks and render again to install it again.');
    // The installer puts the browsers in the bridge's own folder, whatever the shell has set
    const { code, tail } = await runLogged(process.execPath, [cli, 'install', 'chromium'], log, undefined, { ...process.env, PLAYWRIGHT_BROWSERS_PATH: activeBrowsersDir() }).catch((e) => ({ code: -1, tail: String(e) }));
    if (code !== 0)
        throw new Error(`Could not install the Chromium browser: ${describeInstallFailure(tail)}. ${tail.split('\n').slice(-2).join(' ').trim().slice(0, 300)}`);
}
const realInstallIo = {
    pinnedDir,
    chromiumPresent: async () => {
        try {
            const { chromium } = await loadPlaywright();
            return existsSync(chromium.executablePath());
        }
        catch {
            return false;
        }
    },
    installRuntime,
    installChromium,
    notePath: () => join(runtimeDir(), COMPLETE_NOTE),
    lockName: 'browser-install',
    pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};
/** Takes the install lock without blocking the event loop. Null when another install kept it for longer than a whole install takes. */
async function takeInstallLock(io, waitMs, staleMs) {
    const until = Date.now() + waitMs;
    for (;;) {
        const lock = acquireLock(io.lockName, { staleMs });
        if (lock)
            return lock;
        if (Date.now() > until)
            return null;
        await io.pause(500);
    }
}
/**
 * Makes sure Playwright and its Chromium are there. The first use installs them (a few hundred megabytes, with progress lines in `log`);
 * later uses return at once. Never prompts. A failure is one Error that says whether it looks like offline or a proxy.
 * Two processes never install at once: a lock covers the runtime install and the Chromium download, and a note (.complete) is written only after both finished, so a
 * download that was cut short is done again instead of being trusted.
 */
export async function ensureBrowser(log = () => { }, io = realInstallIo, limits = {}) {
    const whole = async () => existsSync(io.notePath()) && io.pinnedDir() !== null && (await io.chromiumPresent());
    if (await whole())
        return;
    const lock = await takeInstallLock(io, limits.waitMs ?? INSTALL_LOCK_WAIT_MS, limits.staleMs ?? INSTALL_LOCK_STALE_MS);
    if (!lock)
        throw new Error('Another process has been installing the browser for a long time. Wait for it, then render again.');
    try {
        // Whoever held the lock before may have finished the whole install
        if (await whole())
            return;
        rmSync(io.notePath(), { force: true });
        if (!io.pinnedDir()) {
            // Another Playwright version in the runtime (a new bridge pinned a new one): the old runtime and the old browsers are the bridge's own and go,
            // and only those two folders, so nobody else's browsers are touched
            if (io === realInstallIo && looksInstalled(join(runtimeDir(), 'node_modules'))) {
                log('The browser tool changed version: removing the old runtime and browsers of the bridge.');
                removeOwnFolder('runtime');
                removeOwnFolder('browsers');
            }
            await io.installRuntime(log);
        }
        const dir = io.pinnedDir() ?? playwrightRuntimeDir();
        if (!dir)
            throw new Error('Playwright was installed but cannot be found.');
        if (!(await io.chromiumPresent()))
            await io.installChromium(dir, log);
        // "Whole" means it starts, not that a file is there
        if (io === realInstallIo) {
            const started = await browserLaunches();
            if (!started.ok)
                throw new Error(`The browser was installed but ${started.detail}. Fix that and render again.`);
        }
        ensureDir(dirname(io.notePath()));
        writeFileSync(io.notePath(), new Date().toISOString() + '\n');
    }
    finally {
        lock.release();
    }
}
