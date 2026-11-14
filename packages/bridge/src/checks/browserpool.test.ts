// THE BROWSER POOL: KEY LOGIC, REFERENCE COUNTING, IDLE CLOSE, CRASH REPLACEMENT AND DEDICATED BROWSERS WITH A FAKE LAUNCHER (NO REAL BROWSER).
// One opt-in test (AFB_REAL_BROWSER=1) starts the real Chromium and proves the isolation the pool relies on.

// -- DEP-MODULES -- //
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { PLAYWRIGHT_VERSION, loadPlaywright, type BrowserServer } from './browser.js';
import { BrowserPool, browserKey, listBrowserMarkers, sweepBrowserMarkers } from './browserpool.js';
import { poolDir } from './paths.js';

// -- FUNCTIONS -- //

type Fake = BrowserServer & { id: number; closed: boolean; crash(): void };

/** A launcher that makes fake servers and remembers them; no process is started. */
const fakeLauncher = () => {
	const made: Fake[] = [];
	const launcher = async () => {
		let onClose: (() => void) | undefined;
		const server: Fake = {
			id: made.length + 1,
			closed: false,
			wsEndpoint: () => `ws://127.0.0.1:1/fake-${server.id}`,
			close: async () => {
				server.closed = true;
				onClose?.();
			},
			onClose: (cb) => void (onClose = cb),
			crash: () => {
				server.closed = true;
				onClose?.();
			}
		};
		made.push(server);
		return server;
	};
	return { made, launcher };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('browser pool', () => {
	let home = '';
	let before: string | undefined;
	beforeEach(() => {
		before = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-bpool-'));
		process.env.AFB_BRIDGE_HOME = home;
	});
	afterEach(() => {
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
	});

	it('builds the key from the sorted, lower-cased host set and the headed flag', () => {
		expect(browserKey(['B.test', 'a.test', 'b.test'], false)).toBe('headless|a.test,b.test');
		expect(browserKey([], true)).toBe('headed|');
		expect(browserKey(['a.test'], false)).not.toBe(browserKey(['a.test'], true));
	});

	it('shares one browser between runs with the same key and gives another key its own', async () => {
		const { made, launcher } = fakeLauncher();
		const pool = new BrowserPool({ launcher });
		const [a, b] = await Promise.all([
			pool.acquire({ hosts: ['x.test', 'y.test'] }),
			pool.acquire({ hosts: ['y.test', 'x.test'] })
		]);
		const c = await pool.acquire({ hosts: ['x.test'] });
		const d = await pool.acquire({ hosts: ['x.test', 'y.test'], headed: true });
		expect(made).toHaveLength(3);
		expect(a.wsEndpoint()).toBe(b.wsEndpoint());
		expect(new Set([a.wsEndpoint(), c.wsEndpoint(), d.wsEndpoint()]).size).toBe(3);
		await pool.closeAll();
	});

	it('counts references and closes a shared browser only after the idle grace', async () => {
		const { made, launcher } = fakeLauncher();
		const pool = new BrowserPool({ launcher, idleMs: 40 });
		const a = await pool.acquire({ hosts: ['x.test'] });
		const b = await pool.acquire({ hosts: ['x.test'] });
		await a.release();
		await a.release(); // Twice is harmless
		await wait(80);
		expect(made[0].closed).toBe(false); // b still holds it
		await b.release();
		expect(made[0].closed).toBe(false); // Inside the grace
		await wait(100);
		expect(made[0].closed).toBe(true);
		expect(pool.size).toBe(0);
		const again = await pool.acquire({ hosts: ['x.test'] });
		expect(made).toHaveLength(2);
		await again.release();
		await pool.closeAll();
	});

	it('reuses the browser when a run arrives inside the idle grace', async () => {
		const { made, launcher } = fakeLauncher();
		const pool = new BrowserPool({ launcher, idleMs: 200 });
		const a = await pool.acquire({ hosts: [] });
		await a.release();
		const b = await pool.acquire({ hosts: [] });
		await wait(260);
		expect(made).toHaveLength(1);
		expect(made[0].closed).toBe(false);
		await b.release();
		await pool.closeAll();
	});

	it('replaces a crashed browser for the next run and does not fail the other keys', async () => {
		const { made, launcher } = fakeLauncher();
		const pool = new BrowserPool({ launcher });
		const a = await pool.acquire({ hosts: ['a.test'] });
		const other = await pool.acquire({ hosts: ['b.test'] });
		made[0].crash();
		const next = await pool.acquire({ hosts: ['a.test'] });
		expect(made).toHaveLength(3);
		expect(next.wsEndpoint()).not.toBe(a.wsEndpoint());
		expect(made[1].closed).toBe(false); // The other key is untouched
		await a.release(); // The run that held the crashed one just lets go
		await other.release();
		await next.release();
		await pool.closeAll();
	});

	it('gives a dedicated registration its own browser and closes it at release', async () => {
		const { made, launcher } = fakeLauncher();
		const pool = new BrowserPool({ launcher, idleMs: 10_000 });
		const shared = await pool.acquire({ hosts: ['live.test'] });
		const d1 = await pool.acquire({ hosts: ['live.test'], dedicated: true });
		const d2 = await pool.acquire({ hosts: ['live.test'], dedicated: true });
		expect(made).toHaveLength(3);
		expect(d1.wsEndpoint()).not.toBe(d2.wsEndpoint());
		expect(d1.wsEndpoint()).not.toBe(shared.wsEndpoint());
		await d1.release();
		expect(made[1].closed).toBe(true);
		expect(made[0].closed).toBe(false);
		await d2.release();
		await shared.release();
		await pool.closeAll();
	});

	it('fails an acquire whose launch failed and launches again next time', async () => {
		let n = 0;
		const { launcher } = fakeLauncher();
		const pool = new BrowserPool({
			launcher: async () => {
				if (n++ === 0) throw new Error('no chromium');
				return launcher();
			}
		});
		await expect(pool.acquire({ hosts: [] })).rejects.toThrow('no chromium');
		const ok = await pool.acquire({ hosts: [] });
		expect(ok.wsEndpoint()).toContain('fake-');
		await pool.closeAll();
	});

	it('writes a marker with the owner pid and key, and removes it when the browser closes', async () => {
		const { launcher } = fakeLauncher();
		const pool = new BrowserPool({ launcher, idleMs: 0 });
		const lease = await pool.acquire({ hosts: ['m.test'], headed: false });
		const listed = listBrowserMarkers();
		expect(listed).toHaveLength(1);
		expect(listed[0].marker).toMatchObject({
			kind: 'browser',
			pid: process.pid,
			key: 'headless|m.test'
		});
		expect(listed[0].ownerAlive).toBe(true);
		expect(JSON.stringify(listed[0].marker)).not.toContain('ws://');
		await lease.release();
		expect(listBrowserMarkers()).toHaveLength(0);
		expect(existsSync(poolDir())).toBe(true);
	});

	it('sweeps only the markers of a dead owner', async () => {
		const { launcher } = fakeLauncher();
		const pool = new BrowserPool({ launcher });
		const lease = await pool.acquire({ hosts: [] });
		expect(sweepBrowserMarkers()).toBe(0);
		await lease.release();
		await pool.closeAll();
	});

	it('a burst of mockup captures shares one browser and the dedicated lease never does (rule R4)', async () => {
		const { made, launcher } = fakeLauncher();
		const pool = new BrowserPool({ launcher, idleMs: 10_000 });
		const a = await pool.acquire({ hosts: ['mockups.board.test'] });
		const b = await pool.acquire({ hosts: ['mockups.board.test'] });
		expect(made).toHaveLength(1);
		expect(b.wsEndpoint()).toBe(a.wsEndpoint());
		// A dedicated lease (a live site, or saved sign-ins) still forces its own browser
		const d = await pool.acquire({ hosts: ['mockups.board.test'], dedicated: true });
		expect(d.wsEndpoint()).not.toBe(a.wsEndpoint());
		expect(made).toHaveLength(2);
		await d.release();
		expect(made[1].closed).toBe(true);
		expect(made[0].closed).toBe(false);
		await a.release();
		await b.release();
		await pool.closeAll();
		expect(pool.size).toBe(0);
	});

	it('pins the Playwright version in a constant', () => {
		expect(PLAYWRIGHT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

// -- REAL CHROMIUM (OPT IN: AFB_REAL_BROWSER=1) -- //

describe.skipIf(process.env.AFB_REAL_BROWSER !== '1')('browser pool with the real Chromium', () => {
	let home = '';
	let before: string | undefined;
	let web: Server | null = null;
	beforeEach(() => {
		before = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-bpool-real-'));
		process.env.AFB_BRIDGE_HOME = home;
	});
	afterEach(() => {
		web?.close();
		web = null;
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
	});

	const serve = () =>
		new Promise<number>((resolve) => {
			web = createServer((_req, res) => {
				res.setHeader('content-type', 'text/html');
				res.end('<title>ok</title>ok');
			});
			web.listen(0, '127.0.0.1', () => {
				const addr = web?.address();
				resolve(addr && typeof addr === 'object' ? addr.port : 0);
			});
		});

	it('gives a second connection zero contexts and no cookies of another run', async () => {
		const { chromium } = await loadPlaywright();
		const pool = new BrowserPool();
		const lease = await pool.acquire({ hosts: [] });
		const second = await pool.acquire({ hosts: [] });
		expect(second.wsEndpoint()).toBe(lease.wsEndpoint());
		const a = await chromium.connect(lease.wsEndpoint());
		const b = await chromium.connect(second.wsEndpoint());
		try {
			const ctx = await a.newContext();
			await ctx.addCookies([{ name: 'secret', value: 'run-a', url: 'http://127.0.0.1:4999/' }]);
			expect(a.contexts()).toHaveLength(1);
			expect(b.contexts()).toHaveLength(0);
			const mine = await b.newContext();
			expect(await mine.cookies('http://127.0.0.1:4999/')).toEqual([]);
			await mine.close();
			await ctx.close();
		} finally {
			await a.close();
			await b.close();
			await lease.release();
			await second.release();
			await pool.closeAll();
		}
	}, 90_000);

	it('lets a browser reach only the hosts it was launched for', async () => {
		const port = await serve();
		const { chromium } = await loadPlaywright();
		const pool = new BrowserPool();
		const allowed = await pool.acquire({ hosts: ['api.localhost'] });
		const other = await pool.acquire({ hosts: [] });
		expect(allowed.wsEndpoint()).not.toBe(other.wsEndpoint());
		const url = `http://api.localhost:${port}/`;
		const one = await chromium.connect(allowed.wsEndpoint());
		const two = await chromium.connect(other.wsEndpoint());
		try {
			const p1 = await (await one.newContext()).newPage();
			const r1 = await p1.goto(url);
			expect(r1?.status()).toBe(200);
			const p2 = await (await two.newContext()).newPage();
			await expect(p2.goto(url)).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
		} finally {
			await one.close();
			await two.close();
			await allowed.release();
			await other.release();
			await pool.closeAll();
		}
	}, 90_000);
});
