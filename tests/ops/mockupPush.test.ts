// THE BRIDGE COMMAND END TO END (AFB-20261107-0346): "agent-flow-board mockup push" OVER A REAL HTTP SERVER INTO THE API ROUTE'S OWN BODY LIMIT AND THE DISPATCHER
// A small node server stands in for the SvelteKit route and does exactly what it does (read the body up to its endpoint's cap, call handleApi).
// With AFB_PROOF_DIR set to a folder holding kit.html, mockup.html, keep.md, free.md and a PNG, the same test publishes those real files (the proof run of step 5.4).

// IMPORTED DEP-MODULES
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { RunnerBoard } from '../../packages/bridge/src/checks/board.js';
import { mintMockupUrlCli, pushMockup } from '../../packages/bridge/src/mockup.js';
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { bodyLimit, readBodyCapped } from '../../src/lib/server/api/body';
import { handleApi, type ApiDeps } from '../../src/lib/server/api/dispatch';
import { handleRunnerApi } from '../../src/lib/server/api/runner';
import { serveMemberMockup } from '../../src/lib/server/mockups/serve';
import { createRunner } from '../../src/lib/server/ops/environments';
import { createItem } from '../../src/lib/server/ops/items';
import { createProject } from '../../src/lib/server/ops/projects';
import { createToken } from '../../src/lib/server/ops/tokens';
import {
	getMockup,
	mintMockupUrl,
	publishMockup,
	readMockupHtml,
	setMockupPublicLink
} from '../../src/lib/server/ops/mockups';
import { readMockupKit } from '../../src/lib/server/ops/mockupSettings';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const PROOF = process.env.AFB_PROOF_DIR;
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

// -- FUNCTIONS -- //

describe('mockup push over http', () => {
	let db: TestDb;
	let w: World;
	let server: Server;
	let base = '';
	let dir = '';
	let slug = '';
	let memberToken = '';
	let adminToken = '';
	const SECRET = 'push-test-secret-0123456789abcdef';
	const storage = memoryStorage(SECRET);
	let mockupOriginOverride: string | undefined;
	const as = (who: keyof World['people']) => ({
		...w.ctx(who),
		services: { storage, baseUrl: 'http://x.test', mockupSecret: SECRET }
	});

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		slug = `world-${w.projectKey.slice(3)}`;
		const deps = (): ApiDeps => ({
			handle: db,
			storage,
			baseUrl: base || 'http://127.0.0.1',
			mockupSecret: SECRET,
			mockupOrigin: mockupOriginOverride
		});
		// The same steps the SvelteKit route takes: this endpoint's limit, the capped read, then the dispatcher
		server = createServer(async (req, res) => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			const path = url.pathname.replace(/^\/api\/v1/, '').replace(/\/+$/, '');
			const body =
				req.method === 'GET' || req.method === 'DELETE' ? 0 : bodyLimit(req.method ?? '', path);
			const request = new Request(url, {
				method: req.method,
				headers: req.headers as Record<string, string>,
				body: body === 0 ? undefined : (req as never),
				duplex: 'half'
			} as RequestInit);
			const bytes = body === 0 ? new Uint8Array() : await readBodyCapped(request, body);
			if (!bytes) {
				res
					.writeHead(413, { 'content-type': 'application/json' })
					.end('{"error":{"message":"Too large."}}');
				return;
			}
			const apiReq = {
				method: req.method ?? 'GET',
				path,
				query: Object.fromEntries(url.searchParams),
				headers: request.headers,
				body: bytes,
				session: null
			};
			const out = path.startsWith('/runner/')
				? await handleRunnerApi(apiReq, deps())
				: await handleApi(apiReq, deps());
			res
				.writeHead(out.status, { 'content-type': 'application/json' })
				.end(JSON.stringify(out.body));
		});
		await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		dir = mkdtempSync(join(tmpdir(), 'afb-push-'));
		memberToken = (
			await createToken(w.ctx('member'), {
				name: 'push-agent',
				permissions: ['read', 'comment', 'write', 'complete', 'delete']
			})
		).token;
		adminToken = (
			await createToken(w.ctx('admin'), {
				name: 'admin-agent',
				permissions: ['read', 'comment', 'write', 'complete', 'delete', 'manage']
			})
		).token;
	}, 120_000);
	afterAll(async () => {
		await new Promise<void>((ok) => server?.close(() => ok()));
		await db?.stop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	const opts = (file: string, token: string, extra: Record<string, unknown> = {}) => ({
		server: base,
		org: slug,
		token,
		fetch: (url: string, init?: RequestInit) => fetch(url, init),
		file,
		log: () => undefined,
		...extra
	});

	it('publishes a file with its notes and screenshot, and a second push is a new version of the same mockup', async () => {
		const item = (
			await createItem(as('member'), { project: w.projectKey, title: 'Push plan', ...PLAN })
		).ref;
		const page = join(dir, 'screen.html');
		writeFileSync(page, '<html><body><h1>Pushed</h1></body></html>');
		const shot = join(dir, 'shot.png');
		writeFileSync(shot, PNG);
		const first = await pushMockup(
			opts(page, memberToken, {
				item,
				keepNotes: 'Keep it.',
				freeNotes: 'Free it.',
				screenshot: shot
			})
		);
		expect(first).toMatchObject({ version: 1, notes: true, screenshot: true });
		expect(first.url).toBe(`${base}/${slug}/${w.projectKey}/mockups/${first.mockupId}`);
		const second = await pushMockup(opts(page, memberToken, { mockup: first.mockupId }));
		expect(second).toMatchObject({ mockupId: first.mockupId, version: 2 });
		const read = await getMockup(as('viewer'), first.mockupId, 1);
		expect(read.notes).toMatchObject({ keep: 'Keep it.', free: 'Free it.' });
		expect(read.versions).toHaveLength(2);
		// A version pushed with no notes carries the previous version's notes, and one field alone changes only that field
		expect((await getMockup(as('viewer'), first.mockupId, 2)).notes).toMatchObject({
			keep: 'Keep it.',
			free: 'Free it.'
		});
		await pushMockup(opts(page, memberToken, { mockup: first.mockupId, freeNotes: 'Free two.' }));
		expect((await getMockup(as('viewer'), first.mockupId, 3)).notes).toMatchObject({
			keep: 'Keep it.',
			free: 'Free two.'
		});
		expect((await readMockupHtml(as('viewer'), first.mockupId, { version: 1 })).html).toContain(
			'Pushed'
		);
		// A token that cannot write is told so in the server's own words
		const reader = (await createToken(w.ctx('member'), { name: 'reader', permissions: ['read'] }))
			.token;
		await expect(pushMockup(opts(page, reader, { item }))).rejects.toThrow(/403/);
		await expect(pushMockup(opts(page, 'afb_nonsense', { item }))).rejects.toThrow(/401/);
	});

	it('refuses a body over its own cap with a 413 while it streams, before the dispatcher reads it', async () => {
		const res = await fetch(
			`${base}/api/v1/orgs/${slug}/mockups/00000000-0000-4000-8000-000000000000/versions/1/screenshot`,
			{
				method: 'PUT',
				headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'image/png' },
				body: new Uint8Array(5 * 1024 * 1024 + 64 * 1024 + 1)
			}
		);
		expect(res.status).toBe(413);
	});

	it.skipIf(!PROOF || !existsSync(join(PROOF, 'mockup.html')))(
		'the proof run: the real AFB kit and a mockup of an AFB screen go up through the command',
		async () => {
			const proof = PROOF!;
			const kit = readFileSync(join(proof, 'kit.html'));
			const put = await fetch(
				`${base}/api/v1/orgs/${slug}/projects/${w.projectKey}/mockup-kit?builtFromCommit=${process.env.AFB_PROOF_COMMIT ?? 'unknown'}&summary=${encodeURIComponent('Tokens, fonts, logo, icons, the app shell and the common components of AFB.')}`,
				{ method: 'PUT', headers: { authorization: `Bearer ${adminToken}` }, body: kit }
			);
			expect(put.status).toBe(200);
			// The real kit meets its own contract: fonts embedded, icons present, both modes, a marked head
			expect(((await put.json()) as { warnings: string[] }).warnings).toEqual([]);
			const saved = await readMockupKit(as('member'), w.projectKey, { limit: 20 });
			expect(saved).toMatchObject({ number: 1, stale: false });
			const item = (
				await createItem(as('member'), {
					project: w.projectKey,
					title: 'The Mockups page',
					...PLAN
				})
			).ref;
			const result = await pushMockup(
				opts(join(proof, 'mockup.html'), memberToken, {
					item,
					title: 'Mockups page',
					keepNotes: readFileSync(join(proof, 'keep.md'), 'utf8'),
					freeNotes: readFileSync(join(proof, 'free.md'), 'utf8'),
					screenshot: join(proof, 'mockup-wide-light.png')
				})
			);
			expect(result).toMatchObject({ version: 1, notes: true, screenshot: true, warnings: [] });
			const read = await getMockup(as('viewer'), result.mockupId);
			// The page carries only the marker, so it stays small: the kit holds the fonts, icons and tokens
			expect(read.versions[0].size).toBeLessThan(50_000);

			// A deliberately bad copy: an emoji icon, a font from an https address, a font of its own and a literal colour
			const good = readFileSync(join(proof, 'mockup.html'), 'utf8');
			const bad = good
				.replace(
					'<!--afb-kit-->',
					`<!--afb-kit--><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><style>body{font-family:'Inter',sans-serif}.bad{color:#ff00aa}</style>`
				)
				.replace('<svg class="ic"><use href="#i-settings"/></svg>Settings', '\u2699 Settings');
			expect(bad).not.toBe(good);
			const badFile = join(dir, 'bad.html');
			writeFileSync(badFile, bad);
			const badResult = await pushMockup(
				opts(badFile, memberToken, { mockup: result.mockupId, title: 'Mockups page, bad copy' })
			);
			const badText = badResult.warnings.join('\n');
			expect(badText).toContain('from the network');
			expect(badText).toContain('fonts.googleapis.com');
			expect(badText).toContain("not one of the project's fonts");
			expect(badText).toContain('emoji or symbol');
			expect(badText).toContain("not one of the project's colours");
			expect(badResult.version).toBe(2);
			// Warnings never block: the bad copy was saved as version 2, and the clean one is still version 1
			expect((await readMockupKit(as('viewer'), w.projectKey))?.builtFromCommit).not.toBe('');
			writeFileSync(
				join(proof, 'result.json'),
				JSON.stringify({
					kitBytes: kit.length,
					mockupBytes: read.versions[0].size,
					version: result.version,
					notes: result.notes,
					screenshot: result.screenshot,
					warnings: result.warnings,
					badWarnings: badResult.warnings
				})
			);
		}
	);

	it('mints short-lived signed mockup URLs via API, CLI and runner API, respects MOCKUP_ORIGIN and public flag, and enforces access and trust split', async () => {
		const pubItem = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Mint target',
			...PLAN
		});
		const enc = (s: string) => new TextEncoder().encode(s);
		const published = await publishMockup(
			as('member'),
			{ item: pubItem.ref, title: 'Mintable screen' },
			enc('<html><body><main data-screen="home"><h1>Mint OK</h1></main></body></html>'),
			PNG
		);
		const privItem = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Private mint target',
			visibility: 'private',
			...PLAN
		});
		const privMockup = await publishMockup(
			as('member'),
			{ item: privItem.ref, title: 'Private screen' },
			enc('<html><body><h1>Private</h1></body></html>')
		);
		const secondProject = await createProject(as('owner'), { name: 'Other', key: 'OTH' });

		// Missing secret fails loudly instead of minting weak URLs
		await expect(
			mintMockupUrl(
				{ ...w.ctx('member'), services: { storage, baseUrl: base } },
				published.mockup.id
			)
		).rejects.toThrow('Mockup URL signing secret is not configured.');

		// Over-long ttl (> 300s) is refused by validation
		await expect(
			mintMockupUrlCli({
				server: base,
				org: slug,
				token: memberToken,
				fetch: (url, init) => fetch(url, init),
				mockup: published.mockup.id,
				ttlSeconds: 900
			})
		).rejects.toThrow();

		// CLI / REST API mint with no MOCKUP_ORIGIN falls back to baseUrl and stays private
		mockupOriginOverride = undefined;
		const cliRes = await mintMockupUrlCli({
			server: base,
			org: slug,
			token: memberToken,
			fetch: (url, init) => fetch(url, init),
			mockup: published.mockup.id,
			ttlSeconds: 120
		});
		expect(cliRes.isolatedOrigin).toBe(false);
		expect(cliRes.url.startsWith(`${base}/mf/`)).toBe(true);
		expect(cliRes.isPublic).toBe(false);
		const parsed = new URL(cliRes.url);
		const [, , orgId, projectId, mockupId, version, kind] = parsed.pathname.split('/');
		const served = await serveMemberMockup(
			{ handle: db, storage },
			SECRET,
			{ org: orgId, project: projectId, mockup: mockupId, version, kind },
			{ exp: parsed.searchParams.get('exp'), sig: parsed.searchParams.get('sig') }
		);
		expect(served.status).toBe(200);
		expect(await served.text()).toContain('Mint OK');

		// With MOCKUP_ORIGIN configured, newly minted URLs point to the isolated mockup origin
		mockupOriginOverride = 'https://mockups.example.test';
		const isolatedRes = await mintMockupUrlCli({
			server: base,
			org: slug,
			token: memberToken,
			fetch: (url, init) => fetch(url, init),
			mockup: published.mockup.id,
			screenshot: true
		});
		expect(isolatedRes.isolatedOrigin).toBe(true);
		expect(isolatedRes.url.startsWith('https://mockups.example.test/mf/')).toBe(true);
		expect(isolatedRes.url).toContain('/shot?');

		// Local runner API mints signed URL for projects it covers, and only reveals isPublic after opt-in
		const localRunner = await createRunner(as('owner'), {
			name: 'local-mint-runner',
			kind: 'local',
			projects: [w.projectKey]
		});
		const runnerBoard = new RunnerBoard(base, localRunner.token, (u, i) => fetch(u, i));
		const beforePub = await runnerBoard.mintMockupUrl(published.mockup.id);
		expect(beforePub.isolatedOrigin).toBe(true);
		expect(beforePub.url.startsWith('https://mockups.example.test/mf/')).toBe(true);
		expect(beforePub.isPublic).toBe(false);

		await setMockupPublicLink(as('admin'), published.mockup.id, true);
		const afterPub = await runnerBoard.mintMockupUrl(published.mockup.id);
		expect(afterPub.isPublic).toBe(true);
		expect(afterPub.url.startsWith('https://mockups.example.test/mf/')).toBe(true);

		// Private mockup stays refused to viewer, and never exposes publicUrl even if toggled
		await expect(mintMockupUrl(as('viewer'), privMockup.mockup.id)).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		await expect(runnerBoard.mintMockupUrl(privMockup.mockup.id)).rejects.toMatchObject({
			status: 404
		});

		// Scoped personal token on another project cannot mint for w.projectKey
		const otherToken = (
			await createToken(w.ctx('member'), {
				name: 'other-project-token',
				permissions: ['read'],
				projectIds: [secondProject.id]
			})
		).token;
		await expect(
			mintMockupUrlCli({
				server: base,
				org: slug,
				token: otherToken,
				fetch: (u, i) => fetch(u, i),
				mockup: published.mockup.id
			})
		).rejects.toThrow();

		// Hosted runner is refused from runner mockup URL minting, and local runner scoped elsewhere is refused
		const hostedRunner = await createRunner(as('owner'), {
			name: 'hosted-mint-runner',
			kind: 'hosted',
			projects: [w.projectKey]
		});
		const hostedBoard = new RunnerBoard(base, hostedRunner.token, (u, i) => fetch(u, i));
		await expect(hostedBoard.mintMockupUrl(published.mockup.id)).rejects.toMatchObject({
			status: 403
		});
		const otherRunner = await createRunner(as('owner'), {
			name: 'other-local-runner',
			kind: 'local',
			projects: [secondProject.key]
		});
		const otherBoard = new RunnerBoard(base, otherRunner.token, (u, i) => fetch(u, i));
		await expect(otherBoard.mintMockupUrl(published.mockup.id)).rejects.toMatchObject({
			status: 404
		});

		mockupOriginOverride = undefined;
	});
});
