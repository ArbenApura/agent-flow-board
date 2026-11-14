// THE INSTALL: THE COMMAND PER PACKAGE MANAGER, THE CACHE RULE FOR PNPM, WINDOWS SHIMS AND THE REAL HAPR COMMANDS AGAINST THE GUARDRAILS (NO INSTALL IS RUN)

// IMPORTED DEP-MODULES
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { commandProblem } from './guardrails.js';
import {
	forgetPackageManagerVersions,
	installDirFor,
	packageManagerVersion,
	versionIo,
	findOnPath,
	installCacheable,
	installCommand,
	lockHash,
	packageManagerOf,
	pathOf,
	programArgv
} from './install.js';

// -- CONSTANTS -- //

/** The `scripts` of C:\Users\Admin\Desktop\hapr-gameplan\web\package.json, copied as text. */
const HAPR_WEB_SCRIPTS = {
	dev: 'vite dev',
	build: 'vite build',
	'check:pricing-bundle': 'node scripts/check-pricing-bundle.mjs',
	preview: 'vite preview',
	prepare: 'node scripts/prepare.mjs',
	check: 'svelte-kit sync && svelte-check --tsconfig ./tsconfig.json',
	'check:watch': 'svelte-kit sync && svelte-check --tsconfig ./tsconfig.json --watch',
	lint: 'prettier --check . && eslint .',
	'lint:shard': 'node scripts/eslint-shard.mjs',
	format: 'prettier --write .',
	test: 'vitest run',
	'test:watch': 'vitest',
	e2e: 'node e2e/cli.mjs',
	'e2e:test': 'node --test "e2e/lib/*.test.mjs" && tsc -p e2e/tsconfig.json',
	'check:events':
		'node scripts/with-flavour.mjs events svelte-kit sync && node scripts/with-flavour.mjs events svelte-check --tsconfig ./tsconfig.events.check.json',
	'check:hapr':
		'node scripts/with-flavour.mjs hapr svelte-kit sync && node scripts/with-flavour.mjs hapr svelte-check --tsconfig ./tsconfig.hapr.check.json',
	'build:events': 'node scripts/with-flavour.mjs events vite build',
	'build:hapr': 'node scripts/with-flavour.mjs hapr vite build'
};
/** The `scripts` of C:\Users\Admin\Desktop\hapr-gameplan\landing\package.json, copied as text. */
const HAPR_LANDING_SCRIPTS = {
	dev: 'vite dev',
	build: 'vite build',
	preview: 'vite preview',
	prepare: "svelte-kit sync || echo ''",
	check: 'svelte-kit sync && svelte-check --tsconfig ./tsconfig.json',
	'check:watch': 'svelte-kit sync && svelte-check --tsconfig ./tsconfig.json --watch',
	lint: 'prettier --check . && eslint .',
	format: 'prettier --write .',
	test: 'vitest run',
	'test:watch': 'vitest',
	'verify:live': 'node scripts/verify-live-seo.mjs'
};

// -- FUNCTIONS -- //

describe('install', () => {
	let dir = '';
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'afb-install-'));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	const put = (name: string, text = '') => writeFileSync(join(dir, name), text);

	it('has no command without a package.json or a lock file', () => {
		expect(installCommand(dir)).toBeNull();
		put('yarn.lock');
		expect(installCommand(dir)).toBeNull(); // No package.json
		rmSync(join(dir, 'yarn.lock'));
		put('package.json', '{}');
		expect(installCommand(dir)).toBeNull();
		expect(packageManagerOf(dir)).toBeNull();
	});

	it('picks a frozen install with scripts off from the lock file', () => {
		put('package.json', '{}');
		put('package-lock.json', '{}');
		expect(installCommand(dir)).toEqual(['npm', 'ci', '--ignore-scripts']);
		rmSync(join(dir, 'package-lock.json'));
		put('pnpm-lock.yaml', 'lockfileVersion: 9');
		expect(installCommand(dir)).toEqual([
			'pnpm',
			'install',
			'--frozen-lockfile',
			'--ignore-scripts'
		]);
		rmSync(join(dir, 'pnpm-lock.yaml'));
		put('yarn.lock');
		expect(installCommand(dir)).toEqual([
			'yarn',
			'install',
			'--frozen-lockfile',
			'--ignore-scripts'
		]);
		put('.yarnrc.yml', 'nodeLinker: node-modules');
		expect(installCommand(dir)).toEqual(['yarn', 'install', '--immutable']);
		expect(packageManagerOf(dir)).toBe('yarn');
	});

	it('caches a yarn or npm install but never a pnpm one, nor a node_modules pnpm made', () => {
		put('package.json', '{}');
		put('package-lock.json', '{}');
		expect(installCacheable(dir)).toBe(true);
		rmSync(join(dir, 'package-lock.json'));
		put('yarn.lock');
		expect(installCacheable(dir)).toBe(true);
		// A pnpm fixture: the lock file and the .modules.yaml that holds the store location
		const pnpm = mkdtempSync(join(tmpdir(), 'afb-install-pnpm-'));
		try {
			writeFileSync(join(pnpm, 'package.json'), '{}');
			writeFileSync(join(pnpm, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
			expect(installCacheable(pnpm)).toBe(false);
			mkdirSync(join(pnpm, 'node_modules'));
			writeFileSync(join(pnpm, 'node_modules', '.modules.yaml'), 'storeDir: C:\\store\\v3\n');
			expect(installCacheable(pnpm)).toBe(false);
			// Even with another lock file beside it, a node_modules that pnpm made is not cached
			writeFileSync(join(pnpm, 'package-lock.json'), '{}');
			expect(installCacheable(pnpm)).toBe(false);
		} finally {
			rmSync(pnpm, { recursive: true, force: true });
		}
		expect(installCacheable(join(dir, 'missing'))).toBe(false);
	});

	it('hashes the lock files, so a changed lock gives another key', () => {
		put('package.json', '{}');
		put('yarn.lock', 'a');
		const a = lockHash(dir);
		put('yarn.lock', 'b');
		expect(lockHash(dir)).not.toBe(a);
		expect(lockHash(dir)).toMatch(/^[0-9a-f]{40}$/);
	});

	it('starts yarn, npm and pnpm through cmd.exe on Windows, and nothing else', () => {
		expect(programArgv(['pnpm', 'build'], { platform: 'win32', pathEnv: '' })).toEqual([
			'cmd.exe',
			'/d',
			'/s',
			'/c',
			'pnpm.cmd',
			'build'
		]);
		expect(programArgv(['node', 'x.js'], { platform: 'win32', pathEnv: '' })).toEqual([
			'node',
			'x.js'
		]);
		expect(programArgv(['pnpm', 'build'], { platform: 'linux' })).toEqual(['pnpm', 'build']);
		expect(programArgv([], { platform: 'win32' })).toEqual([]);
	});

	it('uses a real .exe on PATH over the shim, and finds a shim folder case-insensitively', () => {
		const exists = (f: string) => f === join('C:\\bin', 'yarn.exe');
		expect(
			programArgv(['yarn', 'install'], {
				platform: 'win32',
				pathEnv: ['C:\\x', 'C:\\bin'].join(delimiter),
				exists
			})
		).toEqual([join('C:\\bin', 'yarn.exe'), 'install']);
		expect(findOnPath('npm', 'C:\\x', ['.exe', '.cmd'], () => false)).toBeNull();
		expect(pathOf({ Path: 'C:\\a', X: 'y' })).toBe('C:\\a');
		expect(pathOf({ X: 'y' })).toBe('');
	});

	it("accepts HAPR's real build and preview commands against its package.json scripts", () => {
		for (const scripts of [HAPR_WEB_SCRIPTS, HAPR_LANDING_SCRIPTS]) {
			expect(commandProblem('pnpm build', scripts, 'The build command')).toBeNull();
			expect(
				commandProblem('pnpm preview --port {port} --host 127.0.0.1', scripts, 'The start command')
			).toBeNull();
		}
	});

	it('still refuses a HAPR script that runs a file, in the same scripts', () => {
		expect(commandProblem('pnpm prepare', HAPR_WEB_SCRIPTS, 'The build command')).toMatch(
			/not a plain build or preview command/
		);
		expect(commandProblem('pnpm build:hapr', HAPR_WEB_SCRIPTS, 'The build command')).toMatch(
			/not a plain build or preview command/
		);
	});

	it('finds the lock file above an app folder, up to the copy root only (C13)', () => {
		const app = join(dir, 'apps', 'web');
		mkdirSync(app, { recursive: true });
		writeFileSync(join(app, 'package.json'), '{}');
		expect(installDirFor(app, dir)).toBeNull();
		put('package.json', '{}');
		put('yarn.lock', '');
		expect(installDirFor(app, dir)).toBe(dir);
		// A lock file inside the app wins
		writeFileSync(join(app, 'package-lock.json'), '{}');
		expect(installDirFor(app, dir)).toBe(app);
		// Never above the copy root
		const inner = join(dir, 'apps');
		rmSync(join(app, 'package-lock.json'));
		expect(installDirFor(app, inner)).toBeNull();
	});

	it('asks a package manager for its version once per process and keeps no failed answer (C16)', async () => {
		forgetPackageManagerVersions();
		const real = versionIo.run;
		let calls = 0;
		versionIo.run = async () => {
			calls++;
			return calls === 1 ? '' : '4.18.1';
		};
		try {
			expect(await packageManagerVersion('yarn', dir)).toBe('');
			expect(await packageManagerVersion('yarn', dir)).toBe('4.18.1');
			expect(await packageManagerVersion('yarn', dir)).toBe('4.18.1');
			expect(calls).toBe(2);
		} finally {
			versionIo.run = real;
			forgetPackageManagerVersions();
		}
	});
});
