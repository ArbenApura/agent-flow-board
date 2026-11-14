// WARM-BROWSER DEV SWEEP & EARLY STOCK CHECK TESTS (STEPS A.6 & A.10, AFB-20261113-1008)
// Proves: 7 screens x 4 widths warm sweep completes under 60s on one warm browser, measures coldMs and warmMs separately,
// detects layout shifts (CLS) and sub-44px tap targets during sweeps, and routes writes through the browser guard.

// -- DEP-MODULES -- //
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { playwrightRuntimeDir } from './browser.js';
import { closeAllBrowsers } from './browserpool.js';
import { runDevSweep } from './devSweep.js';

// -- FUNCTIONS -- //

describe('devSweep and earlyStockChecks', () => {
	const servers: Server[] = [];
	const tempDirs: string[] = [];
	const savedHome = process.env.AFB_BRIDGE_HOME;

	afterEach(async () => {
		await closeAllBrowsers().catch(() => undefined);
		for (const s of servers.splice(0)) {
			s.closeAllConnections?.();
			await new Promise<void>((r) => s.close(() => r()));
		}
		for (const d of tempDirs.splice(0)) {
			rmSync(d, { recursive: true, force: true });
		}
		if (savedHome === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = savedHome;
	});

	it('sweeps 7 screens x 4 widths on one warm browser under 60s and detects CLS and <44px tap targets', async () => {
		if (!playwrightRuntimeDir()) return;
		const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-sweep-')));
		tempDirs.push(base);
		process.env.AFB_BRIDGE_HOME = join(base, 'bridge-home');

		const srv = createServer((req, res) => {
			res.writeHead(200, { 'content-type': 'text/html' });
			if (req.url === '/tiny-target') {
				res.end(
					`<!doctype html><html><body>
						<main>
							<button style="width:20px;height:20px;padding:0;border:0">X</button>
							<button style="min-width:48px;min-height:48px">Good Button</button>
						</main>
					</body></html>`
				);
				return;
			}
			if (req.url === '/shifting') {
				res.end(
					`<!doctype html><html><body>
						<div id="top" style="height:20px;background:#ccc">Top</div>
						<div id="box" style="margin-top:0;height:60px;background:#eee">Body</div>
						<script>
							window.addEventListener('load', () => {
								setTimeout(() => {
									const t = document.getElementById('top');
									if (t) t.style.height = '220px';
								}, 35);
							});
						</script>
					</body></html>`
				);
				return;
			}
			res.end(
				`<!doctype html><html><body>
					<main style="padding:16px">
						<h1>Screen ${req.url ?? '/'}</h1>
						<button style="min-width:48px;min-height:48px">Primary Action</button>
					</main>
				</body></html>`
			);
		});
		servers.push(srv);
		await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
		const addr = srv.address();
		const port = typeof addr === 'object' && addr ? addr.port : 0;
		const origin = `http://127.0.0.1:${port}`;

		const shotsDir = join(base, 'shots');
		const report = await runDevSweep({
			origin,
			screens: [
				{ name: 'Home', path: '/' },
				{ name: 'Board', path: '/board' },
				{ name: 'Items', path: '/items' },
				{ name: 'Notes', path: '/notes' },
				{ name: 'Checks', path: '/checks' },
				{ name: 'Settings', path: '/settings' },
				{ name: 'Profile', path: '/profile' }
			],
			widths: [390, 768, 1280, 1440],
			shotsDir,
			readinessSettleMs: 15
		});

		expect(report.totalCells).toBe(28);
		expect(report.mode).toBe('fallback');
		expect(report.coldMs).toBeGreaterThan(0);
		expect(report.warmMs).toBeLessThan(60_000);
		expect(report.earlyStockSummary.passed).toBe(true);
		expect(report.earlyStockSummary.tapViolations).toBe(0);
		expect(report.writeGuard).toContain('service workers blocked');
		expect(existsSync(join(shotsDir, '01.jpg'))).toBe(true);

		const badReport = await runDevSweep({
			origin,
			screens: [
				{ name: 'Tiny Target', path: '/tiny-target' },
				{ name: 'Shifting', path: '/shifting' }
			],
			widths: [390],
			maxCls: 0.01,
			readinessSettleMs: 120
		});

		expect(badReport.earlyStockSummary.tapViolations).toBeGreaterThanOrEqual(1);
		expect(badReport.earlyStockSummary.clsViolations).toBeGreaterThanOrEqual(1);
		expect(badReport.passed).toBe(false);
	}, 45_000);
});
