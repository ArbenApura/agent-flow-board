// RUNS ONE CHECK FILE IN ITS OWN PROCESS, started by sandbox.ts with Node's permission model on (dist/checks/child.js).
// It reads one job from stdin (the saved sign-in is handed over there, never written to disk here), drives the page, writes its
// result and its pictures into the run folder, and prints one line per event. It never sees the board or any token.
// Under the permission model there are no child processes, no worker threads and no file access outside the folders sandbox.ts names,
// and the only environment variable it reads is AFB_PLAYWRIGHT_DIR. It imports nothing that touches the bridge's token store.

// -- DEP-MODULES -- //
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// -- TYPES -- //
import type { DevReadinessMode, DevReadyPageLike } from './devReadiness.js';
import type { EarlyCheckPageLike, EarlyStockCheckReport } from './earlyStockChecks.js';
import type { ChildJob, ChildResult } from './types.js';
// -- MODULES -- //
import { DEV_READINESS_INIT_SCRIPT, DevReadinessError, waitForDevReady } from './devReadiness.js';
import {
	EARLY_CLS_INIT_SCRIPT,
	measureEarlyStockChecks,
	resetEarlyCls
} from './earlyStockChecks.js';
import {
	describeWriteGuard,
	guardContext,
	guardDevContext,
	pageForCheck,
	unwrap
} from './guard.js';
import type { ContextLike, GuardCounts } from './guard.js';
import { redact } from './redact.js';

// -- LOCAL TYPES -- //

type StepResult = ChildResult['steps'][number];
type FrameLike = { url(): string };
type PageLike = {
	evaluate<R, Arg = unknown>(fn: (arg: Arg) => R | Promise<R>, arg?: Arg): Promise<R>;
	screenshot(options: Record<string, unknown>): Promise<Buffer>;
	on(event: 'framenavigated', handler: (frame: FrameLike) => void): void;
	mainFrame(): FrameLike;
	goto?(url: string, opts?: Record<string, unknown>): Promise<unknown>;
	waitForLoadState?(
		state?: 'load' | 'domcontentloaded' | 'networkidle',
		opts?: { timeout?: number }
	): Promise<void>;
	setViewportSize?(size: { width: number; height: number }): Promise<void>;
};
type BrowserContextLike = ContextLike & {
	addInitScript?(script: string): Promise<void>;
	newPage(): Promise<PageLike>;
};
type BrowserLike = {
	newContext(options: Record<string, unknown>): Promise<BrowserContextLike>;
	close(): Promise<void>;
};
type ExpectFn = ((value: unknown, message?: string) => unknown) & {
	soft?: (value: unknown, message?: string) => unknown;
	poll?: (fn: unknown, options?: unknown) => unknown;
};
type CheckFn = (api: Record<string, unknown>) => Promise<void>;

// -- CONSTANTS -- //

const CHECK_LIMIT_MS = 120_000;
const MAX_SHOT_HEIGHT = 2400;

// -- FUNCTIONS -- //

const readStdin = (): Promise<string> =>
	new Promise((resolve) => {
		let s = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (d: string) => (s += d));
		process.stdin.on('end', () => resolve(s));
	});

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function main(): Promise<void> {
	const job = JSON.parse(await readStdin()) as ChildJob;
	const needles = job.needles ?? [];
	const isMockup = Boolean(job.mockupMode);
	if (isMockup && job.storageState != null)
		throw new Error('A mockup check context cannot accept saved sign-ins or storageState.');
	const extraHosts = isMockup ? [] : (job.extraHosts ?? []);
	const origin = new URL(job.baseUrl).origin;

	// PLAYWRIGHT: the parent names the node_modules folder that holds it; it is the only place outside the run folder this process can read
	const pwDir = process.env.AFB_PLAYWRIGHT_DIR;
	if (!pwDir) throw new Error('The parent did not say where Playwright is.');
	const req = createRequire(import.meta.url);
	const { chromium } = req(join(pwDir, 'playwright-core')) as {
		chromium: { connect(ws: string): Promise<BrowserLike> };
	};
	// expect() comes with @playwright/test. Without it a check that calls expect gets one plain sentence
	let realExpect: ExpectFn;
	try {
		realExpect = (req(join(pwDir, '@playwright', 'test')) as { expect: ExpectFn }).expect;
	} catch {
		realExpect = () => {
			throw new Error(
				'expect() needs @playwright/test, which is not installed next to Playwright. Run "agent-flow-board check setup".'
			);
		};
	}
	// expect() needs the real locator, so it is given one here, and the check only ever sees the matchers
	const checkExpect = Object.assign(
		(value: unknown, message?: string) => realExpect(unwrap(value), message),
		{
			soft: (value: unknown, message?: string) => realExpect.soft?.(unwrap(value), message),
			poll: (fn: unknown, options?: unknown) => realExpect.poll?.(fn, options)
		}
	);

	const out = (event: Record<string, unknown>) =>
		process.stdout.write(`EVENT ${JSON.stringify(event)}\n`);
	const say = (m: unknown) => out({ type: 'log', text: redact(String(m), needles).slice(0, 600) });
	const shotsDir = join(job.runDir, 'shots');
	mkdirSync(shotsDir, { recursive: true });

	const steps: StepResult[] = [];
	const lines: string[] = [];
	let n = 0;
	let page: PageLike | undefined;
	let expiredSeen = false;
	let counts: GuardCounts = { writes: 0, outside: 0 };
	let readinessMode: DevReadinessMode = 'fallback';
	const earlyReports: EarlyStockCheckReport[] = [];
	const runStarted = Date.now();
	let firstShotDone = false;
	let coldMs: number | undefined;
	let warmStarted: number | undefined;

	async function measureBeforeShot(): Promise<void> {
		if (!page || !job.isDev) return;
		if (typeof page.waitForLoadState === 'function') {
			const ready = await waitForDevReady(page as unknown as DevReadyPageLike, {
				redactionNeedles: needles
			});
			if (ready.mode === 'vite') readinessMode = 'vite';
		}
		if (typeof page.evaluate === 'function') {
			try {
				const report = await measureEarlyStockChecks(page as unknown as EarlyCheckPageLike);
				earlyReports.push(report);
				if (!report.cls.passed) {
					say(`CLS violation (${report.cls.score} > ${report.cls.maxCls})`);
				}
				if (!report.tapTargets.passed) {
					say(
						`Small tap targets (<${report.tapTargets.minTapPx}px): ${report.tapTargets.smallCount}`
					);
				}
				await resetEarlyCls(page as unknown as EarlyCheckPageLike);
			} catch {
				// Ignore pages that navigated mid-evaluation
			}
		}
	}

	async function takeShot(
		caption: string,
		opts?: { skipReady?: boolean }
	): Promise<{ file: string; caption: string } | null> {
		if (!page) return null;
		const file = `${String(++n).padStart(2, '0')}.jpg`;
		try {
			if (!opts?.skipReady) await measureBeforeShot();
			const height = await page.evaluate(() => document.documentElement.scrollHeight);
			const bytes = await page.screenshot({
				type: 'jpeg',
				quality: 55,
				fullPage: true,
				...(height > MAX_SHOT_HEIGHT
					? { clip: { x: 0, y: 0, width: job.viewport.width, height: MAX_SHOT_HEIGHT } }
					: {})
			});
			writeFileSync(join(shotsDir, file), bytes);
			if (!firstShotDone) {
				firstShotDone = true;
				coldMs = Date.now() - runStarted;
				warmStarted = Date.now();
			}
			return { file, caption };
		} catch (e) {
			if (e instanceof DevReadinessError || (e instanceof Error && e.name === 'DevReadinessError'))
				throw e;
			return null;
		}
	}

	let result: ChildResult['result'] = 'pass';
	let reason: string | undefined;
	const started = Date.now();
	// The browser was started by the tool; this process only connects to it, so it never has to start a program itself
	const browser = await chromium.connect(job.ws);
	try {
		const ctx = await browser.newContext({
			baseURL: job.baseUrl,
			viewport: job.viewport,
			storageState: isMockup ? undefined : (job.storageState ?? undefined),
			serviceWorkers: 'block'
		});
		if (!isMockup && job.isDev && ctx.addInitScript) {
			await ctx.addInitScript(DEV_READINESS_INIT_SCRIPT);
			await ctx.addInitScript(EARLY_CLS_INIT_SCRIPT);
		}
		counts =
			!isMockup && job.isDev
				? await guardDevContext(ctx, {
						origin,
						writeAllowlist: job.allowWrites ? (job.writeAllowlist ?? []) : [],
						extraHosts,
						onBlocked: say
					})
				: await guardContext(ctx, {
						origin,
						allowWrites: false,
						extraHosts,
						onBlocked: say
					});
		const real = await ctx.newPage();
		page = real;
		let violation = null as string | null;
		// A page that ends up anywhere but the app under test (file:, chrome:, view-source:) fails the run
		real.on('framenavigated', (f) => {
			try {
				const u = new URL(f.url());
				if (
					u.protocol !== 'about:' &&
					(!['http:', 'https:'].includes(u.protocol) ||
						(u.origin !== origin && !extraHosts.includes(u.hostname)))
				)
					violation = `The page went to ${u.protocol}//${u.host}, which is not the app under test.`;
			} catch {
				/* about:blank and the like */
			}
		});
		// A signed-in run that is sent to a sign-in page has an expired sign-in
		real.on('framenavigated', (f) => {
			try {
				if (
					f === real.mainFrame() &&
					job.storageState &&
					/\/(sign-?in|log-?in|login|auth)(\/|$|\?)/i.test(new URL(f.url()).pathname)
				)
					expiredSeen = true;
			} catch {
				/* about:blank and the like */
			}
		});
		const step = async (name: string, fn: () => Promise<void> | void) => {
			const t0 = Date.now();
			try {
				await fn();
				const shot = await takeShot(name);
				steps.push({ name, status: 'pass', ms: Date.now() - t0, shot: shot?.file ?? null });
				out({ type: 'step', name, status: 'pass', ms: Date.now() - t0 });
			} catch (e) {
				const shot = await takeShot(`${name} (failed)`, { skipReady: true });
				const error = redact(messageOf(e).split('\n').slice(0, 4).join(' '), needles).slice(0, 500);
				steps.push({ name, status: 'fail', ms: Date.now() - t0, shot: shot?.file ?? null, error });
				out({ type: 'step', name, status: 'fail', ms: Date.now() - t0, error });
				throw e;
			}
		};
		const shot = async (caption = 'Shot') => {
			const s = await takeShot(caption);
			if (s) steps.push({ name: caption, status: 'shot', ms: 0, shot: s.file });
		};
		const log = (m: unknown) => {
			const t = redact(String(m), needles);
			lines.push(t);
			say(t);
		};
		const sweep = async (opts: {
			screens: { name: string; path: string }[];
			widths?: number[];
			height?: number;
		}) => {
			const widths = opts.widths?.length ? opts.widths : [390, 768, 1280, 1440];
			const height = opts.height ?? job.viewport.height;
			for (const screen of opts.screens) {
				let targetUrl: URL;
				if (isMockup && screen.path.startsWith('?')) {
					// Preserve signed query params (`sig`, `exp`) on the mockup URL when adding `?screen=...&state=...`
					targetUrl = new URL(job.baseUrl);
					const extra = new URLSearchParams(screen.path.slice(1));
					for (const [k, v] of extra) targetUrl.searchParams.set(k, v);
				} else {
					targetUrl = new URL(screen.path, job.baseUrl);
				}
				if (targetUrl.origin !== origin && !extraHosts.includes(targetUrl.hostname)) {
					throw new Error(`Sweep refused off-origin screen path "${screen.path}".`);
				}
				const url = targetUrl.href;
				let navigated = false;
				for (const width of widths) {
					const t0 = Date.now();
					if (real.setViewportSize) await real.setViewportSize({ width, height });
					if (!navigated && real.goto) {
						await real.goto(url, { waitUntil: 'domcontentloaded' });
						navigated = true;
					}
					const label = `${screen.name} @ ${width}px`;
					const s = await takeShot(label);
					steps.push({ name: label, status: 'shot', ms: Date.now() - t0, shot: s?.file ?? null });
				}
			}
		};
		const fn = ((await import(pathToFileURL(job.checkFile).href)) as { default?: unknown }).default;
		if (typeof fn !== 'function')
			throw new Error(
				'A check file must export default an async function({ page, step, shot, expect, log, baseUrl, sweep }).'
			);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				(fn as CheckFn)({
					page: pageForCheck(real, { origin, extraHosts }),
					step,
					shot,
					expect: checkExpect,
					log,
					baseUrl: job.baseUrl,
					sweep
				}),
				new Promise<never>(
					(_, rej) =>
						(timer = setTimeout(
							() => rej(new Error('The check took longer than 2 minutes.')),
							CHECK_LIMIT_MS
						))
				)
			]);
		} finally {
			clearTimeout(timer);
		}
		if (violation) throw new Error(violation);
		if (!steps.length) {
			const s = await takeShot('End of the check');
			if (s) steps.push({ name: 'End of the check', status: 'shot', ms: 0, shot: s.file });
		}
	} catch (e) {
		result = 'fail';
		reason = redact(messageOf(e).split('\n').slice(0, 4).join(' '), needles).slice(0, 700);
		if (!steps.some((s) => s.status === 'fail') && page) {
			const s = await takeShot('Where it stopped', { skipReady: true });
			if (s) steps.push({ name: 'Where it stopped', status: 'shot', ms: 0, shot: s.file });
		}
	} finally {
		await browser.close().catch(() => {});
	}
	if (job.isDev) {
		const guardLine = describeWriteGuard(counts);
		lines.push(guardLine);
		say(guardLine);
	}
	if (result === 'fail' && expiredSeen)
		reason =
			`The saved sign-in no longer works: the app sent the browser to its sign-in page. Sign in again and rerun. (${reason ?? ''})`.trim();
	const warmMs = warmStarted !== undefined ? Date.now() - warmStarted : undefined;
	const earlyChecksSummary = earlyReports.length
		? {
				shotsChecked: earlyReports.length,
				maxCls: Number(earlyReports.reduce((m, r) => Math.max(m, r.cls.score), 0).toFixed(4)),
				clsViolations: earlyReports.filter((r) => !r.cls.passed).length,
				tapViolations: earlyReports.reduce((total, r) => total + r.tapTargets.smallCount, 0),
				passed: earlyReports.every((r) => r.passed)
			}
		: undefined;
	const final: ChildResult = {
		schema: 1,
		result,
		reason: reason ?? null,
		durationMs: Date.now() - started,
		...(coldMs !== undefined ? { coldMs } : {}),
		...(warmMs !== undefined ? { warmMs } : {}),
		...(job.isDev ? { readinessMode } : {}),
		...(earlyChecksSummary ? { earlyChecks: earlyChecksSummary } : {}),
		steps,
		log: lines.join('\n'),
		blockedWrites: counts.writes,
		blockedOutside: counts.outside
	};
	writeFileSync(join(job.runDir, 'result.json'), JSON.stringify(final, null, 1));
	out({ type: 'done', result });
}

main().then(
	// Nothing else is waiting, so end now instead of waiting for stray timers
	() => process.exit(0),
	(e: unknown) => {
		process.stderr.write(`${messageOf(e).slice(0, 600)}\n`);
		process.exit(1);
	}
);
