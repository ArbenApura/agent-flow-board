// `check run`, THE PATHS THAT END BEFORE A BROWSER STARTS: A MISSING SCRIPT, AN UNSAFE SCRIPT, A RUN THE BOARD DOES NOT GIVE, A RUN FOR ANOTHER CHECK
// The whole run against a real preview and browser is proved by step 4.1 against the product's own build.

// -- DEP-MODULES -- //
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { mintApproval } from './approve.js';
import { saveRegistration } from './registry.js';
import { addRoot } from './roots.js';
import { configForRun, runCheck, type RunOptions } from './run.js';
import { boundFolder } from './bind.js';
import { registrationsDir, scriptPath } from './paths.js';

// -- CONSTANTS -- //

const ITEM = 'AFB-20261108-0827';

// -- FUNCTIONS -- //

describe('check run, before the browser', () => {
	let home = '';
	let repo = '';
	let before: string | undefined;
	beforeEach(() => {
		before = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-run-home-'));
		process.env.AFB_BRIDGE_HOME = home;
		repo = mkdtempSync(join(tmpdir(), 'afb-run-repo-'));
		execFileSync('git', ['init', '-q'], { cwd: repo });
		writeFileSync(
			join(repo, 'package.json'),
			JSON.stringify({
				name: 'fixture',
				private: true,
				scripts: { build: 'vite build', preview: 'vite preview' }
			})
		);
	});
	afterEach(() => {
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	});

	const writeScript = (text: string) => {
		const file = scriptPath('arbenger', ITEM, 'M1');
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, text);
	};

	/** A board that records its calls. `claimJob` is what the claim answers. */
	const board = (claimJob: unknown) => {
		const calls: { url: string; body: string }[] = [];
		const fetchImpl = async (input: string, init?: RequestInit) => {
			calls.push({ url: input, body: String(init?.body ?? '') });
			if (input.endsWith('/claim')) return Response.json({ job: claimJob });
			return Response.json({ ok: true });
		};
		return { calls, fetchImpl };
	};
	const options = (
		fetchImpl: RunOptions['fetch'],
		extra: Partial<RunOptions> = {}
	): RunOptions => ({
		server: 'https://board.test',
		org: 'arbenger',
		item: ITEM,
		key: 'M1',
		dir: repo,
		runId: 'run-1',
		runnerToken: 'afx_test',
		personalToken: null,
		fetch: fetchImpl,
		log: () => undefined,
		...extra
	});

	it('ends with exit 2 and a pull hint when there is no check file, and asks the board for nothing', async () => {
		const b = board(null);
		const out = await runCheck(options(b.fetchImpl));
		expect(out.exitCode).toBe(2);
		expect(out.message).toMatch(/check pull/);
		expect(b.calls).toHaveLength(0);
	});

	it('refuses an unsafe script before it asks the board for anything', async () => {
		writeScript(
			"import { execSync } from 'child_process';\nexport default async () => execSync('x');"
		);
		const b = board(null);
		const out = await runCheck(options(b.fetchImpl));
		expect(out.exitCode).toBe(2);
		expect(out.message).toMatch(/has no business/);
		expect(b.calls).toHaveLength(0);
	});

	it('does not remember a folder for check watch when the board gives no run', async () => {
		writeScript('export default async ({ page }) => { await page.goto("/"); };');
		const b = board(null);
		await runCheck(options(b.fetchImpl));
		expect(boundFolder('arbenger', 'AFB')).toBeNull();
	});

	it('uses the current folder and remembers it when no registration exists for the board project', () => {
		const job = { project: { key: 'AFB' }, registration: null } as never;
		const out = configForRun({ org: 'arbenger', dir: repo }, job, '', () => undefined, false);
		expect(out.registration).toBeNull();
		expect(out.cfg.repo).toBeTruthy();
		expect(boundFolder('arbenger', 'AFB')?.folder).toBeTruthy();
	});

	it('routes a run to the registration the board names, the script header names, or refuses with the list', () => {
		const reg = (name: string) =>
			saveRegistration({
				org: 'arbenger',
				name,
				boardProject: 'HAPR',
				repo,
				recipe: false,
				database: 'none',
				adoptEnv: false,
				uploadSignedInPictures: false,
				createdAt: new Date().toISOString()
			});
		// The repo is inside a folder the owner approved (a code minted on a terminal, used once)
		addRoot(repo, mintApproval('roots', repo, { isTTY: true }).code);
		reg('HAPRM');
		reg('HAPRN');
		const base = { org: 'arbenger', dir: repo };
		const job = (registration: string | null) =>
			({ project: { key: 'HAPR' }, registration }) as never;
		// Named on the run by the board
		expect(
			configForRun(base, job('HAPRN'), '', () => undefined, false).cfg.registration?.name
		).toBe('HAPRN');
		// Named in the first lines of the script
		expect(
			configForRun(base, job(null), '// afb-registration: HAPRM\n', () => undefined, false).cfg
				.registration?.name
		).toBe('HAPRM');
		// Named by --registration
		expect(
			configForRun({ ...base, registration: 'HAPRM' }, job(null), '', () => undefined, false).cfg
				.registration?.name
		).toBe('HAPRM');
		// Two registrations and none named: refused with the list, never guessed
		expect(() => configForRun(base, job(null), '', () => undefined, false)).toThrow(
			/HAPRM.*HAPRN|HAPRN.*HAPRM/
		);
		// A name that serves another board project, or that no registration holds
		expect(() => configForRun(base, job('NOPE'), '', () => undefined, false)).toThrow();
		// The board's Run button never re-approves a changed pin
		writeFileSync(
			join(repo, 'package.json'),
			JSON.stringify({
				name: 'x',
				scripts: { build: 'vite build', preview: 'vite preview --open' }
			})
		);
		expect(() => configForRun(base, job('HAPRM'), '', () => undefined, true)).toThrow();
	});

	it('says plainly when the board does not give the run, and never starts a preview', async () => {
		writeScript('export default async ({ page }) => { await page.goto("/"); };');
		const b = board(null);
		const out = await runCheck(options(b.fetchImpl));
		expect(out.exitCode).toBe(2);
		expect(out.message).toMatch(/did not give this machine the run run-1/);
		expect(b.calls.map((c) => c.url.split('/runner')[1])).toEqual(['/claim']);
		// The claim named the run id and nothing else
		expect(JSON.parse(b.calls[0].body)).toEqual({ runId: 'run-1' });
	});

	it('gives back a run that is for another check, by its id only', async () => {
		writeScript('export default async ({ page }) => { await page.goto("/"); };');
		const b = board({
			kind: 'check',
			id: 'run-1',
			project: { id: 'p', key: 'AFB' },
			item: { id: 'i', ref: 'AFB-20261101-0000' },
			check: { key: 'M9', script: null, coveredPaths: [], requiredTarget: 'preview' },
			target: 'preview',
			environment: {
				name: 'afb-checks',
				url: 'x',
				kind: 'preview',
				production: false,
				writeAllowed: true
			},
			readOnly: false,
			accounts: [],
			stepKey: null,
			registration: null
		});
		const out = await runCheck(options(b.fetchImpl));
		expect(out.exitCode).toBe(2);
		expect(out.message).toMatch(/not AFB-20261108-0827 M1/);
		const release = b.calls.find((c) => c.url.endsWith('/release'));
		expect(JSON.parse(release?.body ?? '{}')).toEqual({ runIds: ['run-1'] });
	});

	it('asks for the run itself with the person sign in when no run id is given, and needs that sign in', async () => {
		writeScript('export default async ({ page }) => { await page.goto("/"); };');
		const b = board(null);
		const noSignIn = await runCheck(options(b.fetchImpl, { runId: undefined }));
		expect(noSignIn.exitCode).toBe(2);
		expect(noSignIn.message).toMatch(/Not signed in/);
	});

	it('refuses a damaged registration for the board project, and never takes the current folder in its place (C3)', () => {
		saveRegistration({
			org: 'arbenger',
			name: 'HAPRM',
			boardProject: 'HAPR',
			repo,
			recipe: false,
			database: 'none',
			adoptEnv: false,
			uploadSignedInPictures: false,
			createdAt: new Date().toISOString()
		});
		const file = join(registrationsDir(), 'arbenger', 'HAPRM.json');
		const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
		doc.adoptEnv = true;
		writeFileSync(file, JSON.stringify(doc));
		const job = { project: { key: 'HAPR' }, registration: null } as never;
		expect(() =>
			configForRun({ org: 'arbenger', dir: repo }, job, '', () => undefined, false)
		).toThrow(/changed outside "check project"/);
		// Nothing was remembered for check watch
		expect(boundFolder('arbenger', 'HAPR')).toBeNull();
		// A damaged file may have been the one for any project, so no project falls back to the folder while it is there
		const other = { project: { key: 'OTHER' }, registration: null } as never;
		expect(() =>
			configForRun({ org: 'arbenger', dir: repo }, other, '', () => undefined, false)
		).toThrow(/changed outside "check project"/);
		rmSync(file);
		expect(
			configForRun({ org: 'arbenger', dir: repo }, job, '', () => undefined, false).registration
		).toBeNull();
	});
});
