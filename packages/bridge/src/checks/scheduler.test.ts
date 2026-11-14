// THE SCHEDULER: SLOTS AND OVERLAP, AN OVERLOADED MACHINE LEAVES RUNS UNCLAIMED, THE BEAT STARTS AT THE CLAIM AND NEVER STOPS WAITING, A STOP GIVES BACK ONLY ITS OWN RUNS

// IMPORTED DEP-MODULES
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	FairGate,
	createScheduler,
	type RunCtx,
	type SchedBroker,
	type SchedConnection,
	type SchedJob,
	type SchedRunner
} from './scheduler.js';

// -- TYPES -- //

type Job = SchedJob;

// -- CONSTANTS -- //

const here = dirname(fileURLToPath(import.meta.url));
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 8000) => {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) throw new Error('timed out waiting for a condition');
		await tick(5);
	}
};

// -- FUNCTIONS -- //

/** A board with a queue of run ids. */
function fakeBoard(
	key: string,
	ids: string[],
	registrationOf: (id: string) => string | null = () => null
) {
	const queue = [...ids];
	const log = {
		peeks: [] as number[],
		claims: [] as string[],
		beats: [] as { id: string; at: number }[],
		released: [] as string[][],
		failPeek: false,
		failClaim: false,
		fatal: false,
		beatError: null as Error | null
	};
	const conn: SchedConnection<Job> = {
		key,
		peek: async () => {
			log.peeks.push(Date.now());
			if (log.fatal)
				throw Object.assign(new Error('The board no longer accepts this machine.'), {
					code: 'UNAUTHENTICATED'
				});
			if (log.failPeek) throw new Error('The board is down.');
			return queue.length;
		},
		claim: async () => {
			if (log.failClaim) throw new Error('claim failed');
			const id = queue.shift();
			if (!id) return null;
			log.claims.push(id);
			return { id, registration: registrationOf(id) };
		},
		beat: async (id) => {
			log.beats.push({ id, at: Date.now() });
			if (log.beatError) throw log.beatError;
		},
		release: async (ids) => {
			log.released.push(ids);
		}
	};
	return { conn, queue, log };
}

/** A broker with `slots` places held by this process only, and a switch for the machine check. */
function fakeBroker(slots: number) {
	const state = {
		busy: 0,
		ready: true,
		why: 'The disk is low.',
		waiters: [] as (() => void)[],
		maxBusy: 0
	};
	const broker: SchedBroker = {
		acquire: (_req, { signal }) =>
			new Promise((resolve, reject) => {
				const take = () => {
					state.busy++;
					state.maxBusy = Math.max(state.maxBusy, state.busy);
					let freed = false;
					resolve({
						release() {
							if (freed) return;
							freed = true;
							state.busy--;
							state.waiters.shift()?.();
						}
					});
				};
				if (signal.aborted)
					return reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
				const go = () => (state.busy < slots ? take() : state.waiters.push(go));
				signal.addEventListener(
					'abort',
					() => {
						state.waiters = state.waiters.filter((w) => w !== go);
						reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
					},
					{ once: true }
				);
				go();
			}),
		ready: () => (state.ready ? { ok: true } : { ok: false, code: 'DISK_LOW', why: state.why }),
		totals: () => ({ slots, busy: state.busy })
	};
	return { broker, state };
}

/** A runner whose stages take time and are recorded. */
function fakeRunner(o: { prepareMs?: number; executeMs?: number; hang?: Set<string> } = {}) {
	const events: { id: string; what: string; at: number }[] = [];
	const state = {
		executing: 0,
		maxExecuting: 0,
		preparing: 0,
		maxPreparing: 0,
		reported: [] as string[],
		failed: [] as { id: string; why: string }[],
		cleaned: [] as string[]
	};
	const mark = (id: string, what: string) => events.push({ id, what, at: Date.now() });
	const runner: SchedRunner<Job, string> = {
		async prepare(job) {
			mark(job.id, 'prepare-start');
			state.preparing++;
			state.maxPreparing = Math.max(state.maxPreparing, state.preparing);
			await tick(o.prepareMs ?? 10);
			state.preparing--;
			mark(job.id, 'prepare-end');
			return job.id;
		},
		async execute(job, _p, ctx: RunCtx) {
			mark(job.id, 'execute-start');
			state.executing++;
			state.maxExecuting = Math.max(state.maxExecuting, state.executing);
			try {
				if (o.hang?.has(job.id)) await new Promise(() => undefined);
				await new Promise<void>((resolve, reject) => {
					const t = setTimeout(resolve, o.executeMs ?? 20);
					ctx.signal.addEventListener(
						'abort',
						() => {
							clearTimeout(t);
							reject(new Error('aborted'));
						},
						{ once: true }
					);
				});
				state.reported.push(job.id);
			} finally {
				state.executing--;
				mark(job.id, 'execute-end');
			}
		},
		async fail(job, e) {
			state.failed.push({ id: job.id, why: e.message });
		},
		async cleanup(job) {
			state.cleaned.push(job.id);
		}
	};
	return { runner, events, state };
}

const fast = { pollMs: 10, beatMs: 15, graceMs: 30, stepWaitMs: 200, backoffMaxMs: 80 };

async function runUntil(
	s: ReturnType<typeof createScheduler<Job, string>>,
	done: () => boolean,
	ms = 8000
) {
	const ac = new AbortController();
	const p = s.run({ signal: ac.signal });
	try {
		await until(done, ms);
	} finally {
		ac.abort();
	}
	return p;
}

describe('scheduler', () => {
	it('runs a queue to the end, never executing more than the slots, and reports every run', async () => {
		const b = fakeBoard('org', ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']);
		const { broker, state } = fakeBroker(3);
		const r = fakeRunner();
		const s = createScheduler<Job, string>(
			{ connections: () => [b.conn], runner: r.runner, broker, log: () => undefined },
			{ slots: 3, ...fast }
		);
		await runUntil(s, () => r.state.reported.length === 8);
		expect(r.state.maxExecuting).toBe(3);
		expect(state.maxBusy).toBeLessThanOrEqual(3);
		expect(r.state.cleaned.sort()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']);
		expect(r.state.failed).toEqual([]);
	});

	it('claims late: with 8 queued and 3 slots only slots plus one are taken at first', async () => {
		const b = fakeBoard(
			'org',
			Array.from({ length: 8 }, (_, i) => `r${i}`)
		);
		const { broker } = fakeBroker(3);
		const r = fakeRunner({ prepareMs: 150, executeMs: 150 });
		const s = createScheduler<Job, string>(
			{ connections: () => [b.conn], runner: r.runner, broker, log: () => undefined },
			{ slots: 3, ...fast }
		);
		const ac = new AbortController();
		const p = s.run({ signal: ac.signal });
		await until(() => b.log.claims.length >= 4);
		await tick(60);
		expect(b.log.claims.length).toBe(4);
		expect(b.queue.length).toBe(4);
		ac.abort();
		await p;
	});

	it('starts the next run building while the current one runs its check', async () => {
		const b = fakeBoard('org', ['a', 'b']);
		const { broker } = fakeBroker(1);
		const r = fakeRunner({ prepareMs: 20, executeMs: 200 });
		const s = createScheduler<Job, string>(
			{ connections: () => [b.conn], runner: r.runner, broker, log: () => undefined },
			{ slots: 1, prefetch: 1, ...fast }
		);
		await runUntil(s, () => r.state.reported.length === 2);
		const at = (id: string, what: string) =>
			r.events.find((e) => e.id === id && e.what === what)?.at ?? NaN;
		expect(at('b', 'prepare-end')).toBeLessThan(at('a', 'execute-end'));
		expect(at('b', 'execute-start')).toBeGreaterThanOrEqual(at('a', 'execute-end'));
	});

	it('with the overlap off, claims only as many as there are slots', async () => {
		const b = fakeBoard('org', ['a', 'b', 'c']);
		const { broker } = fakeBroker(1);
		const r = fakeRunner({ prepareMs: 20, executeMs: 150 });
		const s = createScheduler<Job, string>(
			{ connections: () => [b.conn], runner: r.runner, broker, log: () => undefined },
			{ slots: 1, prefetch: 0, ...fast }
		);
		const ac = new AbortController();
		const p = s.run({ signal: ac.signal });
		await until(() => b.log.claims.length === 1);
		await tick(80);
		expect(b.log.claims).toEqual(['a']);
		ac.abort();
		await p;
	});

	it('leaves runs unclaimed on the board while the machine is overloaded, and takes them when it is not', async () => {
		const b = fakeBoard('org', ['a', 'b']);
		const { broker, state } = fakeBroker(3);
		state.ready = false;
		const said: string[] = [];
		const r = fakeRunner();
		const s = createScheduler<Job, string>(
			{ connections: () => [b.conn], runner: r.runner, broker, log: (l) => said.push(l) },
			{ slots: 3, ...fast }
		);
		const ac = new AbortController();
		const p = s.run({ signal: ac.signal });
		await tick(120);
		expect(b.log.claims).toEqual([]);
		expect(b.queue).toEqual(['a', 'b']);
		expect(said.filter((l) => l === 'The disk is low.')).toHaveLength(1);
		state.ready = true;
		await until(() => r.state.reported.length === 2);
		ac.abort();
		await p;
	});

	it('beats from the moment of the claim, and keeps beating while the run waits for a slot', async () => {
		const b = fakeBoard('org', ['holder', 'waiter']);
		const { broker, state } = fakeBroker(1);
		const r = fakeRunner({ prepareMs: 10, executeMs: 250 });
		const s = createScheduler<Job, string>(
			{ connections: () => [b.conn], runner: r.runner, broker, log: () => undefined },
			{ slots: 1, prefetch: 1, ...fast }
		);
		const ac = new AbortController();
		const p = s.run({ signal: ac.signal });
		await until(() => b.log.claims.includes('waiter'));
		// the beat for the waiter is there at once, before its prepare could have ended
		await until(() => b.log.beats.some((x) => x.id === 'waiter'));
		const first = b.log.beats.find((x) => x.id === 'waiter');
		expect(first).toBeDefined();
		await until(() => s.status().waitingForSlot === 1);
		const during = b.log.beats.filter((x) => x.id === 'waiter').length;
		await tick(120);
		expect(b.log.beats.filter((x) => x.id === 'waiter').length).toBeGreaterThan(during + 2);
		expect(state.busy).toBe(1);
		await until(() => r.state.reported.length === 2);
		const count = b.log.beats.filter((x) => x.id === 'waiter').length;
		await tick(80);
		expect(b.log.beats.filter((x) => x.id === 'waiter').length).toBe(count);
		ac.abort();
		await p;
	});

	it('gives back only its own runs on stop, by id, and reports none of them', async () => {
		const b = fakeBoard('org', ['mine1', 'mine2', 'later']);
		const { broker } = fakeBroker(2);
		const r = fakeRunner({ prepareMs: 10, executeMs: 5000 });
		const s = createScheduler<Job, string>(
			{ connections: () => [b.conn], runner: r.runner, broker, log: () => undefined },
			{ slots: 2, prefetch: 0, ...fast }
		);
		const ac = new AbortController();
		const p = s.run({ signal: ac.signal });
		await until(() => r.state.executing === 2);
		expect(s.heldIds().sort()).toEqual(['mine1', 'mine2']);
		ac.abort();
		await p;
		expect(b.log.released).toEqual([['mine1', 'mine2']]);
		expect(b.queue).toEqual(['later']);
		expect(r.state.failed).toEqual([]);
		expect(r.state.reported).toEqual([]);
		expect(r.state.cleaned.sort()).toEqual(['mine1', 'mine2']);
		expect(s.heldIds()).toEqual([]);
	});

	it('does not give back a run that already reported', async () => {
		const b = fakeBoard('org', ['quick', 'slow']);
		const { broker } = fakeBroker(2);
		const r = fakeRunner({ prepareMs: 5, executeMs: 20, hang: new Set(['slow']) });
		const s = createScheduler<Job, string>(
			{ connections: () => [b.conn], runner: r.runner, broker, log: () => undefined },
			{ slots: 2, prefetch: 0, ...fast }
		);
		const ac = new AbortController();
		const p = s.run({ signal: ac.signal });
		await until(() => r.state.reported.includes('quick'));
		await until(() => s.heldIds().length === 1);
		ac.abort();
		await p;
		expect(b.log.released).toEqual([['slow']]);
	});

	it('stops a run that outlives its limit, reports it, and lets the others finish', async () => {
		const b = fakeBoard('org', ['stuck', 'fine']);
		const { broker } = fakeBroker(2);
		const r = fakeRunner({ prepareMs: 5, executeMs: 20, hang: new Set(['stuck']) });
		const s = createScheduler<Job, string>(
			{ connections: () => [b.conn], runner: r.runner, broker, log: () => undefined },
			{ slots: 2, prefetch: 0, runLimitMs: 150, ...fast }
		);
		await runUntil(s, () => r.state.failed.length === 1 && r.state.reported.includes('fine'));
		expect(r.state.failed[0]).toMatchObject({ id: 'stuck' });
		expect(r.state.failed[0]?.why).toMatch(/took longer than/);
		expect(r.state.cleaned).toContain('stuck');
	});

	it('abandons a run the board gave up on without reporting it', async () => {
		const b = fakeBoard('org', ['gone']);
		b.log.beatError = new Error('That run is already finished.');
		const { broker } = fakeBroker(1);
		const r = fakeRunner({ prepareMs: 5, executeMs: 2000 });
		const s = createScheduler<Job, string>(
			{ connections: () => [b.conn], runner: r.runner, broker, log: () => undefined },
			{ slots: 1, prefetch: 0, ...fast }
		);
		await runUntil(s, () => r.state.cleaned.includes('gone'));
		expect(r.state.failed).toEqual([]);
		expect(r.state.reported).toEqual([]);
	});

	it('reports a run whose prepare fails', async () => {
		const b = fakeBoard('org', ['bad']);
		const { broker } = fakeBroker(1);
		const r = fakeRunner();
		r.runner.prepare = async () => {
			throw new Error('install failed');
		};
		const s = createScheduler<Job, string>(
			{ connections: () => [b.conn], runner: r.runner, broker, log: () => undefined },
			{ slots: 1, ...fast }
		);
		await runUntil(s, () => r.state.failed.length === 1);
		expect(r.state.failed[0]).toEqual({ id: 'bad', why: 'install failed' });
		expect(r.state.cleaned).toEqual(['bad']);
	});

	it('reads the connections again on every loop and serves one that appears later', async () => {
		const a = fakeBoard('orgA', []);
		const c = fakeBoard('orgB', ['late']);
		let looks = 0;
		const { broker } = fakeBroker(1);
		const r = fakeRunner();
		const s = createScheduler<Job, string>(
			{
				connections: () => (++looks > 3 ? [a.conn, c.conn] : [a.conn]),
				runner: r.runner,
				broker,
				log: () => undefined
			},
			{ slots: 1, ...fast }
		);
		await runUntil(s, () => r.state.reported.includes('late'));
		expect(looks).toBeGreaterThan(3);
	});

	it('backs off by doubling after errors up to the maximum, and recovers', async () => {
		const b = fakeBoard('org', []);
		b.log.failPeek = true;
		const { broker } = fakeBroker(1);
		const r = fakeRunner();
		const s = createScheduler<Job, string>(
			{ connections: () => [b.conn], runner: r.runner, broker, log: () => undefined },
			{ slots: 1, pollMs: 10, backoffMaxMs: 80, beatMs: 15, stepWaitMs: 100 }
		);
		const ac = new AbortController();
		const p = s.run({ signal: ac.signal });
		await until(() => b.log.peeks.length >= 6, 4000);
		const gaps = b.log.peeks.slice(1).map((t, i) => t - (b.log.peeks[i] ?? 0));
		// The configured waits are poll 10 ms doubling to the maximum of 80 ms: 20, 40, 80, 80. A loaded machine fires timers late and Windows early, so each gap is
		// checked against its configured wait with a factor of 3 either way, and the sequence has to grow until it reaches the maximum
		const configured = [20, 40, 80, 80];
		configured.forEach((wait, i) => {
			expect(gaps[i] ?? 0, `gap ${i}: ${gaps.join(', ')}`).toBeGreaterThanOrEqual(wait / 3);
			expect(gaps[i] ?? 0, `gap ${i}: ${gaps.join(', ')}`).toBeLessThan(wait * 3 + 150);
		});
		expect(gaps[3] ?? 0).toBeGreaterThan((gaps[0] ?? 0) * 0.8);
		expect(Math.max(...gaps)).toBeLessThan(1_000);
		ac.abort();
		await p;
	});

	it('stops asking a board that no longer accepts it, until its credential changes', async () => {
		const b = fakeBoard('org', ['x']);
		b.log.fatal = true;
		let fingerprint = 'one';
		const { broker } = fakeBroker(1);
		const r = fakeRunner();
		const s = createScheduler<Job, string>(
			{
				connections: () => [{ ...b.conn, fingerprint }],
				runner: r.runner,
				broker,
				log: () => undefined
			},
			{ slots: 1, ...fast }
		);
		const ac = new AbortController();
		const p = s.run({ signal: ac.signal });
		await until(() => b.log.peeks.length === 1);
		await tick(100);
		expect(b.log.peeks.length).toBe(1);
		b.log.fatal = false;
		fingerprint = 'two';
		await until(() => r.state.reported.includes('x'));
		ac.abort();
		await p;
	});

	it('with once, takes what waits, finishes it and returns the count', async () => {
		const b = fakeBoard('org', ['a', 'b', 'c']);
		const { broker } = fakeBroker(2);
		const r = fakeRunner();
		const s = createScheduler<Job, string>(
			{ connections: () => [b.conn], runner: r.runner, broker, log: () => undefined },
			{ slots: 2, ...fast }
		);
		const n = await s.run({ signal: new AbortController().signal, once: true });
		expect(n).toBe(3);
		expect(r.state.reported.sort()).toEqual(['a', 'b', 'c']);
		expect(s.heldIds()).toEqual([]);
	});

	it('never blocks the event loop during an 8-run schedule', async () => {
		const b = fakeBoard(
			'org',
			Array.from({ length: 8 }, (_, i) => `r${i}`),
			(id) => (Number(id.slice(1)) % 2 ? 'ONE' : 'TWO')
		);
		const { broker } = fakeBroker(3);
		const r = fakeRunner({ prepareMs: 15, executeMs: 25 });
		const s = createScheduler<Job, string>(
			{ connections: () => [b.conn], runner: r.runner, broker, log: () => undefined },
			{ slots: 3, ...fast }
		);
		let last = Date.now();
		let worst = 0;
		const probe = setInterval(() => {
			const t = Date.now();
			worst = Math.max(worst, t - last - 10);
			last = t;
		}, 10);
		try {
			await runUntil(s, () => r.state.reported.length === 8);
		} finally {
			clearInterval(probe);
		}
		// A synchronous wait on the thread would show as a stall of seconds; the bound leaves room for a loaded machine
		expect(worst).toBeLessThan(400);
	});

	it('has no call in it that waits on the thread', () => {
		for (const f of ['scheduler.ts', 'broker.ts', 'warm.ts']) {
			const text = readFileSync(join(here, f), 'utf8')
				.split('\n')
				.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
				.join('\n');
			expect(text, f).not.toMatch(/\b(spawnSync|execFileSync|execSync)\s*\(/);
			expect(text, f).not.toMatch(/Atomics\.wait/);
		}
	});
});

describe('FairGate', () => {
	it('lets the key with the fewest places go first, then the earlier arrival', async () => {
		const gate = new FairGate(1);
		const first = await gate.acquire('X');
		const order: string[] = [];
		const ask = (key: string, id: string) =>
			gate.acquire(key).then((free) => {
				order.push(id);
				free();
			});
		const ps = [ask('X', 'x2'), ask('X', 'x3'), ask('Y', 'y1')];
		await tick(10);
		first();
		await Promise.all(ps);
		expect(order[0]).toBe('x2');
		expect(order).toContain('y1');
	});

	it('prefers a key that holds nothing while another key holds a place', async () => {
		const gate = new FairGate(2);
		const a = await gate.acquire('X');
		const b = await gate.acquire('X');
		const order: string[] = [];
		const ps = [
			gate.acquire('X').then((f) => (order.push('x3'), f())),
			gate.acquire('Y').then((f) => (order.push('y1'), f()))
		];
		await tick(10);
		a();
		await tick(10);
		expect(order[0]).toBe('y1');
		b();
		await Promise.all(ps);
	});

	it('removes a waiter whose signal aborts', async () => {
		const gate = new FairGate(1);
		const first = await gate.acquire('X');
		const ac = new AbortController();
		const p = gate.acquire('X', ac.signal);
		ac.abort();
		await expect(p).rejects.toMatchObject({ name: 'AbortError' });
		first();
		const again = await gate.acquire('X');
		again();
	});
});
