// TESTS FOR STEP B.5: `mockup inspect` AND MATCHING APP DOM DUMP (`inspect.ts` + `inspectApp.ts`).

// -- DEP-MODULES -- //
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { checkMain } from './command.js';
import { devConfigHash } from './devPolicy.js';
import { inspectMockupCli, inspectUrl, redactSignedAddress } from './inspect.js';
import { compareInspections } from './pairing.js';
import { saveRegistration } from './registry.js';
import { fileStore } from '../tokenStore.js';

// -- HELPERS -- //

function startServer(
	handler: (
		reqUrl: URL,
		cookieHeader: string
	) => { status: number; contentType: string; body: string }
): Promise<{ server: Server; origin: string }> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			const u = new URL(req.url ?? '/', 'http://127.0.0.1');
			const out = handler(u, String(req.headers.cookie ?? ''));
			res.writeHead(out.status, { 'content-type': out.contentType });
			res.end(out.body);
		});
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address() as { port: number };
			resolve({ server, origin: `http://127.0.0.1:${addr.port}` });
		});
	});
}

describe('mockup inspect & app DOM dump (B.5)', () => {
	let home = '';
	let repo = '';
	let beforeHome: string | undefined;
	const servers: Server[] = [];

	beforeEach(() => {
		beforeHome = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-inspect-home-'));
		process.env.AFB_BRIDGE_HOME = home;
		repo = mkdtempSync(join(tmpdir(), 'afb-inspect-repo-'));
		execFileSync('git', ['init', '-q'], { cwd: repo });
	});

	afterEach(async () => {
		for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
		if (beforeHome === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = beforeHome;
		rmSync(home, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	});

	it('refuses storageState on mockup target', async () => {
		await expect(
			inspectUrl({
				url: 'http://127.0.0.1:9999/m/tok/file',
				target: 'mockup',
				storageState: { cookies: [] }
			})
		).rejects.toThrow(/cannot accept saved sign-ins/i);
	});

	it('inspects hosted mockup screen/state/width and lists all data-refs, box, styles and text', async () => {
		let seenCookie = 'unset';
		const srv = await startServer((u, cookie) => {
			if (u.pathname === '/api/v1/orgs/arbenger/mockups/m-plan/url') {
				return {
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						url: `${srv.origin}/m/signed-v2/file?sig=ok`,
						relativePath: '/m/signed-v2/file?sig=ok',
						mockupId: 'm-plan',
						projectId: 'p-1',
						version: 2,
						kind: 'html',
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
						isolatedOrigin: true,
						devOnlySameHost: false,
						notice: null,
						isPublic: false
					})
				};
			}
			if (u.pathname === '/m/signed-v2/file') {
				seenCookie = cookie;
				return {
					status: 200,
					contentType: 'text/html; charset=utf-8',
					body: `<!doctype html>
<html>
<head>
<style>
  body { margin: 0; font-family: Arial, sans-serif; }
  [data-ref="card"] {
    width: 300px;
    padding: 16px;
    border-radius: 8px;
    background-color: rgb(255, 255, 255);
    color: rgb(17, 24, 39);
    font-size: 16px;
    font-weight: 600;
    display: flex;
    gap: 12px;
  }
  @media (max-width: 500px) {
    [data-ref="card"] { width: 200px; }
  }
</style>
</head>
<body>
  <div data-ref="card" id="main-card">Default</div>
  <button data-ref="cta">Save plan</button>
  <span data-ref="extra-badge">Beta</span>
  <script>
    const p = new URLSearchParams(location.search);
    const s = p.get('screen') || 'default';
    const st = p.get('state') || 'default';
    document.querySelector('[data-ref="card"]').textContent = s + ':' + st;
  </script>
</body>
</html>`
				};
			}
			return { status: 404, contentType: 'text/plain', body: 'not found' };
		});
		servers.push(srv.server);

		const dump = await inspectMockupCli({
			server: srv.origin,
			org: 'arbenger',
			token: 'personal-tok',
			mockup: 'm-plan@2',
			screen: 'settings',
			state: 'empty',
			width: 390,
			fetch,
			log: () => undefined
		});

		expect(seenCookie).toBe('');
		expect(dump.target).toBe('mockup');
		expect(dump.screen).toBe('settings');
		expect(dump.state).toBe('empty');
		expect(dump.width).toBe(390);
		expect(dump.elements.map((e) => e.ref)).toEqual(['card', 'cta', 'extra-badge']);

		const card = dump.elements.find((e) => e.ref === 'card')!;
		expect(card.present).toBe(true);
		expect(card.visible).toBe(true);
		expect(card.text).toBe('settings:empty');
		expect(card.box.w).toBeGreaterThanOrEqual(200);
		expect(card.box.w).toBeLessThan(260); // 390px media query sets 200px width + 32px padding = 232px
		expect(card.styles.display).toBe('flex');
		expect(card.styles.borderRadius).toBe('8px');
		expect(card.styles.backgroundColor).toBe('rgb(255, 255, 255)');
		expect(card.styles.fontSize).toBe('16px');
		expect(card.styles.fontWeight).toBe('600');
		expect(card.styles.gap).toBe('12px');
		expect(card.styles.paddingTop).toBe('16px');
		expect(card.styles.opacity).toBe('1');
	}, 60_000);

	it('inspects matching app target via `check inspect`, captures unlistedRefs, and pairs cleanly with compareInspections', async () => {
		const app = await startServer((u) => {
			return {
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: `<!doctype html>
<html>
<head>
<style>
  body { margin: 0; font-family: Arial, sans-serif; }
  .settings-card {
    position: absolute;
    left: 20px;
    top: 20px;
    width: 320px;
    height: 80px;
    padding: 16px;
    border-radius: 8px;
    background-color: rgb(255, 255, 255);
    color: rgb(17, 24, 39);
    font-size: 16px;
    font-weight: 600;
    display: block;
    box-sizing: border-box;
  }
</style>
</head>
<body>
  <div class="settings-card">${u.searchParams.get('screen') || 'home'}:${u.searchParams.get('state') || 'default'}</div>
  <div data-ref="unlisted-banner">Notice</div>
</body>
</html>`
			};
		});
		servers.push(app.server);

		const devHash = devConfigHash({
			devUrl: app.origin,
			startCommand: undefined,
			allowWrites: false,
			writeAllowlist: undefined
		});
		saveRegistration({
			org: 'arbenger',
			name: 'dev-local',
			boardProject: 'AFB',
			repo,
			recipe: false,
			database: 'none',
			devUrl: app.origin,
			allowWrites: false,
			devApprovalHash: devHash,
			adoptEnv: false,
			uploadSignedInPictures: false,
			createdAt: new Date().toISOString()
		});

		const stdout: string[] = [];
		const code = await checkMain({
			args: [
				'inspect',
				'dev-local',
				'--org',
				'arbenger',
				'--screen',
				'billing',
				'--state',
				'ready',
				'--width',
				'1280'
			],
			store: fileStore(home),
			fetch,
			personalToken: () => null,
			log: () => undefined,
			out: (l) => stdout.push(l)
		});
		expect(code).toBe(0);
		expect(stdout).toHaveLength(1);
		const rawAppDump = JSON.parse(stdout[0]) as {
			target: string;
			screen: string;
			state: string;
			width: number;
			elements: { ref: string }[];
			unlistedRefs?: string[];
		};
		expect(rawAppDump.target).toBe('app');
		expect(rawAppDump.screen).toBe('billing');
		expect(rawAppDump.state).toBe('ready');
		expect(rawAppDump.width).toBe(1280);
		expect(rawAppDump.elements.map((e) => e.ref)).toEqual(['unlisted-banner']);
		expect(rawAppDump.unlistedRefs).toEqual([]);

		const pairedApp = await inspectUrl({
			url: app.origin,
			target: 'app',
			screen: 'billing',
			state: 'ready',
			width: 1280,
			pairs: [{ ref: 'card', appSelector: '.settings-card' }]
		});
		expect(pairedApp.dump.elements[0]?.text).toBe('billing:ready');
		expect(pairedApp.dump.unlistedRefs).toEqual(['unlisted-banner']);

		const pairedMockup = await inspectUrl({
			url: app.origin,
			target: 'mockup',
			screen: 'billing',
			state: 'ready',
			width: 1280,
			pairs: [{ ref: 'card', appSelector: '.settings-card' }]
		});
		// Pretend mockup also had [data-ref="card"] missing here -> fails cleanly with missing-in-mockup
		const diff = compareInspections(pairedMockup.dump, pairedApp.dump, {
			pairs: [{ ref: 'card', appSelector: '.settings-card' }]
		});
		expect(diff.passed).toBe(false);
		expect(diff.notCompared.map((n) => n.reason)).toContain('missing-in-mockup');
		expect(diff.notCompared.map((n) => n.reason)).toContain('unmapped-mockup-ref');
	}, 60_000);

	it('redacts a signed address in one shared function, in any spelling (rule R1)', () => {
		// A goto failure: the URL with its exp and sig, in either order
		expect(
			redactSignedAddress(
				'net::ERR_CONNECTION_REFUSED at http://h.test/m/a/file?exp=1790000000&sig=deadbeef'
			)
		).toBe('net::ERR_CONNECTION_REFUSED at http://h.test/m/a/file?[hidden]');
		expect(redactSignedAddress('refused http://h.test/m/a/file?sig=deadbeef&exp=1790000000')).toBe(
			'refused http://h.test/m/a/file?[hidden]'
		);
		// A timeout whose Call log names the URL, in quotes, with the rest of the message kept
		const timeout =
			'TimeoutError: page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "http://h.test/m/a/file?sig=deadbeef", waiting until "load"';
		const redactedTimeout = redactSignedAddress(timeout);
		expect(redactedTimeout).not.toMatch(/sig=|exp=/);
		expect(redactedTimeout).toContain('Call log');
		// A URL with no query stays as it is
		expect(redactSignedAddress('http://h.test/m/a/file and back')).toBe(
			'http://h.test/m/a/file and back'
		);
		// An URL-encoded equals sign, also of the whole address tail
		expect(redactSignedAddress('sig%3Ddeadbeef')).toBe('[hidden]');
		expect(
			redactSignedAddress('navigating to "http%3A%2F%2Fh.test%2Fm%2Fa%2Ffile%3Fsig%3Ddeadbeef"')
		).toBe('navigating to "http%3A%2F%2Fh.test%2Fm%2Fa%2Ffile%3F[hidden]"');
		// A truncated tail: the value ends the message
		expect(redactSignedAddress('... at http://h.test/m/a/file?sig=dead')).toBe(
			'... at http://h.test/m/a/file?[hidden]'
		);
		// An ordinary page address keeps its query, and the word "exp" in prose stays
		expect(redactSignedAddress('http://h.test/app?page=2')).toBe('http://h.test/app?page=2');
		expect(redactSignedAddress('the exp of the token')).toBe('the exp of the token');
		// A signed file address of the board loses its query too
		expect(redactSignedAddress('PUT /api/v1/files/a/b?exp=1&sig=x refused')).toBe(
			'PUT /api/v1/files/a/b? refused'
		);
	});

	it('leaves no sig= or exp= in a failed mockup inspect (rule R1)', async () => {
		const srv = await startServer((u) => {
			if (u.pathname === '/api/v1/orgs/arbenger/mockups/m-plan/url')
				return {
					status: 403,
					contentType: 'application/json',
					body: JSON.stringify({
						error: { message: 'Forbidden for http://h.test/m/a/file?exp=1790000000&sig=deadbeef' }
					})
				};
			return { status: 404, contentType: 'text/plain', body: 'not found' };
		});
		servers.push(srv.server);
		await expect(
			inspectMockupCli({
				server: srv.origin,
				org: 'arbenger',
				token: 'afb_test_token_value',
				mockup: 'm-plan',
				fetch: (input, init) => fetch(input, init)
			})
		).rejects.toThrow(
			/^(?!.*(sig=|exp=))Forbidden for http:\/\/h\.test\/m\/a\/file\?\[hidden\] \(403\)$/
		);
	});
});
