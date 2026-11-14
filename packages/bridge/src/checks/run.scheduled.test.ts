// `check run` AS THE WORKER'S SCHEDULER USES IT: A STOP REACHES EACH RUN THROUGH ITS SIGNAL, NO RUN INSTALLS A SIGNAL HANDLER, ENDS THE PROCESS OR REPORTS A RUN THE SCHEDULER GIVES BACK
// The preview is replaced by one that waits for the signal, so no build tool or browser is needed.

// IMPORTED DEP-MODULES
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// IMPORTED MODULES
import { auditFile, markerPath, scriptPath } from './paths.js';
import { limitSentence, runCheck, runLimitMs, type RunOptions } from './run.js';

// -- MOCKS -- //

const started: string[] = [];
vi.mock('./preview.js', () => ({
	startPreview: (_cfg: unknown, opts: { runId: string; signal?: AbortSignal }) =>
		new Promise((_resolve, reject) => {
			started.push(opts.runId);
			opts.signal?.addEventListener('abort', () => reject(new Error('The run was stopped.')), {
				once: true
			});
		})
}));
vi.mock('./browser.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./browser.js')>()),
	ensureBrowser: async () => undefined
}));

// -- CONSTANTS -- //

const ITEM = 'AFB-20261108-0827';

const jobFor = (id: string) =>
	({
		kind: 'check',
		id,
		project: { id: 'p', key: 'AFB' },
		item: { id: 'i', ref: ITEM },
		check: { key: 'M1', script: null, coveredPaths: [], requiredTarget: 'preview' },
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
	}) as never;

// -- FUNCTIONS -- //

describe('check run held by the worker scheduler', () => {
	let home = '';
	let repo = '';
	let before: string | undefined;
	beforeEach(() => {
		started.length = 0;
		before = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-sched-home-'));
		process.env.AFB_BRIDGE_HOME = home;
		repo = mkdtempSync(join(tmpdir(), 'afb-sched-repo-'));
		execFileSync('git', ['init', '-q'], { cwd: repo });
		writeFileSync(
			join(repo, 'package.json'),
			JSON.stringify({
				name: 'fixture',
				private: true,
				scripts: { build: 'vite build', preview: 'vite preview' }
			})
		);
		const file = scriptPath('arbenger', ITEM, 'M1');
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, 'export default async ({ page }) => { await page.goto("/"); };');
	});
	afterEach(() => {
		vi.restoreAllMocks();
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	});

	const options = (
		fetchImpl: RunOptions['fetch'],
		id: string,
		signal: AbortSignal
	): RunOptions => ({
		server: 'https://board.test',
		org: 'arbenger',
		item: ITEM,
		key: 'M1',
		dir: repo,
		claimed: jobFor(id),
		scheduled: true,
		signal,
		runnerToken: 'afx_test',
		personalToken: null,
		fetch: fetchImpl,
		log: () => undefined
	});

	it('two scheduled runs and a stop: no handler, no finish, no process exit, both scopes closed (C1)', async () => {
		const calls: string[] = [];
		const fetchImpl = async (input: string) => {
			calls.push(input);
			return Response.json({ ok: true });
		};
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
		const sigintBefore = process.listenerCount('SIGINT');
		const termBefore = process.listenerCount('SIGTERM');
		const ac = new AbortController();
		const a = runCheck(options(fetchImpl, 'rsch1', ac.signal));
		const b = runCheck(options(fetchImpl, 'rsch2', ac.signal));
		for (let i = 0; i < 100 && started.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
		expect(started.sort()).toEqual(['rsch1', 'rsch2']);
		// Each run owns a marker while it works, and neither added a stop handler of its own
		expect(existsSync(markerPath('rsch1'))).toBe(true);
		expect(existsSync(markerPath('rsch2'))).toBe(true);
		expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
		expect(process.listenerCount('SIGTERM')).toBe(termBefore);
		ac.abort('stopped');
		const [oa, ob] = await Promise.all([a, b]);
		expect(oa.exitCode).toBe(2);
		expect(ob.exitCode).toBe(2);
		// The scheduler gives the runs back by id: a run that was stopped reports nothing
		expect(calls.filter((c) => c.endsWith('/finish'))).toEqual([]);
		expect(exit).not.toHaveBeenCalled();
		expect(existsSync(markerPath('rsch1'))).toBe(false);
		expect(existsSync(markerPath('rsch2'))).toBe(false);
	}, 30_000);

	it('a standalone run still reports a run that fails, and its limit is 40 minutes unless set (C20)', async () => {
		expect(runLimitMs({})).toBe(40 * 60_000);
		expect(runLimitMs({ AFB_CHECKS_RUN_LIMIT_MS: '1500' })).toBe(1500);
		expect(runLimitMs({ AFB_CHECKS_RUN_LIMIT_MS: 'nope' })).toBe(40 * 60_000);
		expect(limitSentence(90_000)).toMatch(/longer than 2 minutes/);
		expect(limitSentence(1500)).toMatch(/longer than 2 seconds/);
		const calls: { url: string; body: string }[] = [];
		const fetchImpl = async (input: string, init?: RequestInit) => {
			calls.push({ url: input, body: String(init?.body ?? '') });
			return Response.json({ ok: true });
		};
		process.env.AFB_CHECKS_RUN_LIMIT_MS = '600';
		try {
			const out = await runCheck({
				...options(fetchImpl, 'rsch3', new AbortController().signal),
				scheduled: false,
				signal: undefined
			});
			expect(out.exitCode).toBe(2);
			expect(out.message).toMatch(/took longer than/);
			const finish = calls.find((c) => c.url.endsWith('/finish'));
			expect(finish).toBeTruthy();
			expect(finish?.body).toMatch(/took longer than/);
		} finally {
			delete process.env.AFB_CHECKS_RUN_LIMIT_MS;
		}
	}, 30_000);

	it('a failing audit log never changes the outcome of a run (C11)', async () => {
		// The audit file is a folder, so every line written to it fails
		mkdirSync(auditFile(), { recursive: true });
		const logs: string[] = [];
		const fetchImpl = async () => Response.json({ ok: true });
		const ac = new AbortController();
		const running = runCheck({
			...options(fetchImpl, 'rsch4', ac.signal),
			log: (l) => logs.push(l)
		});
		for (let i = 0; i < 100 && !started.includes('rsch4'); i++)
			await new Promise((r) => setTimeout(r, 50));
		// The run got as far as starting its preview, past the line that failed to be written
		expect(started).toContain('rsch4');
		expect(logs.join(' ')).toMatch(/audit log could not be written/);
		ac.abort('stopped');
		const out = await running;
		expect(out.message).toMatch(/stopped/);
	}, 30_000);
});
