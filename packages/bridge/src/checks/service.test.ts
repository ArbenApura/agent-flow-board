// THE CHECK SERVICE: THE LAUNCHER BYTES, THE RESTART MATH, TERMINAL STOPS, ONE SUPERVISOR, A SAFE UNINSTALL, THE LOG AND THE STALE VERSION RESTART
// No real service is installed: the Startup folder is a temporary one (AFB_CHECKS_STARTUP) and the worker is a tiny node script.

// -- DEP-MODULES -- //
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { acquireSlot } from './broker.js';
import { checksHome } from './paths.js';
import {
	HEALTHY_MS,
	LAUNCHER_NAME,
	LOG_LIMIT,
	acquireServiceLock,
	backoffDelay,
	isTerminal,
	launcherBytes,
	launcherText,
	nextQuick,
	readServiceLock,
	runService,
	serviceCommand,
	serviceLogFile,
	tailLog,
	versionNewer,
	workerIdle,
	writeLog
} from './service.js';
import type { ServiceDeps } from './service.js';

// -- FUNCTIONS -- //

describe('check service', () => {
	let home = '';
	let startup = '';
	let beforeHome: string | undefined;
	let beforeStartup: string | undefined;
	beforeEach(() => {
		beforeHome = process.env.AFB_BRIDGE_HOME;
		beforeStartup = process.env.AFB_CHECKS_STARTUP;
		home = mkdtempSync(join(tmpdir(), 'afb-service-'));
		startup = join(home, 'startup');
		process.env.AFB_BRIDGE_HOME = home;
		process.env.AFB_CHECKS_STARTUP = startup;
	});
	afterEach(() => {
		if (beforeHome === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = beforeHome;
		if (beforeStartup === undefined) delete process.env.AFB_CHECKS_STARTUP;
		else process.env.AFB_CHECKS_STARTUP = beforeStartup;
		rmSync(home, { recursive: true, force: true });
	});

	const ctx = () => {
		const lines: string[] = [];
		const outs: string[] = [];
		return {
			lines,
			outs,
			c: { log: (l: string) => lines.push(l), out: (l: string) => outs.push(l), json: false }
		};
	};
	const node = process.execPath;
	const instant = () => Promise.resolve();

	it('writes the launcher as UTF-16LE with a byte order mark, quoted with doubled quotes, hidden and not waiting', async () => {
		const { c, lines } = ctx();
		const fakeDeps: Partial<ServiceDeps> = { startDetached: () => undefined };
		expect(await serviceCommand(['install', '--no-start'], c, fakeDeps)).toBe(0);
		const file = join(startup, LAUNCHER_NAME);
		const bytes = readFileSync(file);
		expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
		const text = bytes.subarray(2).toString('utf16le');
		expect(text).toContain('CreateObject("WScript.Shell").Run ""');
		expect(text).toMatch(/Run """[^"]+"" ""[^"]+"" check service run", 0, False/);
		expect(text.endsWith('\r\n')).toBe(true);
		expect(lines.join('\n')).toContain('Installed');
		// Pure form matches what is written
		expect(
			launcherBytes('C:\\Program Files\\nodejs\\node.exe', 'C:\\x y\\cli.js').toString('utf16le')
		).toBe(`\ufeff${launcherText('C:\\Program Files\\nodejs\\node.exe', 'C:\\x y\\cli.js')}`);
		expect(() => launcherText('a"b', 'c')).toThrow();
	});

	it('refuses to install on another system unless a Startup folder is named, and starts the supervisor only without --no-start', async () => {
		const { c, lines } = ctx();
		delete process.env.AFB_CHECKS_STARTUP;
		expect(await serviceCommand(['install'], c, { platform: 'linux' })).toBe(2);
		expect(lines.join(' ')).toContain('Windows');
		process.env.AFB_CHECKS_STARTUP = startup;
		let started = 0;
		const d: Partial<ServiceDeps> = { platform: 'linux', startDetached: () => void started++ };
		expect(await serviceCommand(['install'], ctx().c, d)).toBe(0);
		expect(started).toBe(1);
		expect(await serviceCommand(['install', '--no-start'], ctx().c, d)).toBe(0);
		expect(started).toBe(1);
	});

	it('restarts after min(60 s, 1 s x 2^min(quick deaths, 6)) and resets after a worker lived over 60 s', () => {
		expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map(backoffDelay)).toEqual([
			1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000
		]);
		expect(nextQuick(3, 1000)).toBe(4);
		expect(nextQuick(3, HEALTHY_MS)).toBe(4);
		expect(nextQuick(5, HEALTHY_MS + 1)).toBe(0);
	});

	it('knows the terminal sentinel lines and nothing else, and compares versions (C8)', () => {
		for (const kind of ['not-connected', 'rejected', 'needs-newer', 'not-set-up'])
			expect(isTerminal(`some output\nAFB_TERMINAL: ${kind}\nmore`)).toBe(true);
		// Free text, even the old phrases, never stops the service
		for (const m of [
			'Not connected to a board',
			'The board no longer accepts this machine',
			'This needs a newer bridge',
			'This folder is not set up yet',
			'the app said AFB_TERMINAL: rejected in the middle of a line',
			'AFB_TERMINAL: something-else',
			'connection reset'
		])
			expect(isTerminal(m), m).toBe(false);
		expect(versionNewer('0.3.0', '0.2.9')).toBe(true);
		expect(versionNewer('0.10.0', '0.9.0')).toBe(true);
		expect(versionNewer('0.2.0', '0.2.0')).toBe(false);
		expect(versionNewer('0.1.9', '0.2.0')).toBe(false);
	});

	it('runs a fake worker, restarts it with the growing delay, and stops on a terminal message', async () => {
		const counter = join(home, 'count.txt');
		const script = `const fs=require('fs');const f=process.argv[1];let n=0;try{n=Number(fs.readFileSync(f,'utf8'))}catch{}n++;fs.writeFileSync(f,String(n));if(n<3){console.log('boom '+n);process.exit(1)}console.log('AFB_TERMINAL: not-connected');console.log('Not connected to a board');process.exit(1)`;
		const delays: number[] = [];
		const said: string[] = [];
		const r = await runService({
			workerCommand: { cmd: node, args: ['-e', script, counter] },
			nap: (ms) => {
				delays.push(ms);
				return instant();
			},
			say: (l) => said.push(l)
		});
		expect(r.reason).toBe('terminal');
		expect(readFileSync(counter, 'utf8')).toBe('3');
		expect(delays).toEqual([2000, 4000]);
		const status = JSON.parse(readFileSync(join(checksHome(), 'service-status.json'), 'utf8')) as {
			state: string;
			message: string;
			lastExit: { code: number };
		};
		expect(status.state).toBe('stopped');
		expect(status.message).toContain('Not connected');
		expect(status.lastExit.code).toBe(1);
		expect(said.join(' ')).toContain('stopped');
		// The lock is given back
		expect(existsSync(join(checksHome(), 'service.lock'))).toBe(false);
		expect(readFileSync(serviceLogFile(), 'utf8')).toContain('worker: boom 1');
	});

	it('keeps restarting a worker that only prints the old phrases as free text (C8)', async () => {
		const counter = join(home, 'free.txt');
		const script = `const fs=require('fs');const f=process.argv[1];let n=0;try{n=Number(fs.readFileSync(f,'utf8'))}catch{}n++;fs.writeFileSync(f,String(n));console.log('Not connected to a board; the app is not set up');process.exit(1)`;
		const r = await runService({
			workerCommand: { cmd: node, args: ['-e', script, counter] },
			nap: instant,
			maxRestarts: 3
		});
		expect(r.reason).toBe('max');
		expect(Number(readFileSync(counter, 'utf8'))).toBeGreaterThanOrEqual(3);
	});

	it('resets the delay after a worker that lived a long time (clock stand-in)', async () => {
		const counter = join(home, 'c2.txt');
		const script = `const fs=require('fs');const f=process.argv[1];let n=0;try{n=Number(fs.readFileSync(f,'utf8'))}catch{}n++;fs.writeFileSync(f,String(n));process.exit(n>=4?0:1)`;
		let t = 0;
		const lives = [1000, HEALTHY_MS + 5000, 1000, 1000];
		const delays: number[] = [];
		let call = 0;
		const r = await runService({
			workerCommand: { cmd: node, args: ['-e', script, counter] },
			// Each worker "lives" as long as the table says: the clock moves when the worker is read as ended
			now: () => {
				call++;
				if (call % 2 === 1) return t;
				t += lives[(call / 2 - 1) % lives.length]!;
				return t;
			},
			nap: (ms) => {
				delays.push(ms);
				return instant();
			},
			maxRestarts: 3
		});
		expect(r.reason).toBe('max');
		expect(delays).toEqual([2000, 1000, 2000]);
	});

	it('allows one supervisor only: a second is refused while the first holds the lock', async () => {
		const ac = new AbortController();
		const script = `setInterval(()=>{},1000)`;
		const first = runService({
			workerCommand: { cmd: node, args: ['-e', script] },
			signal: ac.signal,
			version: '1.0.0'
		});
		try {
			for (let i = 0; i < 100 && !readServiceLock(); i++)
				await new Promise((r) => setTimeout(r, 20));
			expect(readServiceLock()?.pid).toBe(process.pid);
			expect(readServiceLock()?.version).toBe('1.0.0');
			const second = await runService({
				workerCommand: { cmd: node, args: ['-e', 'process.exit(0)'] }
			});
			expect(second.reason).toBe('already');
			// The refused one did not take the lock away
			expect(readServiceLock()?.pid).toBe(process.pid);
		} finally {
			// The worker process is stopped whatever the assertions said
			ac.abort();
		}
		expect((await first).reason).toBe('stopped');
		expect(readServiceLock()).toBeNull();
	});

	it('takes over a lock whose process is gone', async () => {
		mkdirSync(checksHome(), { recursive: true });
		writeFileSync(
			join(checksHome(), 'service.lock'),
			JSON.stringify({ pid: 999999, startedAt: new Date().toISOString(), version: '0.0.1' })
		);
		const lock = await acquireServiceLock('1.2.3', {
			isAlive: () => false,
			startOf: async () => null
		});
		expect(lock).not.toBeNull();
		expect(readServiceLock()?.pid).toBe(process.pid);
		lock?.release();
		expect(readServiceLock()).toBeNull();
	});

	it('uninstall removes the launcher but leaves a reused process id with another start time alone', async () => {
		await serviceCommand(['install', '--no-start'], ctx().c, {});
		mkdirSync(checksHome(), { recursive: true });
		const recorded = Date.parse('2026-11-08T10:00:00Z');
		writeFileSync(
			join(checksHome(), 'service.lock'),
			JSON.stringify({ pid: 4242, startedAt: new Date(recorded).toISOString(), version: '0.2.0' })
		);
		const killed: number[] = [];
		const deps = (startOf: number | null): Partial<ServiceDeps> => ({
			isAlive: (pid) => pid === 4242,
			startOf: async () => startOf,
			killTree: async (pid) => void killed.push(pid)
		});
		// A different start time (a reused id): not killed, the launcher is still removed
		const a = ctx();
		expect(await serviceCommand(['uninstall'], a.c, deps(recorded + 3 * 3600_000))).toBe(0);
		expect(killed).toEqual([]);
		expect(existsSync(join(startup, LAUNCHER_NAME))).toBe(false);
		expect(a.lines.join(' ')).toContain('left alone');
		// An unknown start time is not enough for a kill either
		await serviceCommand(['uninstall'], ctx().c, deps(null));
		expect(killed).toEqual([]);
		// The same start time (within 120 s): stopped
		await serviceCommand(['uninstall'], ctx().c, deps(recorded + 30_000));
		expect(killed).toEqual([4242]);
		expect(readServiceLock()).toBeNull();
	});

	it('rotates the log at 1 MB and redacts every line', () => {
		writeLog('Authorization: Bearer abcdefghijklmnop1234 token afb_abcdefghijklmnopqrstu');
		const first = readFileSync(serviceLogFile(), 'utf8');
		expect(first).not.toContain('abcdefghijklmnop1234');
		expect(first).not.toContain('afb_abcdefghijklmnopqrstu');
		writeFileSync(serviceLogFile(), 'x'.repeat(LOG_LIMIT + 10));
		writeLog('after rotation');
		expect(readFileSync(`${serviceLogFile()}.old`, 'utf8').length).toBe(LOG_LIMIT + 10);
		expect(readFileSync(serviceLogFile(), 'utf8')).toContain('after rotation');
		expect(readFileSync(serviceLogFile(), 'utf8').length).toBeLessThan(200);
		expect(tailLog(1)).toHaveLength(1);
	});

	it('status prints stopped without a supervisor, and running with one', async () => {
		writeLog('hello token afb_abcdefghijklmnopqrstu');
		const a = ctx();
		expect(await serviceCommand(['status'], a.c, {})).toBe(0);
		expect(a.lines[0]).toContain('stopped');
		expect(a.lines.join('\n')).not.toContain('afb_abcdefghijklmnopqrstu');
		writeFileSync(
			join(checksHome(), 'service.lock'),
			JSON.stringify({ pid: 77, startedAt: new Date().toISOString(), version: '0.2.0' })
		);
		const b = ctx();
		b.c.json = true;
		await serviceCommand(['status'], b.c, { isAlive: () => true, startOf: async () => Date.now() });
		const parsed = JSON.parse(b.outs[0]!) as { running: boolean; pid: number };
		expect(parsed.running).toBe(true);
		expect(parsed.pid).toBe(77);
	});

	it('restarts for a newer installed bridge only when the worker shows no busy run', async () => {
		const starts = join(home, 'starts.txt');
		const script = `require('fs').appendFileSync(process.argv[1],'x\\n');setInterval(()=>{},1000)`;
		mkdirSync(checksHome(), { recursive: true });
		const worker = join(checksHome(), 'worker.json');
		writeFileSync(
			worker,
			JSON.stringify({ pid: 1, slots: 3, busy: 2, runs: ['a', 'b'], at: new Date().toISOString() })
		);
		expect(workerIdle()).toBe(false);
		const ac = new AbortController();
		const done = runService({
			workerCommand: { cmd: node, args: ['-e', script, starts] },
			version: '0.2.0',
			installedVersion: () => '0.3.0',
			versionCheckMs: 30,
			signal: ac.signal,
			nap: instant
		});
		const count = () =>
			existsSync(starts) ? readFileSync(starts, 'utf8').split('\n').filter(Boolean).length : 0;
		const waitFor = async (n: number) => {
			for (let i = 0; i < 200 && count() < n; i++) await new Promise((r) => setTimeout(r, 25));
		};
		try {
			await waitFor(1);
			await new Promise((r) => setTimeout(r, 300));
			expect(count()).toBe(1); // Busy: not restarted
			writeFileSync(
				worker,
				JSON.stringify({ pid: 1, slots: 3, busy: 0, runs: [], at: new Date().toISOString() })
			);
			await waitFor(2);
			expect(count()).toBeGreaterThanOrEqual(2); // Idle: restarted
			expect(readServiceLock()?.version).toBe('0.3.0');
		} finally {
			ac.abort();
		}
		expect((await done).reason).toBe('stopped');
	}, 20_000);

	it('the idle check follows the live slot count of the machine, not worker.json alone (C8)', async () => {
		mkdirSync(checksHome(), { recursive: true });
		// No worker file at all, and nobody holds a slot
		expect(workerIdle()).toBe(true);
		// A worker file that says idle, while a run holds a slot right now
		writeFileSync(
			join(checksHome(), 'worker.json'),
			JSON.stringify({ pid: 1, slots: 3, busy: 0, runs: [], at: new Date().toISOString() })
		);
		expect(workerIdle()).toBe(true);
		const slot = await acquireSlot(
			{ runId: 'rbusyslot', kind: 'check', registration: 'AFB' },
			{ signal: new AbortController().signal }
		);
		try {
			expect(workerIdle()).toBe(false);
		} finally {
			await slot.release();
		}
		expect(workerIdle()).toBe(true);
	});
});
