// `check watch`: ONE WORKER PER MACHINE, A RUN ONLY FOR A BOUND FOLDER, AND THE CURRENT DIRECTORY IS NEVER A FALLBACK

// -- DEP-MODULES -- //
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// -- MODULES -- //
import { recordConnection } from './connections.js';
import { runnerAccount } from './connect.js';
import { machineLock } from './lock.js';
import { watchChecks } from './watch.js';
import { fileStore } from '../tokenStore.js';

// -- MOCKS -- //

// The real pool functions run; the call is recorded
const configured = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('./dbpool.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('./dbpool.js')>();
	return {
		...real,
		configureDatabasePool: (d: Parameters<typeof real.configureDatabasePool>[0]) => {
			configured.calls.push(d);
			real.configureDatabasePool(d);
		}
	};
});

// -- CONSTANTS -- //

const SERVER = 'https://board.test';

const job = {
	kind: 'check',
	id: 'run-w1',
	project: { id: 'p', key: 'AFB' },
	item: { id: 'i', ref: 'AFB-20261108-0827' },
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
};

// -- FUNCTIONS -- //

describe('check watch', () => {
	let home = '';
	let before: string | undefined;
	beforeEach(() => {
		before = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-watch-'));
		process.env.AFB_BRIDGE_HOME = home;
	});
	afterEach(() => {
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
	});

	const board = () => {
		const calls: { path: string; body: string }[] = [];
		let handed = false;
		const fetchImpl = async (input: string, init?: RequestInit) => {
			const path = input.split('/runner')[1] ?? input;
			calls.push({ path, body: String(init?.body ?? '') });
			if (path === '/peek') return Response.json({ waiting: handed ? 0 : 1 });
			if (path === '/claim') {
				const out = Response.json({ job: handed ? null : job });
				handed = true;
				return out;
			}
			return Response.json({ ok: true, released: 0 });
		};
		return { calls, fetchImpl };
	};

	it('ends a run for a project with no bound folder as could-not-run, and never uses the current directory', async () => {
		const store = fileStore(home);
		store.set(runnerAccount(SERVER, 'arbenger'), 'afx_runner');
		recordConnection({ server: SERVER, org: 'arbenger', name: 'PC agent-flow-board' });
		const b = board();
		const taken = await watchChecks({
			store,
			fetch: b.fetchImpl,
			log: () => undefined,
			parallel: 1,
			once: true,
			signal: new AbortController().signal
		});
		expect(taken).toBe(1);
		const finish = b.calls.find((c) => c.path === '/runs/run-w1/finish');
		expect(finish).toBeTruthy();
		const report = JSON.parse(finish?.body ?? '{}');
		expect(report.result).toBe('error');
		expect(report.reason).toMatch(/no folder for AFB/);
	});

	it('refuses a second worker on the same machine, and lets the next one in after the first ends', async () => {
		const held = machineLock('watch');
		expect(held).not.toBeNull();
		await expect(
			watchChecks({
				store: fileStore(home),
				fetch: board().fetchImpl,
				log: () => undefined,
				parallel: 1,
				once: true,
				signal: new AbortController().signal
			})
		).rejects.toThrow(/Another "check watch"/);
		held?.release();
		await expect(
			watchChecks({
				store: fileStore(home),
				fetch: board().fetchImpl,
				log: () => undefined,
				parallel: 1,
				once: true,
				signal: new AbortController().signal
			})
		).resolves.toBe(0);
	});

	it('skips a connection that has no runner token', async () => {
		recordConnection({ server: SERVER, org: 'arbenger', name: 'x' });
		const b = board();
		const taken = await watchChecks({
			store: fileStore(home),
			fetch: b.fetchImpl,
			log: () => undefined,
			parallel: 1,
			once: true,
			signal: new AbortController().signal
		});
		expect(taken).toBe(0);
		expect(b.calls.filter((c) => c.path === '/peek')).toHaveLength(0);
	});

	// -- TERMINAL SENTINELS (C8) -- //

	const watching = (
		store: ReturnType<typeof fileStore>,
		fetchImpl: (u: string, i?: RequestInit) => Promise<Response>,
		lines: string[],
		ac = new AbortController()
	) =>
		watchChecks({
			store,
			fetch: fetchImpl,
			log: (l) => lines.push(l),
			parallel: 1,
			once: false,
			signal: ac.signal
		});

	it('prints the not-set-up sentinel and stops when the machine is connected to no board, but not for one pass with --once', async () => {
		const lines: string[] = [];
		await expect(watching(fileStore(home), board().fetchImpl, lines)).rejects.toThrow(/Not set up/);
		expect(lines).toContain('AFB_TERMINAL: not-set-up');
	});

	it('prints the not-connected sentinel when no connection has a runner token', async () => {
		recordConnection({ server: SERVER, org: 'arbenger', name: 'x' });
		const lines: string[] = [];
		await expect(watching(fileStore(home), board().fetchImpl, lines)).rejects.toThrow(
			/Not connected/
		);
		expect(lines).toContain('AFB_TERMINAL: not-connected');
	});

	it('prints the rejected sentinel when the board answers 401 for every connection', async () => {
		const store = fileStore(home);
		store.set(runnerAccount(SERVER, 'arbenger'), 'afx_runner');
		recordConnection({ server: SERVER, org: 'arbenger', name: 'PC' });
		const lines: string[] = [];
		const gone = async () => Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 });
		await expect(watching(store, gone, lines)).rejects.toThrow(/no longer accepts this machine/);
		expect(lines).toContain('AFB_TERMINAL: rejected');
	}, 20_000);

	it('prints the needs-newer sentinel when the board answers that the tool is too old', async () => {
		const store = fileStore(home);
		store.set(runnerAccount(SERVER, 'arbenger'), 'afx_runner');
		recordConnection({ server: SERVER, org: 'arbenger', name: 'PC' });
		const lines: string[] = [];
		const old = async () =>
			Response.json(
				{ error: { code: 'UPGRADE_REQUIRED', message: 'Update to 0.9.0.' } },
				{ status: 426 }
			);
		await expect(watching(store, old, lines)).rejects.toThrow(/needs a newer bridge/);
		expect(lines).toContain('AFB_TERMINAL: needs-newer');
	}, 20_000);

	it('one refused board among several is not a terminal stop', async () => {
		const store = fileStore(home);
		store.set(runnerAccount(SERVER, 'arbenger'), 'afx_runner');
		store.set(runnerAccount(SERVER, 'second'), 'afx_runner2');
		recordConnection({ server: SERVER, org: 'arbenger', name: 'PC' });
		recordConnection({ server: SERVER, org: 'second', name: 'PC' });
		const lines: string[] = [];
		const ac = new AbortController();
		const mixed = async (input: string, init?: RequestInit) => {
			const auth = new Headers(init?.headers).get('authorization') ?? '';
			if (auth.endsWith('afx_runner'))
				return Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 });
			return Response.json({ waiting: 0 });
		};
		setTimeout(() => ac.abort(), 1500);
		await expect(watching(store, mixed, lines, ac)).resolves.toBe(0);
		expect(lines.some((l) => l.startsWith('AFB_TERMINAL'))).toBe(false);
	}, 20_000);

	it('sizes the database pool to the slots and keeps it warm while the worker runs (C10)', async () => {
		configured.calls.length = 0;
		await watchChecks({
			store: fileStore(home),
			fetch: board().fetchImpl,
			log: () => undefined,
			parallel: 1,
			once: true,
			signal: new AbortController().signal
		});
		expect(configured.calls).toContainEqual({ slots: 1, removeWhenIdle: false });
	});
});
