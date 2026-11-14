// THE MACHINE BROKER: THE SLOT COUNT HOLDS ACROSS PROCESSES, REGISTRATIONS TAKE TURNS, THE MACHINE CHECK WAITS INSTEAD OF FAILING, AND A KILLED PROCESS LOSES ITS SLOT

// IMPORTED DEP-MODULES
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	acquireSlot,
	canTake,
	listPools,
	machineTotals,
	defaultSlots,
	maxSlots,
	preflight,
	slotsHeader,
	waiting
} from './broker.js';
import { brokerDir, poolDir } from './paths.js';

// -- CONSTANTS -- //

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const roomy = { freeDiskBytes: () => 100 * GB, freeMemBytes: () => 64 * 1024 * MB };
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 8000) => {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) throw new Error('timed out waiting for a condition');
		await tick(15);
	}
};

// -- FUNCTIONS -- //

describe('machine broker', () => {
	let home = '';
	let before: string | undefined;
	const children: ReturnType<typeof spawn>[] = [];
	beforeEach(() => {
		before = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-broker-'));
		process.env.AFB_BRIDGE_HOME = home;
	});
	afterEach(() => {
		for (const c of children.splice(0)) c.kill('SIGKILL');
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
	});

	const opts = { deps: roomy, pollMs: 15 };

	it('never holds more slots than there are, with six runs asking at once', async () => {
		let now = 0;
		let max = 0;
		await Promise.all(
			Array.from({ length: 6 }, async (_, i) => {
				const slot = await acquireSlot(
					{ runId: `r${i}`, kind: 'check', registration: `R${i % 3}` },
					{ ...opts, slots: 2 }
				);
				try {
					now++;
					max = Math.max(max, now);
					expect(machineTotals({ slots: 2, deps: roomy }).busy).toBeLessThanOrEqual(2);
					await tick(40);
				} finally {
					now--;
					slot.release();
				}
			})
		);
		expect(max).toBe(2);
		expect(machineTotals({ slots: 2, deps: roomy }).busy).toBe(0);
	});

	it('lets the registration with fewer running slots go first, then the earlier arrival', async () => {
		const first = await acquireSlot(
			{ runId: 'a', kind: 'check', registration: 'X' },
			{ ...opts, slots: 2 }
		);
		const second = await acquireSlot(
			{ runId: 'a2', kind: 'check', registration: 'X' },
			{ ...opts, slots: 2 }
		);
		const order: string[] = [];
		const ask = (runId: string, registration: string) =>
			acquireSlot({ runId, kind: 'check', registration }, { ...opts, slots: 2 }).then(async (s) => {
				order.push(runId);
				await tick(20);
				s.release();
			});
		const p1 = ask('x2', 'X');
		await tick(30);
		const p2 = ask('x3', 'X');
		await tick(30);
		const p3 = ask('y1', 'Y');
		await tick(60);
		first.release();
		await Promise.all([p1, p2, p3]);
		second.release();
		expect(order).toEqual(['y1', 'x2', 'x3']);
	});

	it('waits (and lists the wait) while the disk is low, then goes on when it is free', async () => {
		let disk = 1 * GB;
		const deps = { ...roomy, freeDiskBytes: () => disk };
		const reasons: string[] = [];
		const p = acquireSlot(
			{ runId: 'd', kind: 'check', registration: 'X' },
			{ deps, pollMs: 15, slots: 2, onWait: (i) => reasons.push(i.reason) }
		);
		await until(() => waiting().some((w) => w.runId === 'd' && w.reason === 'DISK_LOW'));
		expect(machineTotals({ slots: 2, deps }).busy).toBe(0);
		disk = 50 * GB;
		const slot = await p;
		expect(reasons).toEqual(['DISK_LOW']);
		expect(waiting()).toEqual([]);
		slot.release();
	});

	it('waits for memory once a run is busy, counting runs that started in the last 90 seconds', async () => {
		let mem = 4000 * MB;
		const deps = { ...roomy, freeMemBytes: () => mem };
		const a = await acquireSlot(
			{ runId: 'a', kind: 'check', registration: 'X' },
			{ deps, pollMs: 15, slots: 3 }
		);
		// one busy and started just now: another needs 1200 x 2 = 2400 MB
		const b = await acquireSlot(
			{ runId: 'b', kind: 'check', registration: 'X' },
			{ deps, pollMs: 15, slots: 3 }
		);
		// two recent: the third needs 1200 x 3 = 3600 MB, and 4000 is enough
		expect(canTake({ slots: 3, deps }).ok).toBe(true);
		mem = 3000 * MB;
		expect(canTake({ slots: 3, deps })).toMatchObject({ ok: false, code: 'MEMORY_LOW' });
		const p = acquireSlot(
			{ runId: 'c', kind: 'check', registration: 'X' },
			{ deps, pollMs: 15, slots: 3 }
		);
		await until(() => waiting().some((w) => w.runId === 'c' && w.reason === 'MEMORY_LOW'));
		mem = 4000 * MB;
		const c = await p;
		for (const s of [a, b, c]) s.release();
	});

	it('does not hold the first run back for memory', () => {
		expect(preflight({ busy: 0, recent: 0, freeDiskBytes: 10 * GB, freeMemBytes: 1 * MB }).ok).toBe(
			true
		);
		expect(preflight({ busy: 0, recent: 0, freeDiskBytes: null, freeMemBytes: 1 * MB }).ok).toBe(
			true
		);
		expect(
			preflight({ busy: 0, recent: 0, freeDiskBytes: 1 * GB, freeMemBytes: 9999 * MB })
		).toMatchObject({
			ok: false,
			code: 'DISK_LOW'
		});
	});

	it('stops waiting when the signal aborts, and leaves no waiter behind', async () => {
		const hold = await acquireSlot(
			{ runId: 'a', kind: 'check', registration: 'X' },
			{ ...opts, slots: 1 }
		);
		const ctl = new AbortController();
		const p = acquireSlot(
			{ runId: 'b', kind: 'check', registration: 'X' },
			{ ...opts, slots: 1, signal: ctl.signal }
		);
		await until(() => waiting().length === 1);
		ctl.abort();
		await expect(p).rejects.toMatchObject({ name: 'AbortError' });
		expect(waiting()).toEqual([]);
		hold.release();
		const again = await acquireSlot(
			{ runId: 'c', kind: 'check', registration: 'X' },
			{ ...opts, slots: 1 }
		);
		again.release();
	});

	it('rejects at once when the signal is already aborted', async () => {
		const ctl = new AbortController();
		ctl.abort();
		await expect(
			acquireSlot(
				{ runId: 'z', kind: 'check', registration: 'X' },
				{ ...opts, slots: 1, signal: ctl.signal }
			)
		).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('release is safe twice and never removes a slot that belongs to somebody else', async () => {
		const a = await acquireSlot(
			{ runId: 'a', kind: 'check', registration: 'X' },
			{ ...opts, slots: 1 }
		);
		a.release();
		const b = await acquireSlot(
			{ runId: 'b', kind: 'check', registration: 'X' },
			{ ...opts, slots: 1 }
		);
		a.release();
		expect(machineTotals({ slots: 1, deps: roomy }).busy).toBe(1);
		b.release();
		expect(machineTotals({ slots: 1, deps: roomy }).busy).toBe(0);
	});

	// A SLOT HELD BY ANOTHER PROCESS. The child writes the slot file in the broker's format and beats it, as a second `check run` would.
	function foreignHolder(): Promise<ReturnType<typeof spawn>> {
		const dir = mkdtempSync(join(tmpdir(), 'afb-broker-child-'));
		const script = join(dir, 'holder.mjs');
		const slotsDir = join(brokerDir(), 'slots');
		mkdirSync(slotsDir, { recursive: true });
		const file = join(slotsDir, 'slot-0.json');
		writeFileSync(
			script,
			[
				"import fs from 'node:fs';",
				`const file = ${JSON.stringify(file)};`,
				'const write = () => {',
				"  const body = { v: 1, index: 0, pid: process.pid, token: 'child', runId: 'c', kind: 'check', registration: 'Z', startedAt: Date.now(), beat: Date.now() };",
				"  try { fs.writeFileSync(file + '.c', JSON.stringify(body)); fs.renameSync(file + '.c', file); } catch {}",
				'};',
				'write(); setInterval(write, 60); console.log("ready");'
			].join('\n')
		);
		const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
		children.push(child);
		return new Promise((resolve, reject) => {
			child.stdout?.once('data', () => resolve(child));
			child.once('error', reject);
		});
	}

	it('respects a slot another process holds, and reclaims it after that process is killed', async () => {
		const child = await foreignHolder();
		expect(machineTotals({ slots: 1, deps: roomy }).busy).toBe(1);
		let got = false;
		const p = acquireSlot(
			{ runId: 'p', kind: 'check', registration: 'X' },
			{ ...opts, slots: 1, staleMs: 600 }
		).then((s) => {
			got = true;
			return s;
		});
		await tick(300);
		expect(got).toBe(false);
		child.kill('SIGKILL');
		const slot = await p;
		expect(got).toBe(true);
		expect(slot.held()).toBe(true);
		slot.release();
	});

	it('reclaims a slot whose heartbeat stopped even when its process looks alive', async () => {
		const child = await foreignHolder();
		const deps = { ...roomy, pidAlive: () => true };
		child.kill('SIGKILL');
		const t0 = Date.now();
		const slot = await acquireSlot(
			{ runId: 'p', kind: 'check', registration: 'X' },
			{ deps, pollMs: 15, slots: 1, staleMs: 400 }
		);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
		slot.release();
	});

	it('answers the slots header with the machine total and finds the pools', async () => {
		const a = await acquireSlot(
			{ runId: 'a', kind: 'check', registration: 'X' },
			{ ...opts, slots: 3 }
		);
		expect(slotsHeader({ slots: 3, deps: roomy })).toBe('3:1');
		a.release();
		expect(slotsHeader({ slots: 3, deps: roomy })).toBe('3:0');
		expect(listPools()).toEqual([]);
		mkdirSync(poolDir(), { recursive: true });
		writeFileSync(join(poolDir(), 'db.json'), JSON.stringify({ container: 'afb-checks-pool-x' }));
		writeFileSync(join(poolDir(), 'broken.json'), '{');
		const pools = listPools();
		expect(pools.map((p) => p.name).sort()).toEqual(['broken', 'db']);
		expect(pools.find((p) => p.name === 'db')?.info).toEqual({ container: 'afb-checks-pool-x' });
	});

	it('takes the slot count from the setting, the environment and the processors', () => {
		const saved = process.env.AFB_CHECKS_MAX_PARALLEL;
		try {
			delete process.env.AFB_CHECKS_MAX_PARALLEL;
			// Nothing set: as many as the processors, at most 8
			expect(maxSlots()).toBe(Math.min(cpus().length, 8));
			expect(defaultSlots()).toBe(Math.min(cpus().length, 8));
			expect(maxSlots(null)).toBe(Math.min(cpus().length, 8));
			expect(maxSlots(1)).toBe(1);
			expect(maxSlots(10_000)).toBe(cpus().length);
			process.env.AFB_CHECKS_MAX_PARALLEL = '100000';
			expect(maxSlots()).toBe(cpus().length);
			delete process.env.AFB_CHECKS_MAX_PARALLEL;
			process.env.AFB_CHECKS_MAX_PARALLEL = '1';
			expect(maxSlots(8)).toBe(1);
			expect(maxSlots()).toBe(1);
			process.env.AFB_CHECKS_MAX_PARALLEL = 'nonsense';
			expect(maxSlots()).toBe(Math.min(cpus().length, 8));
		} finally {
			if (saved === undefined) delete process.env.AFB_CHECKS_MAX_PARALLEL;
			else process.env.AFB_CHECKS_MAX_PARALLEL = saved;
		}
		expect(existsSync(home)).toBe(true);
	});
});
