// RUNS ONE BROWSER CHECK: PREPARE THE TARGET, SIGN IN, RUN THE SCRIPT, KEEP EVIDENCE, SCAN IT, REPORT (SPEC 10)
// The script receives a signed-in `page` and `context`, `expect`, `baseUrl` and `log`. It never receives a password. A failed
// script runs once more only on a read only target, and a pass on the retry is reported as flaky. A timeout closes the browser
// context, so the script stops at its next step instead of running on. Tracing and video start after the sign-in, in a new
// context, and every file is scanned for the project's secrets before it is uploaded.

// -- DEP-MODULES -- //
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Browser } from '@playwright/test';
// -- MODULES -- //
import { findSecret, maskSecrets, type Needle } from '../../../src/lib/shared/scan';
import type { CheckJob } from '../../../src/lib/server/ops/checks';
import { NeedsApproval, type Approvals } from './approvals';
import type { RunnerApi } from './api';
import type { RunnerConfig } from './config';
import { SignInFailed, signIn, type StorageState } from './signin';
import { TargetUnavailable, type Targets } from './targets';

// -- TYPES -- //

export type Deps = {
	api: RunnerApi;
	browser: Browser;
	targets: Targets;
	approvals: Approvals;
	config: RunnerConfig;
	log: (line: string) => void;
};

// -- CONSTANTS -- //

const MAX_UPLOAD = 14 * 1024 * 1024;
export const SCRIPT_TIMEOUT_MS = 120_000;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
	...args: string[]
) => (...a: unknown[]) => Promise<unknown>;

// -- FUNCTIONS -- //

export const withTimeout = <T>(
	p: Promise<T>,
	ms: number,
	what: string,
	onTimeout?: () => void
): Promise<T> =>
	new Promise((resolve, reject) => {
		const t = setTimeout(() => {
			// Stops what the script is driving, so it cannot keep clicking after the check was reported
			try {
				onTimeout?.();
			} catch {
				/* Nothing more to stop */
			}
			reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} seconds.`));
		}, ms);
		p.then(
			(v) => (clearTimeout(t), resolve(v)),
			(e) => (clearTimeout(t), reject(e))
		);
	});

/** Runs a check job from claim to report. Never throws: every failure becomes a report the person can read. */
export async function runCheckJob(job: CheckJob, deps: Deps): Promise<void> {
	const { api, browser, targets, approvals, config, log } = deps;
	const started = Date.now();
	const lines: string[] = [];
	let needles: Needle[] = [];
	const say = (s: unknown) => {
		const line = String(s);
		lines.push(line);
		log(`  ${maskSecrets(line, needles)}`);
	};
	const report = (r: Record<string, unknown>) =>
		api.finish('runs', job.id, {
			...r,
			durationMs: Date.now() - started,
			...(prepared?.unverified ? { unverified: true } : {}),
			log: maskSecrets(lines.join('\n'), needles)
		});
	const dir = mkdtempSync(join(tmpdir(), 'afb-run-'));
	let prepared: Awaited<ReturnType<Targets['prepare']>> | undefined;
	try {
		approvals.require(
			job.project.key,
			'script',
			`${job.check.key} of ${job.item.ref}`,
			job.check.script
		);
		prepared = await targets.prepare({
			project: job.project.key,
			target: job.target,
			url: job.environment.url,
			versionPath: job.environment.versionPath
		});
		if (prepared.note) say(prepared.note);
		const accounts = job.accounts.length ? await api.accounts('runs', job.id) : {};
		needles = Object.entries(accounts).map(([name, a]) => ({
			label: `the password of the test account "${name}"`,
			value: a.password
		}));
		let state: StorageState | undefined;
		const first = accounts.default ?? Object.values(accounts)[0];
		if (first) {
			say('Signing in with the saved test account');
			state = await signIn(browser, prepared.baseUrl, first, config.signIn);
		}
		let result: 'pass' | 'fail' = 'fail';
		let reason: string | undefined;
		let retried = false;
		const evidence: { path: string; filename: string; caption: string }[] = [];
		// A failed script runs again only against a read only target, where a second run cannot change anything twice
		const attempts = job.readOnly ? 2 : 1;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			const ctx = await browser.newContext({
				baseURL: prepared.baseUrl,
				storageState: state,
				viewport: { width: 1280, height: 800 },
				recordVideo: { dir, size: { width: 1280, height: 720 } }
			});
			try {
				await ctx.tracing.start({ screenshots: true, snapshots: true });
				if (job.readOnly)
					await ctx.route('**/*', (route) => {
						const m = route.request().method();
						if (['GET', 'HEAD', 'OPTIONS'].includes(m)) return route.continue();
						say(`Blocked ${m} ${route.request().url()}: this environment is read only`);
						return route.abort();
					});
				const page = await ctx.newPage();
				let error: string | undefined;
				let failed = false;
				try {
					const fn = new AsyncFunction(
						'page',
						'context',
						'expect',
						'baseUrl',
						'log',
						job.check.script
					);
					await withTimeout(
						fn(page, ctx, expect, prepared.baseUrl, say),
						SCRIPT_TIMEOUT_MS,
						'The check script',
						() => void ctx.close().catch(() => undefined)
					);
				} catch (e) {
					// A thrown error with no message is still a failure, so a separate flag decides and not the text
					failed = true;
					const text = e instanceof Error ? e.message : String(e);
					error =
						text.split('\n').slice(0, 6).join('\n') || 'The script threw an error with no message.';
				}
				const tag = attempt === 1 ? '' : `-retry`;
				const shot = join(dir, `final${tag}.png`);
				await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
				const trace = join(dir, `trace${tag}.zip`);
				await ctx.tracing.stop({ path: trace }).catch(() => undefined);
				const video = page.video();
				await ctx.close().catch(() => undefined);
				if (failed) {
					say(`Attempt ${attempt} failed: ${error}`);
					evidence.push({
						path: shot,
						filename: `final${tag}.png`,
						caption: `Page at the end of attempt ${attempt}`
					});
					evidence.push({
						path: trace,
						filename: `trace${tag}.zip`,
						caption: `Trace of attempt ${attempt}`
					});
					const vp = video ? await video.path().catch(() => null) : null;
					if (vp)
						evidence.push({
							path: vp,
							filename: `video${tag}.webm`,
							caption: `Video of attempt ${attempt}`
						});
					reason = error;
					continue;
				}
				say(`Attempt ${attempt} passed`);
				evidence.length = 0;
				evidence.push({
					path: shot,
					filename: `final${tag}.png`,
					caption: 'Page at the end of the passing run'
				});
				evidence.push({
					path: trace,
					filename: `trace${tag}.zip`,
					caption: 'Trace of the passing run'
				});
				result = 'pass';
				reason = undefined;
				retried = attempt > 1;
				break;
			} finally {
				// The context is closed on every way out, so a thrown error cannot leave a browser window behind
				await ctx.close().catch(() => undefined);
			}
		}
		// Every file is scanned before it leaves this machine, and a file with a secret in it is not uploaded
		const ids: string[] = [];
		for (const e of evidence) {
			let bytes: Buffer;
			try {
				if (statSync(e.path).size > MAX_UPLOAD) {
					say(`${e.filename} is larger than 14 MB and was not kept`);
					continue;
				}
				bytes = readFileSync(e.path);
			} catch {
				continue;
			}
			const hit = findSecret(bytes, needles);
			if (hit) {
				await report({
					result: 'error',
					reason: `${e.filename} held ${hit}, so no evidence was uploaded and the run was stopped.`,
					url: prepared.baseUrl,
					commit: prepared.commit,
					diffHash: prepared.diffHash,
					evidence: ids
				});
				return;
			}
			ids.push(
				await api.upload('runs', job.id, { filename: e.filename, caption: e.caption, bytes })
			);
		}
		await report({
			result,
			reason,
			retried,
			url: prepared.baseUrl,
			commit: prepared.commit,
			diffHash: prepared.diffHash,
			evidence: ids
		});
	} catch (e) {
		const reason =
			e instanceof NeedsApproval || e instanceof TargetUnavailable || e instanceof SignInFailed
				? e.message
				: `The runner could not run this check: ${(e as Error).message}`;
		await report({ result: 'error', reason: maskSecrets(reason, needles).slice(0, 1900) }).catch(
			() => undefined
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
