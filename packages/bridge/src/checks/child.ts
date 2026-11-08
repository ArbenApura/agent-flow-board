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
import type { ChildJob, ChildResult } from './types.js';
// -- MODULES -- //
import { guardContext, pageForCheck, unwrap } from './guard.js';
import type { ContextLike, GuardCounts } from './guard.js';
import { redact } from './redact.js';

// -- LOCAL TYPES -- //

type StepResult = ChildResult['steps'][number];
type FrameLike = { url(): string };
type PageLike = {
	evaluate<T>(fn: () => T): Promise<T>;
	screenshot(options: Record<string, unknown>): Promise<Buffer>;
	on(event: 'framenavigated', handler: (frame: FrameLike) => void): void;
	mainFrame(): FrameLike;
};
type BrowserContextLike = ContextLike & { newPage(): Promise<PageLike> };
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
	const extraHosts = job.extraHosts ?? [];
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

	async function takeShot(caption: string): Promise<{ file: string; caption: string } | null> {
		if (!page) return null;
		const file = `${String(++n).padStart(2, '0')}.jpg`;
		try {
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
			return { file, caption };
		} catch {
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
			storageState: job.storageState ?? undefined,
			serviceWorkers: 'block'
		});
		// ChildJob has no allowWrites: a check run in the sandbox never writes
		counts = await guardContext(ctx, { origin, allowWrites: false, extraHosts, onBlocked: say });
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
				const shot = await takeShot(`${name} (failed)`);
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
		const fn = ((await import(pathToFileURL(job.checkFile).href)) as { default?: unknown }).default;
		if (typeof fn !== 'function')
			throw new Error(
				'A check file must export default an async function({ page, step, shot, expect, log, baseUrl }).'
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
					baseUrl: job.baseUrl
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
			const s = await takeShot('Where it stopped');
			if (s) steps.push({ name: 'Where it stopped', status: 'shot', ms: 0, shot: s.file });
		}
	} finally {
		await browser.close().catch(() => {});
	}
	if (result === 'fail' && expiredSeen)
		reason =
			`The saved sign-in no longer works: the app sent the browser to its sign-in page. Sign in again and rerun. (${reason ?? ''})`.trim();
	const final: ChildResult = {
		schema: 1,
		result,
		reason: reason ?? null,
		durationMs: Date.now() - started,
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
