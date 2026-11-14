// THE RUN SCOPE: MARKER FIRST, RESOURCES CLOSED NEWEST FIRST, DEAD RUNS SWEPT AND LIVE ONES KEPT, AND A WHOLE PROCESS TREE KILLED

// IMPORTED DEP-MODULES
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
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// IMPORTED MODULES
import { pidAlive } from './lock.js';
import { pooledNames } from './dbpool.js';
import { copiesDir, logDirFor, markerPath, runsDir } from './paths.js';
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

	const marker = (id: string) => markerPath(id);
	const deadPid = 2_147_483_000;
	/** A run folder as a crashed (or running) process left it. */
	const plant = (id: string, pid: number | null, ageMs = 0) => {
		mkdirSync(join(runsDir(), id), { recursive: true });
		mkdirSync(join(copiesDir(), id), { recursive: true });
		mkdirSync(dirname(markerPath(id)), { recursive: true });
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

	it.skipIf(process.platform !== 'win32')(
		'kills a cmd-shim parent and the child process it started on Windows',
		async () => {
			const shimDir = mkdtempSync(join(tmpdir(), 'afb-shim-'));
			const pidFile = join(shimDir, 'grand.pid');
			const shimFile = join(shimDir, 'dev.cmd');
			const grandScript = join(shimDir, 'srv.cjs');
			writeFileSync(
				grandScript,
				`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`
			);
			writeFileSync(shimFile, `@echo off\r\n"${process.execPath}" "${grandScript}"\r\n`);
			const shim = spawn('cmd.exe', ['/d', '/s', '/c', shimFile], {
				stdio: 'ignore',
				windowsHide: true
			});
			try {
				let grandPid = 0;
				for (let i = 0; i < 60 && !grandPid; i++) {
					if (existsSync(pidFile)) {
						const raw = Number(readFileSync(pidFile, 'utf8').trim());
						if (Number.isInteger(raw) && raw > 0) grandPid = raw;
					}
					if (!grandPid) await new Promise((r) => setTimeout(r, 50));
				}
				const pid = shim.pid ?? 0;
				expect(pid).toBeGreaterThan(0);
				expect(grandPid).toBeGreaterThan(0);
				expect(pidAlive(pid)).toBe(true);
				expect(pidAlive(grandPid)).toBe(true);
				await killTree(pid);
				for (let i = 0; i < 40 && (pidAlive(pid) || pidAlive(grandPid)); i++)
					await new Promise((r) => setTimeout(r, 100));
				expect(pidAlive(pid)).toBe(false);
				expect(pidAlive(grandPid)).toBe(false);
			} finally {
				if (shim.pid && pidAlive(shim.pid)) await killTree(shim.pid);
				rmSync(shimDir, { recursive: true, force: true });
			}
		},
		20_000
	);
	// -- THE MARKER IS OUT OF THE CHILD'S REACH (S1) -- //

	const sleeper = () =>
		spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
			stdio: 'ignore',
			windowsHide: true
		});
	const docker = () => vi.fn(async () => ({ status: 0, stdout: '', stderr: '' }));

	it('never honours a marker forged inside the run folder the child can write', async () => {
		const victim = sleeper();
		const calls = docker();
		try {
			const pid = victim.pid ?? 0;
			// A hostile check writes what it likes into its own run folder, in every spelling of the old marker name
			mkdirSync(join(runsDir(), 'rforged'), { recursive: true });
			for (const name of ['ACTIVE', 'ACTIVE.json', 'ENDED'])
				writeFileSync(
					join(runsDir(), 'rforged', name),
					JSON.stringify({
						runId: 'rforged',
						pid: deadPid,
						startedAt: new Date().toISOString(),
						previewPid: pid,
						containerName: 'afb-checks-pool-abc',
						dbName: 'afbd_x',
						roleName: 'afbr_x',
						poolId: 'abc'
					})
				);
			const t = new Date(Date.now() - 3_600_000);
			utimesSync(join(runsDir(), 'rforged'), t, t);
			await sweepOrphans(() => {}, { docker: calls });
			expect(pidAlive(pid)).toBe(true);
			expect(calls).not.toHaveBeenCalled();
		} finally {
			await killTree(victim.pid ?? 0);
		}
	});

	it('refuses a marker that names a process, container, database or role that is not the run itself', async () => {
		const victim = sleeper();
		const calls = docker();
		const notes: string[] = [];
		try {
			const pid = victim.pid ?? 0;
			mkdirSync(join(runsDir(), 'rforeign'), { recursive: true });
			mkdirSync(dirname(markerPath('rforeign')), { recursive: true });
			writeFileSync(
				markerPath('rforeign'),
				JSON.stringify({
					runId: 'rforeign',
					pid: deadPid,
					startedAt: new Date().toISOString(),
					// No start time recorded with the process id
					previewPid: pid,
					containerName: 'afb-checks-pool-abc',
					dbName: 'postgres',
					roleName: 'postgres',
					poolId: 'abc'
				})
			);
			await sweepOrphans((s) => notes.push(s), { docker: calls });
			expect(pidAlive(pid)).toBe(true);
			expect(calls).not.toHaveBeenCalled();
			expect(notes.join(' ')).toMatch(/preview process that does not check out/);
			expect(notes.join(' ')).toMatch(/container that is not the one this run makes/);
			expect(notes.join(' ')).toMatch(/database or role that is not this run/);
		} finally {
			await killTree(victim.pid ?? 0);
		}
	});

	it('honours a marker whose names are the ones the tool derives for the run', async () => {
		const names = pooledNames('rmine');
		const calls = docker();
		mkdirSync(join(runsDir(), 'rmine'), { recursive: true });
		mkdirSync(dirname(markerPath('rmine')), { recursive: true });
		writeFileSync(
			markerPath('rmine'),
			JSON.stringify({
				runId: 'rmine',
				pid: deadPid,
				startedAt: new Date().toISOString(),
				containerName: 'afb-checks-rmine'
			})
		);
		await sweepOrphans(() => {}, { docker: calls });
		expect(calls).toHaveBeenCalled();
		expect(JSON.stringify(calls.mock.calls)).toContain('afb-checks-rmine');
		expect(names.dbName).toMatch(/^afbd_/);
	});

	it('closes a resource added after the scope closed at once, and never rewrites the marker', async () => {
		const scope = new RunScope('rlate');
		await scope.close();
		let closed = false;
		scope.add('late', () => void (closed = true));
		scope.setInfo({ previewPid: 4242 });
		await new Promise((r) => setTimeout(r, 20));
		expect(closed).toBe(true);
		expect(existsSync(marker('rlate'))).toBe(false);
	});

	it('sweeps the logs of a run that has no folder, marker or copy any more, once they are old enough', async () => {
		mkdirSync(logDirFor('rorphanlog'), { recursive: true });
		writeFileSync(join(logDirFor('rorphanlog'), 'build.log'), 'x');
		mkdirSync(logDirFor('ryounglog'), { recursive: true });
		const t = new Date(Date.now() - 3_600_000);
		utimesSync(logDirFor('rorphanlog'), t, t);
		await sweepOrphans();
		expect(existsSync(logDirFor('rorphanlog'))).toBe(false);
		expect(existsSync(logDirFor('ryounglog'))).toBe(true);
	});

	it('keeps the logs of a run out of the run folder and removes them with the scope', async () => {
		const scope = new RunScope('rlogs');
		scope.start();
		expect(existsSync(join(logDirFor('rlogs')))).toBe(true);
		expect(logDirFor('rlogs').startsWith(runsDir())).toBe(false);
		await scope.close();
		expect(existsSync(logDirFor('rlogs'))).toBe(false);
	});
});
