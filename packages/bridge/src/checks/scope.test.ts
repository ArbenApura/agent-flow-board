// THE RUN SCOPE: MARKER FIRST, RESOURCES CLOSED NEWEST FIRST, DEAD RUNS SWEPT AND LIVE ONES KEPT, AND A WHOLE PROCESS TREE KILLED

// -- DEP-MODULES -- //
import { spawn } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { pidAlive } from './lock.js';
import { copiesDir, runsDir } from './paths.js';
import {
	RunScope,
	clearRuns,
	installSignalHandlers,
	killTree,
	newRunId,
	removeTree,
	sweepOrphans
} from './scope.js';

// -- FUNCTIONS -- //

describe('run scope', () => {
	let home = '';
	let before: string | undefined;
	beforeEach(() => {
		before = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-scope-'));
		process.env.AFB_BRIDGE_HOME = home;
	});
	afterEach(() => {
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
	});

	const marker = (id: string) => join(runsDir(), id, 'ACTIVE');
	const deadPid = 2_147_483_000;
	/** A run folder as a crashed (or running) process left it. */
	const plant = (id: string, pid: number | null, ageMs = 0) => {
		mkdirSync(join(runsDir(), id), { recursive: true });
		mkdirSync(join(copiesDir(), id), { recursive: true });
		writeFileSync(join(copiesDir(), id, 'f.txt'), 'x');
		if (pid !== null)
			writeFileSync(
				marker(id),
				JSON.stringify({ runId: id, pid, startedAt: new Date().toISOString() })
			);
		if (ageMs) {
			const t = new Date(Date.now() - ageMs);
			for (const p of [join(runsDir(), id), join(copiesDir(), id)]) utimesSync(p, t, t);
		}
	};

	it('makes a plain run id', () => {
		expect(newRunId()).toMatch(/^r[0-9a-z]+$/);
		expect(newRunId()).not.toBe(newRunId());
	});

	it('writes the marker before the first resource, and removes it on close', async () => {
		const seen: boolean[] = [];
		const scope = new RunScope('rtest1');
		scope.add('first', () => {
			seen.push(existsSync(marker('rtest1')));
		});
		expect(existsSync(marker('rtest1'))).toBe(true);
		const m = JSON.parse(readFileSync(marker('rtest1'), 'utf8')) as { pid: number };
		expect(m.pid).toBe(process.pid);
		await scope.close();
		expect(seen).toEqual([true]);
		expect(existsSync(marker('rtest1'))).toBe(false);
		await scope.close();
	});

	it('closes newest first, even when one throws, and never throws', async () => {
		const order: string[] = [];
		const logs: string[] = [];
		const scope = new RunScope('rtest2', (s) => logs.push(s));
		scope.add('a', () => void order.push('a'));
		scope.add('b', () => {
			order.push('b');
			throw new Error('secret value');
		});
		scope.add('c', async () => void order.push('c'));
		await expect(scope.close()).resolves.toBeUndefined();
		expect(order).toEqual(['c', 'b', 'a']);
		expect(logs).toEqual(['Could not close b.']);
	});

	it('records what a crash would leave behind in the marker', () => {
		const scope = new RunScope('rtest3');
		scope.setInfo({ previewPid: 123, containerName: 'afb-checks-rtest3' });
		scope.setInfo({ copyDir: 'x' });
		const m = JSON.parse(readFileSync(marker('rtest3'), 'utf8')) as Record<string, unknown>;
		expect(m).toMatchObject({ previewPid: 123, containerName: 'afb-checks-rtest3', copyDir: 'x' });
	});

	it('sweeps only the dead run, and keeps the live one', async () => {
		plant('rdead', deadPid);
		plant('rlive', process.pid);
		plant('rfresh', null);
		plant('rold', null, 3_600_000);
		mkdirSync(join(runsDir(), 'not a run!'), { recursive: true });
		const n = await sweepOrphans();
		expect(n).toBe(2);
		expect(existsSync(join(runsDir(), 'rdead'))).toBe(false);
		expect(existsSync(join(copiesDir(), 'rdead'))).toBe(false);
		expect(existsSync(join(runsDir(), 'rold'))).toBe(false);
		expect(existsSync(join(runsDir(), 'rlive'))).toBe(true);
		expect(existsSync(join(copiesDir(), 'rlive'))).toBe(true);
		expect(existsSync(join(runsDir(), 'rfresh'))).toBe(true);
		expect(existsSync(join(runsDir(), 'not a run!'))).toBe(true);
	});

	it('does not sweep a run that ended in order', async () => {
		const scope = new RunScope('rended');
		scope.start();
		await scope.close();
		const t = new Date(Date.now() - 3_600_000);
		utimesSync(join(runsDir(), 'rended'), t, t);
		expect(await sweepOrphans()).toBe(0);
		expect(existsSync(join(runsDir(), 'rended'))).toBe(true);
	});

	it('clears finished runs by age, keeps a running one, and clears all on request', () => {
		plant('rlive', process.pid);
		plant('rnew', null);
		plant('rold', null, 8 * 86_400_000);
		expect(clearRuns()).toEqual({ removed: 1 });
		expect(existsSync(join(runsDir(), 'rold'))).toBe(false);
		expect(existsSync(join(runsDir(), 'rnew'))).toBe(true);
		expect(clearRuns({ all: true })).toEqual({ removed: 1 });
		expect(existsSync(join(runsDir(), 'rlive'))).toBe(true);
		expect(existsSync(join(copiesDir(), 'rlive'))).toBe(true);
	});

	it('removes a link inside a copy as a link and never walks through it', () => {
		const outside = mkdtempSync(join(tmpdir(), 'afb-outside-'));
		writeFileSync(join(outside, 'keep.txt'), 'keep');
		mkdirSync(join(copiesDir(), 'rlink'), { recursive: true });
		try {
			symlinkSync(outside, join(copiesDir(), 'rlink', 'l'), 'junction');
			removeTree(join(copiesDir(), 'rlink'));
			expect(existsSync(join(copiesDir(), 'rlink'))).toBe(false);
			expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it('adds and removes the stop signal handlers, and closes the scope before calling onKill', async () => {
		const scope = new RunScope('rsig');
		const order: string[] = [];
		scope.add('x', () => void order.push('closed'));
		const before = process.listeners('SIGTERM');
		let killed: () => void = () => {};
		const done = new Promise<void>((r) => (killed = r));
		const uninstall = installSignalHandlers(scope, () => {
			order.push('kill');
			killed();
		});
		const mine = process.listeners('SIGTERM').filter((l) => !before.includes(l));
		expect(mine).toHaveLength(1);
		mine[0]?.('SIGTERM');
		await done;
		expect(order).toEqual(['closed', 'kill']);
		uninstall();
		expect(process.listeners('SIGTERM')).toEqual(before);
	});

	it('kills a process and the process it started', async () => {
		const grand = 'setInterval(() => {}, 1000)';
		const parent = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grand)}], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000)`;
		const child = spawn(process.execPath, ['-e', parent], {
			stdio: ['ignore', 'pipe', 'ignore'],
			detached: process.platform !== 'win32',
			windowsHide: true
		});
		const grandPid = await new Promise<number>((resolve) =>
			child.stdout.once('data', (d: Buffer) => resolve(Number(d.toString().trim())))
		);
		const pid = child.pid ?? 0;
		expect(pidAlive(pid)).toBe(true);
		expect(pidAlive(grandPid)).toBe(true);
		await killTree(pid);
		for (let i = 0; i < 40 && (pidAlive(pid) || pidAlive(grandPid)); i++)
			await new Promise((r) => setTimeout(r, 100));
		expect(pidAlive(pid)).toBe(false);
		expect(pidAlive(grandPid)).toBe(false);
		child.stdout.destroy();
	}, 20_000);
});
