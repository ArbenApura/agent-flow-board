// THE BROWSER OF A CHECK: ONE CHROMIUM SERVER STARTED BY THE PARENT, WHICH THE SANDBOXED CHILD ONLY CONNECTS TO.
// Playwright is not a dependency of the bridge (it is large and most people never run a check). It is found next to the bridge when it is there,
// and otherwise installed once into ~/.agent-flow-board/checks/runtime. Nothing in this file imports Playwright at load time.

// -- DEP-MODULES -- //
import { execFile, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
// -- MODULES -- //
import { checksHome, ensureDir } from './paths.js';

// -- TYPES -- //

export type BrowserServer = { wsEndpoint(): string; close(): Promise<void> };
/** The part of playwright-core this file calls. */
type PlaywrightCore = typeof import('playwright-core');

// -- CONSTANTS -- //

/** The Playwright version the runtime install pins, so a check behaves the same on every machine. */
const PLAYWRIGHT_VERSION = '1.64.0';
const INSTALL_TIMEOUT_MS = 10 * 60_000;

// -- FUNCTIONS -- //

/** Where the runtime install lives. It is a folder of the bridge's own state, never a repo. */
const runtimeDir = () => join(checksHome(), 'runtime');

const looksInstalled = (nodeModules: string) =>
	existsSync(join(nodeModules, 'playwright-core', 'package.json'));

/**
 * The node_modules folder that holds playwright-core (and @playwright/test when it is there): next to the bridge first, then the runtime
 * install. The sandboxed child is allowed to read this folder and nothing else outside its own. Null when Playwright is not installed anywhere.
 */
export function playwrightRuntimeDir(): string | null {
	try {
		const pkg = createRequire(import.meta.url).resolve('playwright-core/package.json');
		// .../node_modules/playwright-core/package.json -> .../node_modules
		return dirname(dirname(pkg));
	} catch {
		/* Not next to the bridge: try the runtime install */
	}
	const own = join(runtimeDir(), 'node_modules');
	return looksInstalled(own) ? own : null;
}

/** Loads playwright-core from the folder playwrightRuntimeDir names, by absolute path. */
export async function loadPlaywright(): Promise<PlaywrightCore> {
	const dir = playwrightRuntimeDir();
	if (!dir)
		throw new Error(
			'Playwright is not installed yet. Run "agent-flow-board check setup" and it will install it.'
		);
	const req = createRequire(join(dir, 'package.json'));
	return req(join(dir, 'playwright-core')) as PlaywrightCore;
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
	const exclude = [...new Set(['127.0.0.1', 'localhost', ...hosts])]
		.map((h) => `EXCLUDE ${h}`)
		.join(', ');
	const server = await chromium.launchServer({
		headless: !headed,
		args: [
			`--host-resolver-rules=MAP * ~NOTFOUND, ${exclude}`,
			'--disable-background-networking',
			'--no-first-run'
		]
	});
	return { wsEndpoint: () => server.wsEndpoint(), close: () => server.close() };
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

/**
 * Makes sure Playwright and its Chromium are there. The first use installs them (a few hundred megabytes, with progress lines in `log`);
 * later uses return at once. Never prompts. A failure is one Error that says whether it looks like offline or a proxy.
 */
export async function ensureBrowser(log: (line: string) => void = () => {}): Promise<void> {
	if (!playwrightRuntimeDir()) await installRuntime(log);
	const dir = playwrightRuntimeDir();
	if (!dir) throw new Error('Playwright was installed but cannot be found.');
	const { chromium } = await loadPlaywright();
	try {
		if (existsSync(chromium.executablePath())) return;
	} catch {
		/* No executable path known yet: install below */
	}
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
