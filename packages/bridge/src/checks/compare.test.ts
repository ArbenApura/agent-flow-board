// TESTS FOR STEP B.6: `check compare` TWO-CONTEXT MOCKUP VS APP DIFF, PICTURE PAIRS, FREE EXEMPTIONS AND SIGNED-IN PICTURE GATE.

// IMPORTED DEP-MODULES
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { devConfigHash } from './devPolicy.js';
import { checkMain } from './command.js';
import { runCompare } from './compare.js';
import { LOOPBACK_BIND, saveProfile } from './profiles.js';
import { saveRegistration } from './registry.js';
import { fileStore } from '../tokenStore.js';

// -- CONSTANTS -- //

const ITEM = 'AFB-20261113-1008';

// -- HELPERS -- //

function startMultiServer(
	handler: (
		method: string,
		url: URL,
		body: Buffer,
		headers: Record<string, string | string[] | undefined>,
		query: URLSearchParams
	) => { status: number; contentType: string; body: string | Buffer }
): Promise<{ server: Server; origin: string }> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => chunks.push(c));
			req.on('end', () => {
				const raw = Buffer.concat(chunks);
				const u = new URL(req.url ?? '/', 'http://127.0.0.1');
				const out = handler(req.method ?? 'GET', u, raw, req.headers, u.searchParams);
				res.writeHead(out.status, { 'content-type': out.contentType });
				res.end(out.body);
			});
		});
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address() as { port: number };
			resolve({ server, origin: `http://127.0.0.1:${addr.port}` });
		});
	});
}

describe('check compare (B.6)', () => {
	let home = '';
	let repo = '';
	let beforeHome: string | undefined;
	const servers: Server[] = [];

	beforeEach(() => {
		beforeHome = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-compare-home-'));
		process.env.AFB_BRIDGE_HOME = home;
		repo = mkdtempSync(join(tmpdir(), 'afb-compare-repo-'));
		execFileSync('git', ['init', '-q'], { cwd: repo });
	});

	afterEach(async () => {
		for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
		if (beforeHome === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = beforeHome;
		rmSync(home, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	});

	function registerDevApp(name: string, origin: string, uploadSignedInPictures = false) {
		const devHash = devConfigHash({
			devUrl: origin,
			startCommand: undefined,
			allowWrites: false,
			writeAllowlist: undefined
		});
		saveRegistration({
			org: 'arbenger',
			name,
			boardProject: 'AFB',
			repo,
			recipe: false,
			database: 'none',
			devUrl: origin,
			allowWrites: false,
			devApprovalHash: devHash,
			adoptEnv: false,
			uploadSignedInPictures,
			createdAt: new Date().toISOString()
		});
	}

	it('compares mockup and dev app across states & widths, uploads picture pairs, and keeps mockup context cookie-free', async () => {
		const mockupCookies: string[] = [];
		const uploads: { filename: string; caption: string; size: number; text?: string }[] = [];
		let finishPayload: { result?: string; evidence?: string[]; log?: string } | null = null;

		const srv = await startMultiServer((_method, u, body, headers) => {
			if (u.pathname === '/api/v1/runner/claim') {
				return {
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						job: {
							id: 'run-cmp-1',
							project: { id: 'p-1', key: 'AFB', name: 'AFB' },
							item: { id: 'i-1', ref: ITEM, title: 'Compare' },
							check: { id: 'c-1', key: 'CMP', title: 'Visual compare' }
						}
					})
				};
			}
			if (u.pathname === '/api/v1/runner/mockups/m-cmp/url') {
				return {
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						url: `${srv.origin}/m/signed-cmp/file?sig=cmp`,
						relativePath: '/m/signed-cmp/file?sig=cmp',
						mockupId: 'm-cmp',
						projectId: 'p-1',
						version: 1,
						kind: 'html',
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
						isolatedOrigin: true,
						devOnlySameHost: false,
						notice: null,
						isPublic: false
					})
				};
			}
			if (u.pathname.startsWith('/api/v1/runner/runs/run-cmp-1/artifacts')) {
				const fn = u.searchParams.get('filename') ?? 'unknown';
				uploads.push({
					filename: fn,
					caption: u.searchParams.get('caption') ?? '',
					size: body.length,
					...(fn.endsWith('.json') ? { text: body.toString('utf8') } : {})
				});
				return {
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ attachmentId: `att-${uploads.length}` })
				};
			}
			if (u.pathname === '/api/v1/runner/runs/run-cmp-1/finish') {
				finishPayload = JSON.parse(body.toString('utf8')) as {
					result?: string;
					evidence?: string[];
					log?: string;
				};
				return { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) };
			}
			if (u.pathname === '/m/signed-cmp/file') {
				mockupCookies.push(String(headers.cookie ?? ''));
				const state = u.searchParams.get('state') || 'default';
				return {
					status: 200,
					contentType: 'text/html; charset=utf-8',
					body: `<!doctype html><html><head><style>
						body { margin: 0; font-family: Arial, sans-serif; }
						[data-ref="card"] {
							position: absolute; left: 16px; top: 16px; width: 280px; height: 96px;
							padding: 16px; border-radius: 8px; background-color: rgb(255, 255, 255);
							color: rgb(17, 24, 39); font-size: 16px; font-weight: 600; display: block;
							box-sizing: border-box;
						}
					</style></head><body>
						<div data-ref="card">Mockup ${state}</div>
						<p data-ref="hero-sub">Static mockup subtitle</p>
					</body></html>`
				};
			}
			if (u.pathname === '/settings') {
				const state = u.searchParams.get('state') || 'default';
				return {
					status: 200,
					contentType: 'text/html; charset=utf-8',
					body: `<!doctype html><html><head><style>
						body { margin: 0; font-family: Arial, sans-serif; }
						.app-card {
							position: absolute; left: 17px; top: 16px; width: 280px; height: 96px;
							padding: 16px; border-radius: 8px; background-color: rgb(255, 255, 255);
							color: rgb(17, 24, 39); font-size: 16px; font-weight: 600; display: block;
							box-sizing: border-box;
						}
					</style></head><body>
						<div class="app-card">Mockup ${state}</div>
						<p class="hero-sub">Dynamic live text for Admin</p>
					</body></html>`
				};
			}
			return { status: 404, contentType: 'text/plain', body: 'nope' };
		});
		servers.push(srv.server);

		registerDevApp('dev-cmp', srv.origin);

		const briefText = ['## Free', '- hero-sub | text | Dynamic per signed-in person'].join('\n');

		const out = await runCompare({
			mode: 'board',
			server: srv.origin,
			org: 'arbenger',
			mockup: 'm-cmp@1',
			registration: 'dev-cmp',
			screens: [{ name: 'settings', screen: 'settings', path: '/settings' }],
			states: ['empty', 'loaded'],
			widths: [390, 1280],
			manifest: {
				pairs: [
					{ ref: 'card', appSelector: '.app-card' },
					{ ref: 'hero-sub', appSelector: '.hero-sub' }
				]
			},
			briefText,
			dir: repo,
			item: ITEM,
			key: 'CMP',
			runId: 'run-cmp-1',
			runnerToken: 'afx_tok',
			personalToken: null,
			fetch,
			log: () => undefined
		});

		expect(out, out.message).toMatchObject({ exitCode: 0 });
		expect(out.report?.pairCount).toBe(4);
		expect(out.report?.passed).toBe(true);
		expect(out.report?.totalWaived).toBe(4);
		expect(mockupCookies.every((c) => c === '')).toBe(true);

		// 4 picture pairs (8 JPEGs) + 1 compare-diff.json = 9 artifacts uploaded
		expect(uploads.filter((u) => u.filename.endsWith('.jpg'))).toHaveLength(8);
		expect(uploads.some((u) => u.filename === 'compare-diff.json')).toBe(true);
		expect(finishPayload?.result).toBe('pass');
		expect(finishPayload?.evidence).toHaveLength(9);
		expect(out.resultPath && existsSync(out.resultPath)).toBe(true);
	}, 90_000);

	it('catches colour & size drift, ranks high before low, honors overrides with reasons and refuses overrides without reason', async () => {
		const srv = await startMultiServer((_m, u) => {
			if (u.pathname === '/api/v1/orgs/arbenger/mockups/m-drift/url') {
				return {
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						url: `${srv.origin}/m/signed-drift/file`,
						relativePath: '/m/signed-drift/file',
						mockupId: 'm-drift',
						projectId: 'p-1',
						version: 1,
						kind: 'html',
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
						isolatedOrigin: true,
						devOnlySameHost: false,
						notice: null,
						isPublic: false
					})
				};
			}
			if (u.pathname === '/m/signed-drift/file') {
				return {
					status: 200,
					contentType: 'text/html; charset=utf-8',
					body: `<!doctype html><html><body>
						<div data-ref="panel" style="width:200px;height:60px;background-color:rgb(255,255,255);border-radius:8px;">Panel</div>
					</body></html>`
				};
			}
			return {
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: `<!doctype html><html><body>
					<div class="real-panel" style="width:205px;height:60px;background-color:rgb(250,250,250);border-radius:12px;">Panel</div>
				</body></html>`
			};
		});
		servers.push(srv.server);
		registerDevApp('dev-drift', srv.origin);

		// Override without reason must fail cleanly
		const badOut = await runCompare({
			mode: 'local',
			server: srv.origin,
			org: 'arbenger',
			mockup: 'm-drift',
			registration: 'dev-drift',
			manifest: {
				pairs: [{ ref: 'panel', appSelector: '.real-panel' }],
				overrides: [{ ref: 'panel', property: 'w', tolerancePx: 6, reason: '' }]
			},
			dir: repo,
			runnerToken: '',
			personalToken: 'p-tok',
			fetch,
			log: () => undefined
		});
		expect(badOut.exitCode).toBe(2);
		expect(badOut.message).toMatch(/missing a reason/i);

		const driftOut = await runCompare({
			mode: 'local',
			server: srv.origin,
			org: 'arbenger',
			mockup: 'm-drift',
			registration: 'dev-drift',
			manifest: {
				pairs: [{ ref: 'panel', appSelector: '.real-panel' }]
			},
			dir: repo,
			runnerToken: '',
			personalToken: 'p-tok',
			fetch,
			log: () => undefined
		});
		expect(driftOut.exitCode).toBe(1);
		const pair = driftOut.report!.pairs[0];
		expect(pair.diff.passed).toBe(false);
		expect(pair.diff.mismatches.map((m) => m.property)).toEqual([
			'backgroundColor',
			'w',
			'borderRadius'
		]);
		expect(pair.rankedLines[0]).toMatch(/^\[HIGH\] panel \(\.real-panel\) backgroundColor/);
		expect(pair.rankedLines[2]).toMatch(/^\[LOW\] panel \(\.real-panel\) borderRadius/);
	}, 60_000);

	it('withholds signed-in screenshots & raw DOM text when uploadSignedInPictures is false, storing hashes and counts only', async () => {
		const uploads: { filename: string; body: string }[] = [];
		const srv = await startMultiServer((_m, u, body) => {
			if (u.pathname === '/api/v1/runner/claim') {
				return {
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						job: {
							id: 'run-priv-1',
							project: { id: 'p-1', key: 'AFB', name: 'AFB' },
							item: { id: 'i-1', ref: ITEM, title: 'Private compare' },
							check: { id: 'c-1', key: 'PRIV', title: 'Private compare' }
						}
					})
				};
			}
			if (
				u.pathname === '/api/v1/runner/mockups/m-priv/url' ||
				u.pathname === '/api/v1/orgs/arbenger/mockups/m-priv/url'
			) {
				return {
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						url: `${srv.origin}/m/signed-priv/file`,
						relativePath: '/m/signed-priv/file',
						mockupId: 'm-priv',
						projectId: 'p-1',
						version: 1,
						kind: 'html',
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
						isolatedOrigin: true,
						devOnlySameHost: false,
						notice: null,
						isPublic: false
					})
				};
			}
			if (u.pathname.includes('/artifacts')) {
				uploads.push({
					filename: u.searchParams.get('filename') ?? '',
					body: body.toString('utf8')
				});
				return {
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ attachmentId: `att-${uploads.length}` })
				};
			}
			if (u.pathname === '/m/signed-priv/file') {
				return {
					status: 200,
					contentType: 'text/html; charset=utf-8',
					body: `<!doctype html><html><body><div data-ref="box">Hello</div></body></html>`
				};
			}
			if (u.pathname === '/api/v1/runner/runs/run-priv-1/finish') {
				return { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) };
			}
			return {
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: `<!doctype html><html><body><div class="box">Secret Account Name</div></body></html>`
			};
		});
		servers.push(srv.server);
		registerDevApp('dev-priv', srv.origin, false);
		saveProfile('arbenger', 'dev-priv', LOOPBACK_BIND, {
			cookies: [{ name: 'sid', value: 'user-session-secret', domain: '127.0.0.1', path: '/' }],
			origins: []
		});

		const srvHost = new URL(srv.origin).hostname;
		expect(srvHost).toBe('127.0.0.1');

		const out = await runCompare({
			mode: 'board',
			server: srv.origin,
			org: 'arbenger',
			mockup: 'm-priv',
			registration: 'dev-priv',
			manifest: { pairs: [{ ref: 'box', appSelector: '.box' }] },
			dir: repo,
			item: ITEM,
			key: 'PRIV',
			runId: 'run-priv-1',
			runnerToken: 'afx_tok',
			personalToken: null,
			fetch,
			log: () => undefined
		});
		expect(out.exitCode).toBe(1);
		expect(out.report?.signedInPicturesWithheld).toBe(true);
		expect(uploads.some((u) => u.filename.endsWith('.jpg'))).toBe(false);
		expect(uploads.map((u) => u.filename)).toEqual(['compare-summary.json']);
		expect(uploads[0].body).not.toContain('Secret Account Name');
		const summaryJson = JSON.parse(uploads[0].body) as {
			signedInPicturesWithheld: boolean;
			pairs: { mockupHash: string; appHash: string; mismatchCount: number }[];
		};
		expect(summaryJson.signedInPicturesWithheld).toBe(true);
		expect(summaryJson.pairs[0]?.mockupHash).toMatch(/^[a-f0-9]{64}$/);
		expect(summaryJson.pairs[0]?.appHash).toMatch(/^[a-f0-9]{64}$/);
		expect(summaryJson.pairs[0]?.mismatchCount).toBeGreaterThan(0);

		// Verify CLI routing rejects missing registration/flags cleanly or returns deterministic compare exit code
		const cliStdout: string[] = [];
		const cliCode = await checkMain({
			args: [
				'compare',
				'--mockup',
				'm-priv',
				'--registration',
				'dev-priv',
				'--server',
				srv.origin,
				'--org',
				'arbenger',
				'--widths',
				'390'
			],
			store: fileStore(home),
			fetch,
			personalToken: () => 'p-tok',
			log: () => undefined,
			out: (l) => cliStdout.push(l)
		});
		expect(cliCode).toBe(1);
		const resultLine = cliStdout.find((l) => l.startsWith('RESULT ')) ?? '';
		const resultPath = resultLine.slice('RESULT '.length).trim();
		expect(existsSync(resultPath)).toBe(true);
		expect(JSON.parse(readFileSync(resultPath, 'utf8')).passed).toBe(false);

		// Off-origin --path is refused cleanly without reaching outside origins
		const offOrigin = await runCompare({
			mode: 'local',
			server: srv.origin,
			org: 'arbenger',
			mockup: 'm-priv',
			registration: 'dev-priv',
			screens: [{ name: 'evil', screen: 'evil', path: '//127.0.0.1:5180/steal' }],
			widths: [1280],
			manifest: { pairs: [{ ref: 'card', appSelector: '.card' }] },
			dir: repo,
			runnerToken: 'tok',
			personalToken: 'p-tok',
			fetch,
			log: () => undefined
		});
		expect(offOrigin.exitCode).toBe(2);
		expect(offOrigin.message).toContain('Refused unsafe screen path');

		// Manual state driver in board compare does not crash on incomplete pair upload
		uploads.length = 0;
		const manualOut = await runCompare({
			mode: 'board',
			server: srv.origin,
			org: 'arbenger',
			mockup: 'm-priv',
			registration: 'dev-priv',
			screens: [{ name: 'home', screen: 'home', path: '/' }],
			states: ['two-factor'],
			widths: [1280],
			manifest: {
				pairs: [{ ref: 'card', appSelector: '.card' }],
				stateDrivers: [
					{ state: 'two-factor', mode: 'manual', instructions: 'Complete OTP in browser' }
				]
			},
			dir: repo,
			item: 'AFB-1',
			key: 'M1',
			runId: 'run-manual-1',
			runnerToken: 'runner-tok',
			personalToken: 'p-tok',
			fetch,
			log: () => undefined
		});
		expect(manualOut.exitCode).toBe(1);
		expect(manualOut.report?.passed).toBe(false);
		expect(manualOut.report?.totalNotCompared).toBe(1);
	}, 60_000);
});
