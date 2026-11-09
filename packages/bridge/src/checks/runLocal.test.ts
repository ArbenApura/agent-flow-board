// `check run --local`: A SCRIPT RUN HERE WITH NO BOARD CALL AT ALL, ON EVERY PATH THAT ENDS BEFORE A BROWSER STARTS
// The stand-in board has no address. These tests also make the network throw, so any call that slipped through would fail the run it belongs to.

// -- DEP-MODULES -- //
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { checkMain } from './command.js';
import { LocalSink } from './localSink.js';
import { scriptPath } from './paths.js';
import { saveRegistration } from './registry.js';
import { configForLocal, runCheck, type RunOptions } from './run.js';
import { newLocalRunId } from './scope.js';
import { fileStore } from '../tokenStore.js';

// -- CONSTANTS -- //

const ITEM = 'HAPR-20261105-1312';

// -- FUNCTIONS -- //

describe('check run --local', () => {
	let home = '';
	let repo = '';
	let before: string | undefined;
	beforeEach(() => {
		before = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-local-home-'));
		process.env.AFB_BRIDGE_HOME = home;
		repo = mkdtempSync(join(tmpdir(), 'afb-local-repo-'));
		execFileSync('git', ['init', '-q'], { cwd: repo });
		writeFileSync(
			join(repo, 'package.json'),
			JSON.stringify({ name: 'fixture', private: true, scripts: { build: 'x', preview: 'x' } })
		);
	});
	afterEach(() => {
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	});

	const writeScript = (key: string, text: string) => {
		const file = scriptPath('mangoman', ITEM, key);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, text);
	};
	const reg = (name: string, over: Record<string, unknown> = {}) =>
		saveRegistration({
			org: 'mangoman',
			name,
			boardProject: 'HAPR',
			url: 'https://demo.example.com',
			recipe: false,
			database: 'none',
			adoptEnv: false,
			uploadSignedInPictures: false,
			createdAt: new Date().toISOString(),
			...over
		} as never);
	/** A network that fails the test the moment anything uses it. */
	const calls: string[] = [];
	const noNetwork = (async (input: string) => {
		calls.push(String(input));
		throw new Error('The network was used in a local run.');
	}) as unknown as RunOptions['fetch'];
	const local = (key: string, extra: Partial<RunOptions> = {}): RunOptions => ({
		mode: 'local',
		server: '',
		org: 'mangoman',
		item: ITEM,
		key,
		dir: repo,
		runnerToken: '',
		personalToken: null,
		fetch: noNetwork,
		log: () => undefined,
		...extra
	});

	it('the stand-in board answers nothing and has no address to call', async () => {
		const sink = new LocalSink();
		expect(await sink.claim()).toBeNull();
		expect(await sink.release()).toBe(0);
		expect(await sink.beat()).toEqual({ ok: true });
		expect(await sink.finish()).toBeUndefined();
		expect(await sink.upload()).toBe('');
	});

	it('a local run id is plain, unique and never looks like a board run id', () => {
		const a = newLocalRunId();
		const b = newLocalRunId();
		expect(a).toMatch(/^local-[a-z0-9]+$/);
		expect(a).not.toBe(b);
	});

	it('works with any key (D2, WHO), not only M<n>, and ends with exit 2 and no network when there is no file', async () => {
		const out = await runCheck(local('D2'));
		expect(out.exitCode).toBe(2);
		expect(out.message).toMatch(/There is no check file/);
		expect(out.resultPath).toBeNull();
		expect(calls).toEqual([]);
	});

	it('refuses an unsafe script and uses no network', async () => {
		writeScript('WHO', "import { execSync } from 'child_process';\nexport default async () => 1;");
		const out = await runCheck(local('WHO', { registration: 'HAPRDEMO' }));
		expect(out.exitCode).toBe(2);
		expect(out.message).toMatch(/has no business/);
		expect(calls).toEqual([]);
	});

	it('needs the registration by name and lists the choices, without taking the current folder in its place', async () => {
		reg('HAPRDEMO');
		reg('HAPRA', { url: 'https://app.example.com' });
		writeScript('D2', 'export default async ({ page }) => { await page.goto("/"); };');
		const out = await runCheck(local('D2'));
		expect(out.exitCode).toBe(2);
		expect(out.message).toMatch(/needs the registration/);
		expect(out.message).toMatch(/HAPRDEMO, HAPRA|HAPRA, HAPRDEMO/);
		const unknown = await runCheck(local('D2', { registration: 'NOPE' }));
		expect(unknown.exitCode).toBe(2);
		expect(unknown.message).toMatch(/no registration NOPE in mangoman/);
		expect(calls).toEqual([]);
	});

	it('takes the registration from the script header when --registration is not given', () => {
		reg('HAPRDEMO');
		const got = configForLocal(
			{ org: 'mangoman', registration: undefined },
			'// afb-registration: haprdemo\nexport default 1'
		);
		expect(got.registration.name).toBe('HAPRDEMO');
		expect(got.scriptRegistration).toBe('haprdemo');
	});

	it('stops at a changed pin instead of pinning by itself', () => {
		saveRegistration({
			org: 'mangoman',
			name: 'WEB',
			boardProject: 'HAPR',
			repo,
			recipe: false,
			database: 'none',
			adoptEnv: false,
			uploadSignedInPictures: false,
			createdAt: new Date().toISOString(),
			pin: 'not-the-current-hash'
		} as never);
		expect(() => configForLocal({ org: 'mangoman', registration: 'WEB' }, '')).toThrow(
			/changed since they were approved/
		);
	});

	it('a named profile that does not exist ends the run before anything starts, with no network', async () => {
		reg('HAPRDEMO');
		writeScript('WHO', 'export default async ({ page }) => { await page.goto("/"); };');
		const out = await runCheck(local('WHO', { registration: 'HAPRDEMO', profile: 'read-only' }));
		expect(out.exitCode).toBe(2);
		expect(out.message).toMatch(/no saved sign-in named "read-only" for HAPRDEMO/);
		expect(calls).toEqual([]);
	});

	it('runs on a machine that is not connected to any board: no connection, no server, no token', async () => {
		const logs: string[] = [];
		const outs: string[] = [];
		writeScript('D2', "import { execSync } from 'child_process';\nexport default async () => 1;");
		const code = await checkMain({
			args: ['run', '--local', ITEM, 'D2', '--org', 'mangoman', '--registration', 'HAPRDEMO'],
			store: fileStore(home),
			fetch: noNetwork,
			personalToken: () => null,
			log: (l: string) => logs.push(l),
			out: (l: string) => outs.push(l)
		});
		expect(code).toBe(2);
		// It got as far as reading the script: it never stopped to ask for a connection or a server
		expect(logs.join('\n')).not.toMatch(/not connected|--server/);
		expect(logs.join('\n')).toMatch(/has no business/);
		expect(outs.join('\n')).not.toMatch(/RESULT/);
		expect(calls).toEqual([]);
	});

	it('finds the item and the key after flags and flag values, so --org and --local may come first', async () => {
		writeScript('D2', "import { execSync } from 'child_process';\nexport default async () => 1;");
		const logs: string[] = [];
		const code = await checkMain({
			args: ['run', '--org', 'mangoman', '--local', '--registration', 'HAPRDEMO', ITEM, 'D2'],
			store: fileStore(home),
			fetch: noNetwork,
			personalToken: () => null,
			log: (l: string) => logs.push(l),
			out: () => undefined
		});
		expect(code).toBe(2);
		expect(logs.join('\n')).toMatch(/has no business/);
		expect(calls).toEqual([]);
	});

	it('--local takes no --run, --step or --server, instead of silently ignoring them', async () => {
		for (const extra of [
			['--run', 'x'],
			['--step', '1.1'],
			['--server', 'https://board.test']
		]) {
			const logs: string[] = [];
			const code = await checkMain({
				args: ['run', '--local', ITEM, 'D2', '--org', 'mangoman', ...extra],
				store: fileStore(home),
				fetch: noNetwork,
				personalToken: () => null,
				log: (l: string) => logs.push(l),
				out: () => undefined
			});
			expect(code).toBe(2);
			expect(logs.join('\n')).toMatch(/takes no --run, --step or --server/);
		}
		expect(calls).toEqual([]);
	});

	it('a board run still needs the connection, so --local is the only way around it', async () => {
		const logs: string[] = [];
		const code = await checkMain({
			args: ['run', ITEM, 'D2', '--org', 'mangoman', '--server', 'https://board.test'],
			store: fileStore(home),
			fetch: noNetwork,
			personalToken: () => null,
			log: (l: string) => logs.push(l),
			out: () => undefined
		});
		expect(code).toBe(2);
		expect(logs.join('\n')).toMatch(/not connected to mangoman/);
	});
});
