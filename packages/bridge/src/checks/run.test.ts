// `check run`, THE PATHS THAT END BEFORE A BROWSER STARTS: A MISSING SCRIPT, AN UNSAFE SCRIPT, A RUN THE BOARD DOES NOT GIVE, A RUN FOR ANOTHER CHECK
// The whole run against a real preview and browser is proved by step 4.1 against the product's own build.

// -- DEP-MODULES -- //
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { runCheck, type RunOptions } from './run.js';
import { boundFolder } from './bind.js';
import { scriptPath } from './paths.js';

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

	it('remembers the folder for check watch once the script and the folder are fine', async () => {
		writeScript('export default async ({ page }) => { await page.goto("/"); };');
		const b = board(null);
		await runCheck(options(b.fetchImpl));
		expect(boundFolder('arbenger', 'AFB')?.folder).toBeTruthy();
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
});
