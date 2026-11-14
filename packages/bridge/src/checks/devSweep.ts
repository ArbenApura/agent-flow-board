// WARM-BROWSER DEV SWEEP: SCREENS x WIDTHS x STATES IN ONE RUN (STEPS A.6 & A.10, AFB-20261113-1008)
// Reuses one warm Chromium browser (browserpool) and shared contexts per state across a whole matrix of screens, widths, and auth states,
// waits for HMR readiness (Vite or fallback), runs early stock checks (CLS + <44px tap targets) on every cell, and measures cold vs warm separately.

// -- DEP-MODULES -- //
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
// -- TYPES -- //
import type { WriteRule } from './devPolicy.js';
import type { DevReadinessMode } from './devReadiness.js';
import type { EarlyStockCheckReport } from './earlyStockChecks.js';
import type { GuardCounts } from './guard.js';
// -- MODULES -- //
import { playwrightRuntimeDir } from './browser.js';
import { acquireBrowser, type BrowserLease } from './browserpool.js';
import {
	DEV_READINESS_INIT_SCRIPT,
	waitForDevReady,
	type DevReadyPageLike
} from './devReadiness.js';
import {
	EARLY_CLS_INIT_SCRIPT,
	measureEarlyStockChecks,
	resetEarlyCls,
	type EarlyCheckPageLike
} from './earlyStockChecks.js';
import { devStatusFixLine } from './devPolicy.js';
import { describeWriteGuard, guardDevContext, type ContextLike } from './guard.js';

// -- TYPES -- //

export type DevSweepScreen = {
	name: string;
	path: string;
};

export type DevSweepState = {
	name: string;
	storageState?: unknown;
};

export type DevSweepCell = {
	screen: string;
	path: string;
	width: number;
	state: string;
	readinessMode: DevReadinessMode;
	ms: number;
	earlyChecks: EarlyStockCheckReport;
	shot?: string;
};

export type DevSweepReport = {
	schema: 1;
	origin: string;
	mode: DevReadinessMode;
	coldMs: number;
	warmMs: number;
	totalCells: number;
	cells: DevSweepCell[];
	earlyStockSummary: {
		maxCls: number;
		clsViolations: number;
		tapViolations: number;
		passed: boolean;
	};
	writeGuard: string;
	blockedWrites: number;
	blockedOutside: number;
	passed: boolean;
};

export type DevSweepOptions = {
	origin: string;
	screens: DevSweepScreen[];
	widths?: number[];
	height?: number;
	states?: DevSweepState[];
	allowWrites?: boolean;
	writeAllowlist?: WriteRule[];
	extraHosts?: string[];
	needles?: readonly string[];
	shotsDir?: string;
	maxCls?: number;
	minTapPx?: number;
	readinessTimeoutMs?: number;
	readinessSettleMs?: number;
	/** Optional already-acquired browser lease (keeps Chromium warm across multiple sweeps). */
	browserLease?: BrowserLease;
	log?: (line: string) => void;
};

type SweepPage = DevReadyPageLike &
	EarlyCheckPageLike & {
		goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
		setViewportSize(size: { width: number; height: number }): Promise<void>;
		screenshot(options: Record<string, unknown>): Promise<Buffer>;
	};

type SweepContext = ContextLike & {
	addInitScript(script: string): Promise<void>;
	newPage(): Promise<SweepPage>;
	close(): Promise<void>;
};

// -- CONSTANTS -- //

export const DEFAULT_SWEEP_WIDTHS = [390, 768, 1280, 1440];
const DEFAULT_HEIGHT = 800;

// -- FUNCTIONS -- //

/** Runs a `(screens x widths x states)` warm-browser sweep against a running dev origin, measuring cold vs warm separately. */
export async function runDevSweep(opts: DevSweepOptions): Promise<DevSweepReport> {
	const widths = opts.widths?.length ? opts.widths : DEFAULT_SWEEP_WIDTHS;
	const height = opts.height ?? DEFAULT_HEIGHT;
	const states: DevSweepState[] = opts.states?.length
		? opts.states
		: [{ name: 'anon', storageState: undefined }];
	const log = opts.log ?? (() => {});
	const shotsDir = opts.shotsDir;
	if (shotsDir) mkdirSync(shotsDir, { recursive: true });

	const origin = new URL(opts.origin).origin;
	const pwDir = playwrightRuntimeDir();
	if (!pwDir) throw new Error('Playwright runtime directory is not installed.');
	const req = createRequire(import.meta.url);
	const { chromium } = req(join(pwDir, 'playwright-core')) as {
		chromium: {
			connect(ws: string): Promise<{
				newContext(options: Record<string, unknown>): Promise<SweepContext>;
				close(): Promise<void>;
			}>;
		};
	};

	const ownLease = opts.browserLease
		? null
		: await acquireBrowser({
				hosts: opts.extraHosts ?? [],
				headed: false,
				dedicated: false
			});
	const lease = opts.browserLease ?? ownLease!;
	const countsTotal: GuardCounts = { writes: 0, outside: 0 };
	const cells: DevSweepCell[] = [];
	let shotIdx = 0;

	const coldStart = Date.now();
	const browser = await chromium.connect(lease.wsEndpoint());
	let coldMs = 0;
	let warmMs = 0;
	let firstDone = false;
	let warmStarted = 0;
	let observedMode: DevReadinessMode = 'fallback';
	let writeFixShown = false;

	try {
		for (const state of states) {
			const ctx = await browser.newContext({
				baseURL: origin,
				viewport: { width: widths[0] ?? 1280, height },
				...(state.storageState ? { storageState: state.storageState } : {}),
				serviceWorkers: 'block'
			});
			await ctx.addInitScript(DEV_READINESS_INIT_SCRIPT);
			await ctx.addInitScript(EARLY_CLS_INIT_SCRIPT);
			const expectedOrigin = new URL(opts.origin).origin;
			const stateCounts = await guardDevContext(ctx, {
				origin,
				...(opts.allowWrites && opts.writeAllowlist ? { writeAllowlist: opts.writeAllowlist } : {}),
				extraHosts: opts.extraHosts ?? [],
				onBlocked: (msg) => {
					log(msg);
					// A stopped write is named once with the way to allow a read-only one, so an app that loads its profile through a POST is not a mystery
					if (!writeFixShown && msg.startsWith('stopped a ')) {
						writeFixShown = true;
						log(`DEV_WRITE_STOPPED: ${devStatusFixLine('DEV_WRITE_STOPPED') ?? ''}`);
					}
				}
			});

			const page = await ctx.newPage();
			try {
				let lastScreenPath: string | null = null;
				for (const screen of opts.screens) {
					if (
						!screen.path.startsWith('/') ||
						screen.path.startsWith('//') ||
						screen.path.includes('\\')
					) {
						throw new Error(
							`Refused unsafe screen path "${screen.path}": use a single-origin relative path starting with "/".`
						);
					}
					const parsedTarget = new URL(screen.path, expectedOrigin);
					if (parsedTarget.origin !== expectedOrigin) {
						throw new Error(
							`Refused off-origin screen path "${screen.path}" (resolved to "${parsedTarget.origin}").`
						);
					}
					const targetUrl = parsedTarget.href;
					for (const width of widths) {
						const t0 = Date.now();
						await page.setViewportSize({ width, height });
						await resetEarlyCls(page).catch(() => undefined);
						if (lastScreenPath !== targetUrl) {
							await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
							lastScreenPath = targetUrl;
						} else {
							await page.evaluate(async () => {
								await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
							}, undefined);
						}
						const ready = await waitForDevReady(page, {
							timeoutMs: opts.readinessTimeoutMs,
							settleMs: opts.readinessSettleMs,
							redactionNeedles: opts.needles
						});
						if (ready.mode === 'vite') observedMode = 'vite';
						const earlyChecks = await measureEarlyStockChecks(page, {
							maxCls: opts.maxCls,
							minTapPx: opts.minTapPx
						});
						let shotFile: string | undefined;
						if (shotsDir) {
							shotFile = `${String(++shotIdx).padStart(2, '0')}.jpg`;
							const buf = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: true });
							writeFileSync(join(shotsDir, shotFile), buf);
						}
						const elapsed = Date.now() - t0;
						if (!firstDone) {
							firstDone = true;
							coldMs = Date.now() - coldStart;
							warmStarted = Date.now();
						}
						cells.push({
							screen: screen.name,
							path: screen.path,
							width,
							state: state.name,
							readinessMode: ready.mode,
							ms: elapsed,
							earlyChecks,
							...(shotFile ? { shot: shotFile } : {})
						});
					}
				}
			} finally {
				countsTotal.writes += stateCounts.writes;
				countsTotal.outside += stateCounts.outside;
				await ctx.close().catch(() => undefined);
			}
		}
		if (firstDone) warmMs = Date.now() - warmStarted;
	} finally {
		await browser.close().catch(() => undefined);
		if (ownLease) await ownLease.release().catch(() => undefined);
	}

	const maxCls = cells.reduce((m, c) => Math.max(m, c.earlyChecks.cls.score), 0);
	const clsViolations = cells.filter((c) => !c.earlyChecks.cls.passed).length;
	const tapViolations = cells.reduce((n, c) => n + c.earlyChecks.tapTargets.smallCount, 0);
	const earlyPassed = clsViolations === 0 && tapViolations === 0;

	return {
		schema: 1,
		origin,
		mode: observedMode,
		coldMs,
		warmMs,
		totalCells: cells.length,
		cells,
		earlyStockSummary: {
			maxCls: Number(maxCls.toFixed(4)),
			clsViolations,
			tapViolations,
			passed: earlyPassed
		},
		writeGuard: describeWriteGuard(countsTotal),
		blockedWrites: countsTotal.writes,
		blockedOutside: countsTotal.outside,
		passed: earlyPassed
	};
}
