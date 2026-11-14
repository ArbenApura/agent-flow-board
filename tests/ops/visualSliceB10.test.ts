// PHASE B VERTICAL-SLICE EXIT TEST (STEP B.10, AFB-20261113-1008)
// Proves end-to-end across real Postgres, real Runner/Mockup HTTP server, real Playwright two-context comparison, and real DB evidence storage:
// 1 screen, 1 width, hosted mockup (with externalized kit asset & HKDF signature) against a running local app, picture pair saved, and diff read (pass + drift).

// IMPORTED DEP-MODULES
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { handleRunnerApi } from '../../src/lib/server/api/runner';
import { attachment, checkRun, org } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import { isMockupKey } from '../../src/lib/server/mockups/keys';
import { serveMemberKitAsset, serveMemberMockup } from '../../src/lib/server/mockups/serve';
import { serveAttachmentResponse } from '../../src/lib/server/ops/attachments';
import { itemChecks, requestRun, saveCheck } from '../../src/lib/server/ops/checks';
import {
	authenticateRunner,
	registerToolRunner,
	saveEnvironment
} from '../../src/lib/server/ops/environments';
import { createItem } from '../../src/lib/server/ops/items';
import { publishMockup } from '../../src/lib/server/ops/mockups';
import { setMockupKit } from '../../src/lib/server/ops/mockupSettings';
import { addPhase } from '../../src/lib/server/ops/plan';
import { runCompare } from '../../packages/bridge/src/checks/compare';
import { devConfigHash } from '../../packages/bridge/src/checks/devPolicy';
import { saveRegistration } from '../../packages/bridge/src/checks/registry';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

const MOCKUP_SECRET = 'b10-vertical-slice-mockup-secret-0123456789abcdef';

async function sendWebResponse(nodeRes: import('node:http').ServerResponse, webRes: Response) {
	const headers: Record<string, string> = {};
	webRes.headers.forEach((v, k) => {
		headers[k] = v;
	});
	nodeRes.writeHead(webRes.status, headers);
	const buf = Buffer.from(await webRes.arrayBuffer());
	nodeRes.end(buf);
}

describe('B.10 vertical-slice exit (hosted mockup vs running app end-to-end)', () => {
	let db: TestDb;
	let w: World;
	let store: ReturnType<typeof memoryStorage>;
	let runnerToken: string;
	let orgSlug: string;
	let boardServer: Server;
	let boardOrigin: string;
	let appServer: Server;
	let appOrigin: string;
	let appBgColor = 'rgb(255, 255, 255)';
	let kitAssetHits = 0;
	let home = '';
	let repo = '';
	let beforeHome: string | undefined;

	const as = (who: keyof World['people']) => ({
		...w.ctx(who),
		services: { storage: store, baseUrl: boardOrigin }
	});

	beforeAll(async () => {
		beforeHome = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-b10-home-'));
		process.env.AFB_BRIDGE_HOME = home;
		repo = mkdtempSync(join(tmpdir(), 'afb-b10-repo-'));
		execFileSync('git', ['init', '-q'], { cwd: repo });

		db = await makePostgres();
		w = await makeWorld(db);
		const [orgRow] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select({ slug: org.slug }).from(org).where(eq(org.id, w.orgId))
		);
		orgSlug = orgRow.slug;
		await db.admin.exec(`update project set web_app = true where id = '${w.projectId}'`);
		store = memoryStorage();

		// Start real Runner + Mockup HTTP server backed by Postgres & storage
		boardServer = createServer(async (req, res) => {
			try {
				const chunks: Buffer[] = [];
				for await (const c of req) chunks.push(c as Buffer);
				const body = Buffer.concat(chunks);
				const u = new URL(req.url ?? '/', boardOrigin);

				if (u.pathname.startsWith('/api/v1/runner/')) {
					const query: Record<string, string> = {};
					u.searchParams.forEach((v, k) => {
						query[k] = v;
					});
					const headers = new Headers();
					for (const [k, v] of Object.entries(req.headers)) {
						if (typeof v === 'string') headers.set(k, v);
					}
					const out = await handleRunnerApi(
						{
							method: req.method ?? 'GET',
							path: u.pathname.replace(/^\/api\/v1/, ''),
							headers,
							query,
							body,
							session: null
						},
						{
							handle: db,
							storage: store,
							baseUrl: boardOrigin,
							mockupSecret: MOCKUP_SECRET,
							mockupOrigin: boardOrigin
						}
					);
					res.writeHead(out.status, {
						'content-type': 'application/json',
						...(out.headers ?? {})
					});
					res.end(JSON.stringify(out.body));
					return;
				}

				const kitMatch = /^\/mf\/kit\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(u.pathname);
				if (kitMatch) {
					kitAssetHits += 1;
					const webRes = await serveMemberKitAsset(
						{ handle: db, storage: store },
						MOCKUP_SECRET,
						{ org: kitMatch[1], project: kitMatch[2], kit: kitMatch[3], name: kitMatch[4] },
						{ exp: u.searchParams.get('exp'), sig: u.searchParams.get('sig') }
					);
					await sendWebResponse(res, webRes);
					return;
				}

				const mockMatch = /^\/mf\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(u.pathname);
				if (mockMatch) {
					const webRes = await serveMemberMockup(
						{ handle: db, storage: store },
						MOCKUP_SECRET,
						{
							org: mockMatch[1],
							project: mockMatch[2],
							mockup: mockMatch[3],
							version: mockMatch[4],
							kind: mockMatch[5]
						},
						{ exp: u.searchParams.get('exp'), sig: u.searchParams.get('sig') },
						Date.now(),
						boardOrigin
					);
					await sendWebResponse(res, webRes);
					return;
				}

				res.writeHead(404, { 'content-type': 'text/plain' });
				res.end('Not found');
			} catch (err) {
				res.writeHead(500, { 'content-type': 'text/plain' });
				res.end(err instanceof Error ? err.message : String(err));
			}
		});
		await new Promise<void>((resolve) =>
			boardServer.listen(0, '127.0.0.1', () => {
				const addr = boardServer.address() as { port: number };
				boardOrigin = `http://127.0.0.1:${addr.port}`;
				resolve();
			})
		);

		// Separate local running app server
		appServer = createServer((req, res) => {
			const u = new URL(req.url ?? '/', appOrigin);
			if (u.pathname === '/settings') {
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
				res.end(`<!doctype html><html><head><style>
					body { margin: 0; font-family: Arial, sans-serif; }
					.app-card {
						position: absolute; left: 20px; top: 20px; width: 320px; height: 100px;
						padding: 16px; border-radius: 8px; background-color: ${appBgColor};
						color: rgb(17, 24, 39); font-size: 16px; font-weight: 600; display: block;
						box-sizing: border-box;
					}
				</style></head><body>
					<section class="app-card">Account settings</section>
				</body></html>`);
				return;
			}
			res.writeHead(404, { 'content-type': 'text/plain' });
			res.end('nope');
		});
		await new Promise<void>((resolve) =>
			appServer.listen(0, '127.0.0.1', () => {
				const addr = appServer.address() as { port: number };
				appOrigin = `http://127.0.0.1:${addr.port}`;
				resolve();
			})
		);

		await saveEnvironment(
			{ ...w.ctx('admin'), services: { storage: store, baseUrl: boardOrigin } },
			{ project: w.projectKey, name: 'preview', url: appOrigin, kind: 'preview' }
		);
		const runner = await registerToolRunner(as('admin'), { name: 'b10-runner' });
		runnerToken = runner.token;
		await authenticateRunner(db, runnerToken);

		const devHash = devConfigHash({
			devUrl: appOrigin,
			startCommand: undefined,
			allowWrites: false,
			writeAllowlist: undefined
		});
		saveRegistration({
			org: orgSlug,
			name: 'b10-dev',
			boardProject: w.projectKey,
			repo,
			recipe: false,
			database: 'none',
			devUrl: appOrigin,
			allowWrites: false,
			devApprovalHash: devHash,
			adoptEnv: false,
			uploadSignedInPictures: false,
			createdAt: new Date().toISOString()
		});
	}, 120_000);

	afterAll(async () => {
		boardServer?.closeAllConnections?.();
		appServer?.closeAllConnections?.();
		await new Promise<void>((resolve) => boardServer?.close(() => resolve()));
		await new Promise<void>((resolve) => appServer?.close(() => resolve()));
		if (beforeHome === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = beforeHome;
		rmSync(home, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
		await db?.stop();
	});

	it('compares 1 screen at 1 width (hosted mockup vs running app), saves picture pair, and catches drift', async () => {
		const created = await createItem(as('admin'), {
			project: w.projectKey,
			title: 'B10 vertical slice item',
			visibility: 'private',
			manualChecks: [{ key: 'M1', text: 'Settings visual match', auto: true }]
		});
		const itemRef = created.item.ref;
		await addPhase(as('admin'), {
			item: itemRef,
			key: 'A',
			title: 'Build',
			steps: [{ key: 'A.1', text: 'Build settings card' }]
		});

		const padRules = Array.from(
			{ length: 400 },
			(_, idx) => `.unused-token-${idx} { color: rgb(1, 2, 3); padding: 1px; }`
		).join('\n');
		const kitHtml = `<!--afb-kit:start--><style>
			* { box-sizing: border-box; }
			body { margin: 0; font-family: Arial, sans-serif; }
			.card-box {
				position: absolute; left: 20px; top: 20px; width: 320px; height: 100px;
				padding: 16px; border-radius: 8px; background-color: rgb(255, 255, 255);
				color: rgb(17, 24, 39); font-size: 16px; font-weight: 600; display: block;
				box-sizing: border-box;
			}
			${padRules}
		</style><!--afb-kit:end-->`;
		await setMockupKit(as('admin'), { project: w.projectKey }, Buffer.from(kitHtml, 'utf8'));

		const mockupHtml = Buffer.from(
			`<!doctype html><html><head><title>Settings</title><!--afb-kit--></head><body>
				<main data-screen="settings" data-state="default">
					<section class="card-box" data-ref="card">Account settings</section>
				</main>
			</body></html>`,
			'utf8'
		);
		const published = await publishMockup(
			as('admin'),
			{ item: itemRef, title: 'Settings' },
			mockupHtml
		);

		await saveCheck(as('admin'), {
			item: itemRef,
			key: 'M1',
			script: '// compare script',
			requiredTarget: 'preview'
		});

		// 1. Passing run: app matches hosted mockup at 1280px
		appBgColor = 'rgb(255, 255, 255)';
		const reqPass = await requestRun(as('admin'), { item: itemRef, key: 'M1', target: 'preview' });
		expect(reqPass.unavailable).toBe(false);
		const passOut = await runCompare({
			mode: 'board',
			server: boardOrigin,
			org: orgSlug,
			mockup: `${published.mockup.id}@1`,
			registration: 'b10-dev',
			screens: [{ name: 'settings', screen: 'settings', path: '/settings' }],
			states: ['default'],
			widths: [1280],
			manifest: { pairs: [{ ref: 'card', appSelector: '.app-card' }] },
			dir: repo,
			item: itemRef,
			key: 'M1',
			runId: reqPass.run.id,
			runnerToken,
			personalToken: null,
			fetch,
			log: () => undefined
		});

		expect(passOut, passOut.message).toMatchObject({ exitCode: 0, runId: reqPass.run.id });
		expect(passOut.report?.passed).toBe(true);
		expect(passOut.report?.pairCount).toBe(1);
		expect(kitAssetHits).toBeGreaterThan(0);

		const checksAfterPass = await itemChecks(as('admin'), itemRef);
		const passRunView = checksAfterPass.checks[0].runs.find((r) => r.id === reqPass.run.id)!;
		expect(passRunView.result).toBe('pass');
		expect(passRunView.files.filter((f) => f.mime === 'image/jpeg')).toHaveLength(2);
		expect(passRunView.files.some((f) => f.filename === 'compare-diff.json')).toBe(true);

		const shotId = passRunView.files.find((f) => f.filename.startsWith('mockup-'))!.id;
		const [attRow] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(attachment).where(eq(attachment.id, shotId))
		);
		expect(isMockupKey(attRow.storageKey)).toBe(true);

		const picRes = await serveAttachmentResponse(as('admin'), shotId);
		expect(picRes.status).toBe(200);
		expect(picRes.headers.get('x-content-type-options')).toBe('nosniff');
		expect(picRes.headers.get('content-security-policy')).toContain('sandbox');

		// 2. Deliberate drift run: app background changes -> caught and recorded as fail with pair & diff
		appBgColor = 'rgb(220, 38, 38)';
		const reqFail = await requestRun(as('admin'), { item: itemRef, key: 'M1', target: 'preview' });
		expect(reqFail.unavailable).toBe(false);
		const failOut = await runCompare({
			mode: 'board',
			server: boardOrigin,
			org: orgSlug,
			mockup: `${published.mockup.id}@1`,
			registration: 'b10-dev',
			screens: [{ name: 'settings', screen: 'settings', path: '/settings' }],
			states: ['default'],
			widths: [1280],
			manifest: { pairs: [{ ref: 'card', appSelector: '.app-card' }] },
			dir: repo,
			item: itemRef,
			key: 'M1',
			runId: reqFail.run.id,
			runnerToken,
			personalToken: null,
			fetch,
			log: () => undefined
		});

		expect(failOut.exitCode).toBe(1);
		expect(failOut.report?.passed).toBe(false);
		expect(failOut.report?.totalMismatches).toBeGreaterThan(0);

		const [failRow] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(checkRun).where(eq(checkRun.id, reqFail.run.id))
		);
		expect(failRow.result).toBe('fail');
		expect(failRow.log).toContain('backgroundColor');
	}, 120_000);
});
