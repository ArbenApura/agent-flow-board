// HMR-AWARE READINESS TESTS WITH FAKE DEV SERVERS (STEP A.3, AFB-20261113-1008)

// IMPORTED DEP-MODULES
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { playwrightRuntimeDir } from './browser.js';
import {
	DEV_READINESS_FIX_LINES,
	DEV_READINESS_INIT_SCRIPT,
	DevReadinessError,
	type DevReadyPageLike,
	type DevReadinessSnapshot,
	installDevReadinessHook,
	waitForDevReady
} from './devReadiness.js';

// -- FUNCTIONS -- //

function makeFakePage(
	frames: DevReadinessSnapshot[],
	onLoad?: () => Promise<void>
): DevReadyPageLike {
	let idx = 0;
	return {
		async waitForLoadState(state) {
			if (state === 'load' && onLoad) await onLoad();
		},
		async evaluate() {
			const snap = frames[Math.min(idx, frames.length - 1)]!;
			idx++;
			return snap as never;
		}
	};
}

/** Tiny RFC 6455 WebSocket handshake + text frame helper for fake Vite HMR dev servers. */
function sendWsJson(socket: Duplex, payload: unknown): void {
	const data = Buffer.from(JSON.stringify(payload), 'utf8');
	const header =
		data.length < 126
			? Buffer.from([0x81, data.length])
			: Buffer.from([0x81, 126, (data.length >> 8) & 0xff, data.length & 0xff]);
	socket.write(Buffer.concat([header, data]));
}

function attachFakeViteWs(server: Server, onClient: (socket: Duplex) => void): void {
	server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
		const key = req.headers['sec-websocket-key'];
		if (!key) {
			socket.destroy();
			return;
		}
		const accept = createHash('sha1')
			.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest('base64');
		const proto = req.headers['sec-websocket-protocol'];
		const headers = [
			'HTTP/1.1 101 Switching Protocols',
			'Upgrade: websocket',
			'Connection: Upgrade',
			`Sec-WebSocket-Accept: ${accept}`,
			...(proto ? [`Sec-WebSocket-Protocol: ${String(proto).split(',')[0]!.trim()}`] : []),
			'',
			''
		];
		socket.write(headers.join('\r\n'));
		onClient(socket);
	});
}

describe('devReadiness', () => {
	const servers: Server[] = [];
	const sockets: Duplex[] = [];

	afterEach(async () => {
		for (const sock of sockets.splice(0)) sock.destroy();
		for (const s of servers.splice(0)) {
			s.closeAllConnections?.();
			await new Promise<void>((r) => s.close(() => r()));
		}
	});

	it('waits until Vite HMR is connected, pending updates drain, and network is idle', async () => {
		const page = makeFakePage([
			{
				viteDetected: true,
				hmrConnected: false,
				pendingUpdates: 0,
				inFlightNetwork: 0,
				overlayText: null
			},
			{
				viteDetected: true,
				hmrConnected: true,
				pendingUpdates: 1,
				inFlightNetwork: 1,
				overlayText: null
			},
			{
				viteDetected: true,
				hmrConnected: true,
				pendingUpdates: 0,
				inFlightNetwork: 0,
				overlayText: null
			},
			{
				viteDetected: true,
				hmrConnected: true,
				pendingUpdates: 0,
				inFlightNetwork: 0,
				overlayText: null
			},
			{
				viteDetected: true,
				hmrConnected: true,
				pendingUpdates: 0,
				inFlightNetwork: 0,
				overlayText: null
			}
		]);
		const res = await waitForDevReady(page, { timeoutMs: 2_000, settleMs: 20, pollMs: 10 });
		expect(res.mode).toBe('vite');
	});

	it('fails with DEV_OVERLAY_ERROR, fixed fix line, and redacted overlay detail when an error overlay appears', async () => {
		const secret = 'super-secret-database-password-12345';
		const page = makeFakePage([
			{
				viteDetected: true,
				hmrConnected: true,
				pendingUpdates: 0,
				inFlightNetwork: 0,
				overlayText: `SyntaxError in Login.svelte: bad token ${secret}`
			}
		]);
		let caught: unknown;
		try {
			await waitForDevReady(page, {
				timeoutMs: 1_000,
				settleMs: 10,
				redactionNeedles: [secret]
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(DevReadinessError);
		const err = caught as DevReadinessError;
		expect(err.code).toBe('DEV_OVERLAY_ERROR');
		expect(err.fixLine).toBe(DEV_READINESS_FIX_LINES.DEV_OVERLAY_ERROR);
		expect(err.detail).toContain('SyntaxError in Login.svelte');
		expect(err.detail).not.toContain(secret);
		expect(err.message).not.toContain(secret);
	});

	it('fails with DEV_HMR_DISCONNECTED when Vite never connects', async () => {
		const page = makeFakePage([
			{
				viteDetected: true,
				hmrConnected: false,
				pendingUpdates: 0,
				inFlightNetwork: 0,
				overlayText: null
			}
		]);
		await expect(
			waitForDevReady(page, { timeoutMs: 120, settleMs: 10, pollMs: 10 })
		).rejects.toMatchObject({
			code: 'DEV_HMR_DISCONNECTED',
			fixLine: DEV_READINESS_FIX_LINES.DEV_HMR_DISCONNECTED
		});
	});

	it('falls back to load plus settle window on non-Vite dev servers', async () => {
		const page = makeFakePage([
			{
				viteDetected: false,
				hmrConnected: false,
				pendingUpdates: 0,
				inFlightNetwork: 0,
				overlayText: null
			}
		]);
		const res = await waitForDevReady(page, { timeoutMs: 1_000, settleMs: 30 });
		expect(res.mode).toBe('fallback');
		expect(res.waitedMs).toBeGreaterThanOrEqual(20);
	});

	it('works end-to-end against a fake HTTP+WebSocket Vite dev server in Chromium', async () => {
		const pw = await import('playwright').catch(() => null);
		const exe = pw?.chromium?.executablePath?.();
		if (!pw || !exe || !existsSync(exe)) return;

		let mode: 'ok' | 'overlay' = 'ok';
		const srv = createServer((req, res) => {
			if (req.url === '/@vite/client') {
				res.writeHead(200, { 'content-type': 'application/javascript' });
				res.end(`
					const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
					const ws = new WebSocket(proto + '//' + location.host + '/?token=abc', 'vite-hmr');
					window.__testWs = ws;
				`);
				return;
			}
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end(
				mode === 'overlay'
					? `<!doctype html><html><body><script type="module" src="/@vite/client"></script><vite-error-overlay>Unexpected token at line 42</vite-error-overlay></body></html>`
					: `<!doctype html><html><body><h1>Fake Vite App</h1><script type="module" src="/@vite/client"></script></body></html>`
			);
		});
		servers.push(srv);
		attachFakeViteWs(srv, (sock) => {
			sockets.push(sock);
			sendWsJson(sock, { type: 'connected' });
		});
		await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
		const addr = srv.address();
		const port = typeof addr === 'object' && addr ? addr.port : 0;
		const url = `http://127.0.0.1:${port}/`;

		const browser = await pw.chromium.launch({ headless: true });
		try {
			const ctx = await browser.newContext();
			await installDevReadinessHook(ctx);
			expect(DEV_READINESS_INIT_SCRIPT).toContain('vite-hmr');
			const page = await ctx.newPage();
			await page.goto(url);
			const res = await waitForDevReady(page, { timeoutMs: 5_000, settleMs: 40 });
			expect(res.mode).toBe('vite');

			mode = 'overlay';
			await page.goto(url);
			let caught: unknown = null;
			try {
				await waitForDevReady(page, { timeoutMs: 5_000, settleMs: 40 });
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(Error);
			expect((caught as Error).name).toBe('DevReadinessError');
			expect(caught).toMatchObject({ code: 'DEV_OVERLAY_ERROR' });
		} finally {
			await browser.close();
		}
	}, 20_000);

	it('records a structured DEV_OVERLAY_ERROR failure and diagnostic shot in child without crashing on retry', async () => {
		const pw = await import('playwright').catch(() => null);
		const exe = pw?.chromium?.executablePath?.();
		const pwDir = playwrightRuntimeDir();
		const distChild = resolve(
			dirname(fileURLToPath(import.meta.url)),
			'../../dist/checks/child.js'
		);
		if (!pw || !exe || !existsSync(exe) || !pwDir || !existsSync(distChild)) return;

		const srv = createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end(
				'<!doctype html><html><body><vite-error-overlay>SyntaxError at App.svelte:12</vite-error-overlay></body></html>'
			);
		});
		servers.push(srv);
		await new Promise<void>((resolveListen) => srv.listen(0, '127.0.0.1', resolveListen));
		const addr = srv.address();
		const port = typeof addr === 'object' && addr ? addr.port : 0;
		const url = `http://127.0.0.1:${port}/`;

		const tmpRoot = mkdtempSync(join(tmpdir(), 'afb-child-devfail-'));
		const browserSrv = await pw.chromium.launchServer({ headless: true });
		try {
			const runDir = join(tmpRoot, 'run');
			const shotsDir = join(runDir, 'shots');
			mkdirSync(shotsDir, { recursive: true });
			const checkFile = join(tmpRoot, 'check.mjs');
			writeFileSync(
				checkFile,
				`export default async function ({ page, step }) {\n` +
					`  await step('Visit broken route', async () => {\n` +
					`    await page.goto(${JSON.stringify(url)});\n` +
					`  });\n` +
					`}\n`,
				'utf8'
			);
			const job = {
				baseUrl: url,
				ws: browserSrv.wsEndpoint(),
				storageState: null,
				checkFile,
				runDir,
				viewport: { width: 1280, height: 720 },
				extraHosts: [],
				needles: [],
				isDev: true
			};
			const childOut = await new Promise<{ code: number | null; stderr: string }>(
				(resolveChild, rejectChild) => {
					const child = spawn(process.execPath, [distChild], {
						cwd: runDir,
						env: { ...process.env, AFB_PLAYWRIGHT_DIR: pwDir },
						stdio: ['pipe', 'pipe', 'pipe']
					});
					let stderr = '';
					child.stderr.on('data', (d) => {
						stderr += d.toString();
					});
					child.on('error', rejectChild);
					child.on('close', (code) => resolveChild({ code, stderr }));
					child.stdin.end(JSON.stringify(job));
				}
			);
			expect(childOut.stderr).toBe('');
			expect(childOut.code).toBe(0);
			const result = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8')) as {
				result: string;
				reason: string | null;
				steps: { name: string; status: string; shot: string | null; error?: string }[];
			};
			expect(result.result).toBe('fail');
			expect(result.reason).toContain('DEV_OVERLAY_ERROR');
			expect(result.steps[0]?.name).toBe('Visit broken route');
			expect(result.steps[0]?.status).toBe('fail');
			expect(result.steps[0]?.shot).toBeTruthy();
			expect(existsSync(join(shotsDir, result.steps[0]!.shot!))).toBe(true);
		} finally {
			await browserSrv.close();
			rmSync(tmpRoot, { recursive: true, force: true });
		}
	}, 25_000);
});
