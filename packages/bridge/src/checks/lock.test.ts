// THE FILE LOCKS: ONE HOLDER AT A TIME, A STALE LOCK TAKEN OVER BY ONLY ONE CONTENDER, AND A LOCK FILE THAT IS NEVER VISIBLE EMPTY

// -- DEP-MODULES -- //
import { spawn } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { acquireLock, lockHolderPid, machineLock, withLockSync } from './lock.js';
import { locksDir } from './paths.js';

// -- FUNCTIONS -- //

describe('file locks', () => {
	let home = '';
	let before: string | undefined;
	beforeEach(() => {
		before = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-lock-'));
		process.env.AFB_BRIDGE_HOME = home;
	});
	afterEach(() => {
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
	});

	const plant = (name: string, body: object, ageMs = 0) => {
		mkdirSync(locksDir(), { recursive: true });
		const file = join(locksDir(), `${name}.lock`);
		writeFileSync(file, JSON.stringify(body) + '\n');
		if (ageMs) utimesSync(file, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
		return file;
	};
	const deadPid = 2_147_483_000;

	it('lets one holder in and releases', () => {
		const a = acquireLock('one', { staleMs: 10_000 });
		expect(a).not.toBeNull();
		expect(acquireLock('one', { staleMs: 10_000 })).toBeNull();
		a?.release();
		a?.release();
		const b = acquireLock('one', { staleMs: 10_000 });
		expect(b).not.toBeNull();
		b?.release();
		expect(existsSync(join(locksDir(), 'one.lock'))).toBe(false);
	});

	it('takes over a stale lock for exactly one of two contenders', () => {
		plant('stale', { pid: deadPid, at: new Date().toISOString(), token: 'x' });
		const first = acquireLock('stale', { staleMs: 10_000 });
		const second = acquireLock('stale', { staleMs: 10_000 });
		expect([first, second].filter((l) => l !== null)).toHaveLength(1);
		expect(first).not.toBeNull();
		first?.release();
	});

	it('takes over a lock that is too old even when its process is alive', () => {
		plant('old', { pid: process.pid, at: new Date(Date.now() - 60_000).toISOString(), token: 'x' });
		const l = acquireLock('old', { staleMs: 1_000 });
		expect(l).not.toBeNull();
		l?.release();
	});

	it('does not take over a fresh lock of a live process', () => {
		plant('fresh', { pid: process.pid, at: new Date().toISOString(), token: 'x' });
		expect(acquireLock('fresh', { staleMs: 10_000 })).toBeNull();
	});

	it('removes a damaged lock only after a grace period', () => {
		const file = plant('bad', { nope: true });
		writeFileSync(file, 'not json');
		expect(acquireLock('bad', { staleMs: 10_000 })).toBeNull();
		utimesSync(file, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
		expect(acquireLock('bad', { staleMs: 10_000 })?.release()).toBeUndefined();
	});

	it('never removes a lock that belongs to somebody else on release', () => {
		const a = acquireLock('mine', { staleMs: 10_000 });
		const file = join(locksDir(), 'mine.lock');
		writeFileSync(
			file,
			JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: 'other' })
		);
		a?.release();
		expect(existsSync(file)).toBe(true);
	});

	it('gives the machine lock to one worker, and takes it from a dead one', () => {
		const w = machineLock('watch');
		expect(w).not.toBeNull();
		expect(machineLock('watch')).toBeNull();
		expect(lockHolderPid('machine-watch')).toBe(process.pid);
		w?.release();
		plant('machine-watch', { pid: deadPid, at: new Date().toISOString(), token: 'x' });
		const again = machineLock('watch');
		expect(again).not.toBeNull();
		again?.release();
	});

	it('runs a function under the lock and throws one plain sentence when it cannot wait', () => {
		const held = acquireLock('wait', { staleMs: 10_000 });
		expect(() => withLockSync('wait', () => 1, { waitMs: 60 })).toThrow(/kept the "wait" lock/);
		held?.release();
		expect(withLockSync('wait', () => 7)).toBe(7);
	});

	it('is never visible empty or half written to a process that watches the file', async () => {
		mkdirSync(locksDir(), { recursive: true });
		const file = join(locksDir(), 'watched.lock');
		// A separate process reads the lock file in a tight loop while this one takes and gives it back
		const script = `
			const fs = require('fs'); let bad = 0, seen = 0; const end = Date.now() + 1500;
			while (Date.now() < end) { try { const t = fs.readFileSync(process.argv[1], 'utf8'); seen++; try { JSON.parse(t); } catch { bad++; } } catch {} }
			process.stdout.write(JSON.stringify({ bad, seen }));`;
		const child = spawn(process.execPath, ['-e', script, file], {
			stdio: ['ignore', 'pipe', 'ignore']
		});
		let out = '';
		child.stdout.on('data', (d: Buffer) => (out += d.toString()));
		const done = new Promise<void>((r) => child.once('close', () => r()));
		const end = Date.now() + 1200;
		while (Date.now() < end) {
			const l = acquireLock('watched', { staleMs: 10_000 });
			l?.release();
		}
		await done;
		const res = JSON.parse(out) as { bad: number; seen: number };
		expect(res.bad).toBe(0);
		expect(
			readdirSync(locksDir()).filter((n) => n.endsWith('.tmp') || n.includes('.aside.'))
		).toEqual([]);
		expect(existsSync(file) ? readFileSync(file, 'utf8') : '').not.toBe('\n');
	});

	it('takes the worker lock from a holder whose process id is alive but whose heartbeat stopped (C18)', () => {
		// A crashed worker whose id was handed to another program: the id is alive, the heartbeat is old
		plant('machine-watch', {
			pid: process.pid,
			at: new Date(Date.now() - 10 * 60_000).toISOString(),
			token: 'crashed'
		});
		const w = machineLock('watch');
		expect(w).not.toBeNull();
		w?.release();
	});

	it('keeps the worker lock from a second worker while the first one touches it (C18)', () => {
		const w = machineLock('watch');
		expect(w).not.toBeNull();
		w?.touch();
		expect(machineLock('watch')).toBeNull();
		const file = join(locksDir(), 'machine-watch.lock');
		const before = Date.parse((JSON.parse(readFileSync(file, 'utf8')) as { at: string }).at);
		// A touch moves the heartbeat forward and keeps the owner
		const old = JSON.parse(readFileSync(file, 'utf8')) as {
			pid: number;
			at: string;
			token: string;
		};
		writeFileSync(file, JSON.stringify({ ...old, at: new Date(before - 120_000).toISOString() }));
		w?.touch();
		const after = JSON.parse(readFileSync(file, 'utf8')) as { at: string; token: string };
		expect(Date.parse(after.at)).toBeGreaterThan(before - 60_000);
		expect(after.token).toBe(old.token);
		w?.release();
	});
});
