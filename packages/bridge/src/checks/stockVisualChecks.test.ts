// TESTS FOR VERSIONED STOCK VISUAL CHECKS (STEP E.1, AFB-20261113-1008)

// -- DEP-MODULES -- //
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { playwrightRuntimeDir } from './browser.js';
import { closeAllBrowsers, acquireBrowser } from './browserpool.js';
import {
	EARLY_CLS_INIT_SCRIPT,
	STOCK_VISUAL_CHECKS_VERSION,
	evaluateSkeletonHeight,
	filterConsoleErrors,
	formatStockVisualReport,
	parseCssColor,
	runStockVisualChecks,
	wcagContrastRatio,
	type VisualCheckPageLike
} from './stockVisualChecks.js';

// -- FUNCTIONS -- //

function fakePage(probe: {
	cls: number;
	overflowPx?: number;
	smallButtons?: number;
	defaultChrome?: number;
	lowContrast?: number;
	focusOk?: boolean;
	reducedOk?: boolean;
	loadedHeightPx?: number;
}): VisualCheckPageLike {
	let call = 0;
	return {
		async evaluate<T>(): Promise<T> {
			call++;
			// First call comes from measureEarlyStockChecks
			if (call === 1) {
				const count = probe.smallButtons ?? 0;
				return {
					score: probe.cls,
					shifts: probe.cls > 0 ? 1 : 0,
					total: 4,
					violations: Array.from({ length: count }, (_, i) => ({
						tag: 'button',
						text: `btn-${i}`,
						width: 28,
						height: 28,
						viewportWidth: 390
					}))
				} as unknown as T;
			}
			// Second call comes from runStockVisualChecks domProbe
			const ov = probe.overflowPx ?? 0;
			return {
				sidewaysScroll: {
					scrollWidth: 390 + ov,
					innerWidth: 390,
					overflowPx: ov,
					passed: ov === 0
				},
				buttonChromeViolations: Array.from({ length: probe.defaultChrome ?? 0 }, (_, i) => ({
					tag: 'button',
					text: `raw-${i}`,
					appearance: 'button',
					background: 'rgb(239, 239, 239)'
				})),
				contrastViolations: Array.from({ length: probe.lowContrast ?? 0 }, (_, i) => ({
					tag: 'p',
					text: `low-${i}`,
					ratio: 2.1,
					required: 4.5,
					fg: 'rgb(180, 180, 180)',
					bg: 'rgb(255, 255, 255)'
				})),
				focusVisibleOk: probe.focusOk ?? true,
				focusReason: probe.focusOk === false ? 'No focus ring detected' : 'Outline 2px',
				reducedMotionSupported: probe.reducedOk ?? true,
				unboundedTransitions: probe.reducedOk === false ? 2 : 0,
				measuredLoadedHeightPx: probe.loadedHeightPx ?? 640
			} as unknown as T;
		}
	};
}

// -- TESTS -- //

describe('stockVisualChecks (E.1)', () => {
	it('computes WCAG contrast ratios accurately', () => {
		expect(parseCssColor('#fff')).toEqual([255, 255, 255, 1]);
		expect(parseCssColor('rgba(17, 24, 39, 1)')).toEqual([17, 24, 39, 1]);
		expect(wcagContrastRatio([0, 0, 0], [255, 255, 255])).toBe(21);
		expect(wcagContrastRatio([180, 180, 180], [255, 255, 255])).toBeLessThan(3);
	});

	it('evaluates skeleton vs loaded height tolerances cleanly', () => {
		expect(evaluateSkeletonHeight(500, 540, 0.25).passed).toBe(true);
		const shifted = evaluateSkeletonHeight(200, 600, 0.25);
		expect(shifted.passed).toBe(false);
		expect(shifted.summary).toContain('shifted');
	});

	it('filters allowed console warnings without dropping real errors', () => {
		const kept = filterConsoleErrors(
			['Warning: benign hydration hint', 'TypeError: cannot read properties of undefined'],
			['benign hydration']
		);
		expect(kept).toEqual(['TypeError: cannot read properties of undefined']);
	});

	it('passes all 9 versioned visual checks when measurements meet tolerances', async () => {
		const report = await runStockVisualChecks(fakePage({ cls: 0.01, loadedHeightPx: 500 }), {
			screen: 'board',
			state: 'loaded',
			width: 1280,
			skeletonHeightPx: 480,
			consoleErrors: []
		});
		expect(report.version).toBe(STOCK_VISUAL_CHECKS_VERSION);
		expect(report.passed).toBe(true);
		expect(Object.keys(report.checks)).toHaveLength(9);
		const text = formatStockVisualReport(report).join('\n');
		expect(text).toContain('board/loaded@1280px - PASS');
	});

	it('reports parameterised failures clearly per check category', async () => {
		const report = await runStockVisualChecks(
			fakePage({
				cls: 0.22,
				overflowPx: 48,
				smallButtons: 1,
				defaultChrome: 1,
				lowContrast: 1,
				focusOk: false,
				reducedOk: false,
				loadedHeightPx: 900
			}),
			{
				screen: 'settings',
				state: 'error',
				width: 390,
				maxCls: 0.05,
				skeletonHeightPx: 300,
				consoleErrors: ['Unhandled rejection in fetch']
			}
		);
		expect(report.passed).toBe(false);
		for (const key of Object.keys(report.checks) as Array<keyof typeof report.checks>) {
			expect(report.checks[key].passed, key).toBe(false);
		}
		const formatted = formatStockVisualReport(report).join('\n');
		expect(formatted).toContain('settings/error@390px - FAIL');
		expect(formatted).toContain('[FAIL] contrast-pairs');
		expect(formatted).toContain('[FAIL] console-errors');
	});

	it('executes the real DOM probe against Chromium covering alpha contrast, icon+text leaf contrast, hidden focusable skipping, and nested reduced-motion', async () => {
		const pwDir = playwrightRuntimeDir();
		if (!pwDir) return;

		const srv: Server = createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end(`<!doctype html><html><head><style>
				@layer base {
					@media (prefers-reduced-motion: reduce) {
						* { transition-duration: 0s !important; }
					}
				}
				button:focus { outline: 2px solid rgb(37, 99, 235); }
				.card { background: rgba(0, 0, 0, 0.12); padding: 12px; }
				.faint-alpha { color: rgba(0, 0, 0, 0.28); background: transparent; font-size: 16px; }
				.good-icon-btn { color: rgb(15, 23, 42); background: rgb(255, 255, 255); padding: 12px 16px; min-width: 48px; min-height: 48px; }
				.bad-icon-btn { color: rgba(255, 255, 255, 0.45); background: rgb(255, 255, 255); padding: 12px 16px; min-width: 48px; min-height: 48px; }
			</style></head><body>
				<button hidden>Hidden First</button>
				<main class="card">
					<p class="faint-alpha">Semi-transparent low contrast text</p>
					<button class="good-icon-btn"><svg width="16" height="16" aria-hidden="true"></svg>Save Item</button>
					<button class="bad-icon-btn"><svg width="16" height="16" aria-hidden="true"></svg>Faint Save</button>
				</main>
			</body></html>`);
		});
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
		try {
			const addr = srv.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			const req = createRequire(import.meta.url);
			const { chromium } = req(join(pwDir, 'playwright-core')) as {
				chromium: {
					connect(ws: string): Promise<{
						newContext(opts: { viewport: { width: number; height: number } }): Promise<{
							addInitScript(script: string): Promise<void>;
							newPage(): Promise<
								VisualCheckPageLike & {
									goto(url: string, opts: { waitUntil: string }): Promise<unknown>;
								}
							>;
							close(): Promise<void>;
						}>;
					}>;
				};
			};
			const lease = await acquireBrowser({ hosts: [], headed: false, dedicated: false });
			const browser = await chromium.connect(lease.wsEndpoint());
			const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
			await ctx.addInitScript(EARLY_CLS_INIT_SCRIPT);
			const page = await ctx.newPage();
			await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });

			const report = await runStockVisualChecks(page as unknown as VisualCheckPageLike, {
				screen: 'alpha',
				state: 'default',
				width: 1280
			});
			await ctx.close();

			expect(report.checks['contrast-pairs'].passed).toBe(false);
			expect(report.contrastViolations.some((v) => v.text.includes('Semi-transparent'))).toBe(true);
			expect(report.contrastViolations.some((v) => v.text.includes('Faint Save'))).toBe(true);
			expect(report.contrastViolations.some((v) => v.text.includes('Save Item'))).toBe(false);
			expect(report.checks['focus-visible'].passed).toBe(true);
			expect(report.checks['reduced-motion'].passed).toBe(true);
		} finally {
			srv.closeAllConnections?.();
			await new Promise<void>((r) => srv.close(() => r()));
			await closeAllBrowsers().catch(() => undefined);
		}
	}, 30_000);
});
