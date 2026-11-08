// `check watch`: ONE WORKER PER MACHINE, A RUN ONLY FOR A BOUND FOLDER, AND THE CURRENT DIRECTORY IS NEVER A FALLBACK

// -- DEP-MODULES -- //
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { recordConnection } from './connections.js';
import { runnerAccount } from './connect.js';
import { machineLock } from './lock.js';
import { watchChecks } from './watch.js';
import { fileStore } from '../tokenStore.js';

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
});
