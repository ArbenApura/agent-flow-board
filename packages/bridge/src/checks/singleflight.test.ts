// SINGLE-FLIGHT: ONE BUILDER, WAITERS THAT GET ITS RESULT, A KILLED BUILDER TAKEN OVER AFTER ITS HEARTBEAT STOPS, AN INFRASTRUCTURE FAILURE RETRIED, A DETERMINISTIC ONE SHARED

// IMPORTED DEP-MODULES
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { locksDir } from './paths.js';
import { FlightTimeoutError, InfraError, SharedBuildError, singleFlight } from './singleflight.js';

// -- TYPES -- //

type Gate = { promise: Promise<void>; open(): void };

// -- FUNCTIONS -- //

const gate = (): Gate => {
	let open = () => {};
	const promise = new Promise<void>((resolve) => (open = resolve));
	return { promise, open };
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const fast = { heartbeatMs: 50, staleMs: 400, pollMs: 20 };
/** The stale age of the killed-builder test: long enough that a busy machine never makes a live heartbeat look old, short enough to keep the test short. */
const STALE_MS = 3_000;

describe('single flight', () => {
	let home = '';
	let before: string | undefined;
	const children: ChildProcess[] = [];
	beforeEach(() => {
		before = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-flight-'));
		process.env.AFB_BRIDGE_HOME = home;
	});
	afterEach(() => {
		for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true, maxRetries: 3 });
	});

	const plant = (name: string, body: object) => {
		mkdirSync(locksDir(), { recursive: true });
		writeFileSync(join(locksDir(), `sf-${name}.lock`), JSON.stringify(body) + '\n');
	};

	it('runs the work once and hands its result to the waiters', async () => {
		const g = gate();
		let runs = 0;
		const work = async () => {
			runs++;
			await g.promise;
			return 'key-1';
		};
		const first = singleFlight('one', work, fast);
		await sleep(60);
		const waiters = [singleFlight('one', work, fast), singleFlight('one', work, fast)];
		await sleep(150);
		g.open();
		const all = await Promise.all([first, ...waiters]);
		expect(runs).toBe(1);
		expect(all.map((r) => r.role)).toEqual(['builder', 'waiter', 'waiter']);
		expect(all.map((r) => r.result)).toEqual(['key-1', 'key-1', 'key-1']);
		expect(existsSync(join(locksDir(), 'sf-one.lock'))).toBe(false);
	});

	it('runs the work again for a caller that arrives after the flight ended', async () => {
		let runs = 0;
		const work = async () => ++runs;
		expect((await singleFlight('again', work, fast)).result).toBe(1);
		expect((await singleFlight('again', work, fast)).result).toBe(2);
	});

	it('shares a deterministic failure with every waiter and does not run the work again', async () => {
		const g = gate();
		let runs = 0;
		const work = async (): Promise<string> => {
			runs++;
			await g.promise;
			throw new Error('Type error in app.ts');
		};
		const builder = singleFlight('det', work, fast).catch((e: unknown) => e);
		await sleep(60);
		const waiters = [
			singleFlight('det', work, fast).catch((e: unknown) => e),
			singleFlight('det', work, fast).catch((e: unknown) => e)
		];
		await sleep(150);
		g.open();
		const [b, ...w] = await Promise.all([builder, ...waiters]);
		expect(runs).toBe(1);
		expect((b as Error).message).toBe('Type error in app.ts');
		for (const e of w) {
			expect(e).toBeInstanceOf(SharedBuildError);
			expect((e as Error).message).toBe('Type error in app.ts');
			expect((e as SharedBuildError).originalName).toBe('Error');
		}
	});

	it('lets one waiter build again after an infrastructure failure', async () => {
		const g = gate();
		let runs = 0;
		const work = async () => {
			const n = ++runs;
			if (n === 1) {
				await g.promise;
				throw new InfraError('The disk is full');
			}
			await sleep(100);
			return 'rebuilt';
		};
		const builder = singleFlight('infra', work, fast).catch((e: unknown) => e);
		await sleep(60);
		const waiters = [
			singleFlight('infra', work, fast),
			singleFlight('infra', work, fast),
			singleFlight('infra', work, fast)
		];
		await sleep(150);
		g.open();
		const first = await builder;
		const all = await Promise.all(waiters);
		expect((first as Error).message).toBe('The disk is full');
		expect(runs).toBe(2);
		expect(all.map((r) => r.result)).toEqual(['rebuilt', 'rebuilt', 'rebuilt']);
		expect(all.filter((r) => r.role === 'builder')).toHaveLength(1);
		expect(all.filter((r) => r.role === 'waiter')).toHaveLength(2);
	});

	it('also treats a plain error object marked infra as an infrastructure failure', async () => {
		let runs = 0;
		const work = async () => {
			if (++runs === 1) throw Object.assign(new Error('ECONNRESET'), { infra: true });
			return 'ok';
		};
		await expect(singleFlight('mark', work, fast)).rejects.toThrow('ECONNRESET');
		expect((await singleFlight('mark', work, fast)).result).toBe('ok');
	});

	it("applies the waiter's own limit", async () => {
		const g = gate();
		const builder = singleFlight('limit', async () => (await g.promise, 'done'), fast);
		await sleep(60);
		await expect(
			singleFlight('limit', async () => 'never', { ...fast, waiterLimitMs: 200 })
		).rejects.toBeInstanceOf(FlightTimeoutError);
		g.open();
		expect((await builder).result).toBe('done');
	});

	it('takes over a lock whose heartbeat is missing even when its process id is alive', async () => {
		plant('pid-alive', {
			pid: process.pid,
			start: new Date().toISOString(),
			beat: new Date(Date.now() - 60_000).toISOString(),
			token: 'old'
		});
		const r = await singleFlight('pid-alive', async () => 'mine', fast);
		expect(r).toEqual({ role: 'builder', result: 'mine' });
	});

	it('does not take over a fresh heartbeat even when its process id is dead', async () => {
		plant('pid-dead', {
			pid: 2_147_483_000,
			start: new Date().toISOString(),
			beat: new Date(Date.now() + 60_000).toISOString(),
			token: 'live'
		});
		await expect(
			singleFlight('pid-dead', async () => 'mine', { ...fast, waiterLimitMs: 300 })
		).rejects.toBeInstanceOf(FlightTimeoutError);
	});

	it('keeps the heartbeat going on a long build so a waiter does not steal it', async () => {
		const g = gate();
		let stolen = 0;
		// A stale window much longer than a heartbeat, so a busy machine that delays the timer by a few hundred milliseconds cannot look like a dead builder
		const loaded = { ...fast, staleMs: 1_500 };
		const builder = singleFlight('long', async () => (await g.promise, 'built'), loaded);
		await sleep(50);
		const waiter = singleFlight(
			'long',
			async () => {
				stolen++;
				return 'stolen';
			},
			loaded
		);
		await sleep(3_600); // More than twice the stale window
		g.open();
		expect((await waiter).result).toBe('built');
		expect((await builder).role).toBe('builder');
		expect(stolen).toBe(0);
	});

	it('lets a waiter take over after the builder process is killed hard', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'afb-flight-child-'));
		try {
			const entry = join(dir, 'entry.ts');
			const ready = join(dir, 'ready.txt');
			const src = join(process.cwd(), 'packages', 'bridge', 'src', 'checks', 'singleflight.ts');
			writeFileSync(
				entry,
				[
					`import { writeFileSync } from 'node:fs';`,
					`import { singleFlight } from ${JSON.stringify(src.replace(/\\/g, '/'))};`,
					`setInterval(() => {}, 1000);`,
					`await singleFlight('crash', async () => {`,
					`  writeFileSync(${JSON.stringify(ready.replace(/\\/g, '/'))}, 'ready');`,
					`  await new Promise(() => {});`,
					`}, { heartbeatMs: 50, staleMs: ${STALE_MS}, pollMs: 20 });`
				].join('\n')
			);
			const out = join(dir, 'child.mjs');
			await build({
				entryPoints: [entry],
				outfile: out,
				bundle: true,
				platform: 'node',
				format: 'esm',
				logLevel: 'silent'
			});
			const child = spawn(process.execPath, [out], { stdio: 'ignore', windowsHide: true });
			children.push(child);
			for (let i = 0; i < 100 && !existsSync(ready); i++) await sleep(100);
			expect(existsSync(ready)).toBe(true);

			let runs = 0;
			const waiter = singleFlight(
				'crash',
				async () => {
					runs++;
					return 'taken over';
				},
				{ ...fast, staleMs: STALE_MS }
			);
			// While the child lives its heartbeat keeps the lock fresh for longer than the stale age, so the waiter just waits
			await sleep(STALE_MS + 1_000);
			expect(runs).toBe(0);
			const killedAt = Date.now();
			child.kill('SIGKILL');
			const r = await waiter;
			expect(r).toEqual({ role: 'builder', result: 'taken over' });
			expect(runs).toBe(1);
			// It takes over once the heartbeat has been missing for the stale age, with a wide margin for a slow machine
			expect(Date.now() - killedAt).toBeLessThan(STALE_MS * 4);
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
		}
	}, 60_000);

	it('refuses a name that is not plain', async () => {
		await expect(singleFlight('../x', async () => 1, fast)).rejects.toThrow(/plain name/);
	});
});
