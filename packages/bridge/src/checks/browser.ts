// THE BROWSER OF A CHECK: ONE CHROMIUM SERVER STARTED BY THE PARENT, WHICH THE SANDBOXED CHILD ONLY CONNECTS TO.
// Playwright is not a dependency of the bridge (it is large and most people never run a check). It is found next to the bridge when it is there,
// and otherwise installed once into ~/.agent-flow-board/checks/runtime. Nothing in this file imports Playwright at load time.

// IMPORTED DEP-MODULES
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
// IMPORTED MODULES
import { acquireLock, type Lock } from './lock.js';
import { checksHome, ensureDir } from './paths.js';

// -- TYPES -- //

export type BrowserServer = {
	wsEndpoint(): string;
	close(): Promise<void>;
	/** Calls back once when the browser process ends, whether it was closed or crashed. Used by the browser pool to replace a crashed one. */
	onClose?(callback: () => void): void;
};
/** The part of playwright-core this file calls. */
type PlaywrightCore = typeof import('playwright-core');

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

const looksInstalled = (nodeModules: string) =>
	existsSync(join(nodeModules, 'playwright-core', 'package.json'));

/** The version of the playwright-core in a node_modules folder, or '' when it cannot be read. */
function versionIn(nodeModules: string): string {
	try {
		const v: unknown = JSON.parse(
			readFileSync(join(nodeModules, 'playwright-core', 'package.json'), 'utf8')
		);
		return v && typeof v === 'object' ? String((v as { version?: unknown }).version ?? '') : '';
	} catch {
		return '';
	}
}

/**
 * Which of two Playwright folders to use. The one next to the bridge is used when it is the pinned version; when it is another version and the runtime
 * install holds the pinned one, the runtime copy wins (the browser pool relies on the isolation of that exact version). With neither pinned, the one next to
 * the bridge is returned (assertPlaywrightVersion then says what is wrong), else the runtime copy, else null.
 */
export function choosePlaywrightDir(
	beside: string | null,
	runtime: string | null,
	versionOf: (dir: string) => string = versionIn
): string | null {
	if (beside && versionOf(beside) === PLAYWRIGHT_VERSION) return beside;
	if (runtime && versionOf(runtime) === PLAYWRIGHT_VERSION) return runtime;
	return beside ?? runtime;
}

/**
 * The node_modules folder that holds playwright-core (and @playwright/test when it is there): next to the bridge first (when it is the pinned version),
 * then the runtime install. The sandboxed child is allowed to read this folder and nothing else outside its own. Null when Playwright is not installed anywhere.
 */
export function playwrightRuntimeDir(): string | null {
	let beside: string | null = null;
	try {
		const pkg = createRequire(import.meta.url).resolve('playwright-core/package.json');
		// .../node_modules/playwright-core/package.json -> .../node_modules
		beside = dirname(dirname(pkg));
	} catch {
		/* Not next to the bridge: try the runtime install */
	}
	const own = join(runtimeDir(), 'node_modules');
	return choosePlaywrightDir(beside, looksInstalled(own) ? own : null);
}

/** The folders whose playwright-core version was already compared with the pin. */
const versionChecked = new Set<string>();

/**
 * Throws when the playwright-core in `dir` is not the pinned version. The browser pool relies on the isolation of that exact version
 * (every connection to a launched server gets contexts of its own), so another version is refused rather than trusted.
 */
export function assertPlaywrightVersion(dir: string): void {
	if (versionChecked.has(dir)) return;
	let found = '';
	try {
		const v: unknown = JSON.parse(
			readFileSync(join(dir, 'playwright-core', 'package.json'), 'utf8')
		);
		found = v && typeof v === 'object' ? String((v as { version?: unknown }).version ?? '') : '';
	} catch {
		/* Unreadable: reported below */
	}
	if (found !== PLAYWRIGHT_VERSION)
		throw new Error(
			`The check tool needs Playwright ${PLAYWRIGHT_VERSION} but found ${found || 'no readable version'} in ${dir}. Run "agent-flow-board check setup".`
		);
	versionChecked.add(dir);
}

/** Loads playwright-core from the folder playwrightRuntimeDir names, by absolute path. */
export async function loadPlaywright(): Promise<PlaywrightCore> {
	const dir = playwrightRuntimeDir();
	if (!dir)
		throw new Error(
			'Playwright is not installed yet. Run "agent-flow-board check setup" and it will install it.'
		);
	assertPlaywrightVersion(dir);
	const req = createRequire(join(dir, 'package.json'));
	return req(join(dir, 'playwright-core')) as PlaywrightCore;
}

/** The Chromium rule that makes every host unresolvable except the preview's, localhost and the hosts named. */
export function hostResolverRule(hosts: readonly string[] = []): string {
	const exclude = [...new Set(['127.0.0.1', 'localhost', ...hosts])]
		.map((h) => `EXCLUDE ${h}`)
		.join(', ');
	return `--host-resolver-rules=MAP * ~NOTFOUND, ${exclude}`;
}

/**
 * A browser the parent starts, so a check's process only connects to it and never has to start a program itself.
 * Every host except the preview's (and the hosts named) is unresolvable, whatever a check does with routes.
 */
export async function launchBrowserServer({
	headed = false,
	hosts = []
}: { headed?: boolean; hosts?: string[] } = {}): Promise<BrowserServer> {
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
export function describeInstallFailure(output: string): string {
	if (/proxy|407|tunnel|ECONNRESET|self[- ]signed|certificate/i.test(output))
		return 'it looks like a proxy problem (check HTTPS_PROXY and the proxy settings)';
	if (
		/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ETIMEDOUT|getaddrinfo|offline|network/i.test(
			output
		)
	)
		return 'it looks like this machine is offline';
	return 'see the last lines above';
}

/** Runs a program with the exact arguments (no shell, no stdin) and sends every output line to `log`. Resolves with the exit code and the last output. */
function runLogged(
	file: string,
	args: string[],
	log: (line: string) => void,
	cwd?: string
): Promise<{ code: number | null; tail: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, {
			cwd,
			shell: false,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let tail = '';
		const feed = (chunk: Buffer) => {
			for (const line of chunk.toString('utf8').split(/\r?\n/)) {
				const t = line.trim();
				if (!t) continue;
				tail = `${tail}\n${t}`.slice(-2000);
				log(t);
			}
		};
		child.stdout.on('data', feed);
		child.stderr.on('data', feed);
		const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);
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
function npmCli(): string | null {
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
async function installRuntime(log: (line: string) => void): Promise<void> {
	const dir = ensureDir(runtimeDir());
	const manifest = join(dir, 'package.json');
	if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ private: true }, null, 2));
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
	const out = await new Promise<{ error: Error | null; text: string }>((resolve) => {
		const done = (error: Error | null, stdout: string, stderr: string) =>
			resolve({ error, text: `${stdout}\n${stderr}` });
		if (cli)
			execFile(
				process.execPath,
				[cli, ...npmArgs],
				{ windowsHide: true, timeout: INSTALL_TIMEOUT_MS, shell: false },
				(e, so, se) => done(e, so, se)
			);
		else
			execFile(
				'npm',
				npmArgs,
				{ windowsHide: true, timeout: INSTALL_TIMEOUT_MS, shell: process.platform === 'win32' },
				(e, so, se) => done(e, so, se)
			);
	});
	if (out.error || !looksInstalled(join(dir, 'node_modules'))) {
		const last = out.text.trim().split('\n').slice(-3).join(' ').slice(0, 300);
		throw new Error(`Could not install Playwright: ${describeInstallFailure(out.text)}. ${last}`);
	}
}

/** The pinned Playwright folder, or null: the runtime has to be installed (again) when the only copy is another version. */
function pinnedDir(): string | null {
	const dir = playwrightRuntimeDir();
	return dir && versionIn(dir) === PLAYWRIGHT_VERSION ? dir : null;
}

/** The steps of an install, replaceable so the lock and the note can be tested without a download. */
export type BrowserInstallIo = {
	/** The folder of the pinned Playwright, or null. */
	pinnedDir(): string | null;
	/** True when the Chromium of that Playwright is on disk. */
	chromiumPresent(): Promise<boolean>;
	installRuntime(log: (line: string) => void): Promise<void>;
	installChromium(dir: string, log: (line: string) => void): Promise<void>;
	/** Where the note that says the install is whole is kept. */
	notePath(): string;
	lockName: string;
	pause(ms: number): Promise<void>;
};

async function installChromium(dir: string, log: (line: string) => void): Promise<void> {
	log('Installing the Chromium browser for Playwright (first use only)...');
	const cli = join(dir, 'playwright-core', 'cli.js');
	if (!existsSync(cli))
		throw new Error(
			'Playwright is installed but its installer (cli.js) is missing. Remove the runtime folder and try again.'
		);
	const { code, tail } = await runLogged(process.execPath, [cli, 'install', 'chromium'], log).catch(
		(e: unknown) => ({ code: -1, tail: String(e) })
	);
	if (code !== 0)
		throw new Error(
			`Could not install the Chromium browser: ${describeInstallFailure(tail)}. ${tail.split('\n').slice(-2).join(' ').trim().slice(0, 300)}`
		);
}

const realInstallIo: BrowserInstallIo = {
	pinnedDir,
	chromiumPresent: async () => {
		try {
			const { chromium } = await loadPlaywright();
			return existsSync(chromium.executablePath());
		} catch {
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
async function takeInstallLock(
	io: BrowserInstallIo,
	waitMs: number,
	staleMs: number
): Promise<Lock | null> {
	const until = Date.now() + waitMs;
	for (;;) {
		const lock = acquireLock(io.lockName, { staleMs });
		if (lock) return lock;
		if (Date.now() > until) return null;
		await io.pause(500);
	}
}

/**
 * Makes sure Playwright and its Chromium are there. The first use installs them (a few hundred megabytes, with progress lines in `log`);
 * later uses return at once. Never prompts. A failure is one Error that says whether it looks like offline or a proxy.
 * Two processes never install at once: a lock covers the runtime install and the Chromium download, and a note (.complete) is written only after both finished, so a
 * download that was cut short is done again instead of being trusted.
 */
export async function ensureBrowser(
	log: (line: string) => void = () => {},
	io: BrowserInstallIo = realInstallIo,
	limits: { waitMs?: number; staleMs?: number } = {}
): Promise<void> {
	const whole = async () =>
		existsSync(io.notePath()) && io.pinnedDir() !== null && (await io.chromiumPresent());
	if (await whole()) return;
	const lock = await takeInstallLock(
		io,
		limits.waitMs ?? INSTALL_LOCK_WAIT_MS,
		limits.staleMs ?? INSTALL_LOCK_STALE_MS
	);
	if (!lock)
		throw new Error(
			'Another process has been installing the browser for a long time. Wait for it, or run "agent-flow-board check doctor".'
		);
	try {
		// Whoever held the lock before may have finished the whole install
		if (await whole()) return;
		rmSync(io.notePath(), { force: true });
		if (!io.pinnedDir()) await io.installRuntime(log);
		const dir = io.pinnedDir() ?? playwrightRuntimeDir();
		if (!dir) throw new Error('Playwright was installed but cannot be found.');
		if (!(await io.chromiumPresent())) await io.installChromium(dir, log);
		ensureDir(dirname(io.notePath()));
		writeFileSync(io.notePath(), new Date().toISOString() + '\n');
	} finally {
		lock.release();
	}
}
