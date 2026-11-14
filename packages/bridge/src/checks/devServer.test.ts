// TESTS FOR DEV SERVER LIFECYCLE (STEP A.2, AFB-20261113-1008)
// Verifies reusing an already-answering dev server (never stopping or restarting it) and starting/owning/stopping --start servers.

// -- DEP-MODULES -- //
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// -- MODULES -- //
import { mintApproval } from './approve.js';
import { devApprovalTarget, devConfigHash } from './devPolicy.js';
import { ensureDevServer, DevServerError } from './devServer.js';
import { pidAlive } from './lock.js';
import { registerProject, saveRegistration } from './registry.js';
import { RunScope } from './scope.js';

// -- FUNCTIONS -- //

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createNetServer();
		srv.once('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			srv.close((err) => (err ? reject(err) : resolve(port)));
		});
	});
}

describe('devServer lifecycle', () => {
	let base = '';
	let savedHome: string | undefined;
	const servers: Server[] = [];

	beforeEach(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-devserver-')));
		savedHome = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(base, 'bridge-home');
		mkdirSync(process.env.AFB_BRIDGE_HOME, { recursive: true });
	});

	afterEach(async () => {
		for (const s of servers.splice(0)) {
			await new Promise<void>((r) => s.close(() => r()));
		}
		if (savedHome === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = savedHome;
		rmSync(base, { recursive: true, force: true });
	});

	it('reuses an already-answering dev server, announces once, and never stops it when RunScope closes', async () => {
		const srv = createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.end('ok');
		});
		servers.push(srv);
		await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
		const addr = srv.address();
		const port = typeof addr === 'object' && addr ? addr.port : 0;
		const devUrl = `http://127.0.0.1:${port}`;

		const hash = devConfigHash({ devUrl, startCommand: [process.execPath, '-v'] });
		const code = mintApproval('dev', devApprovalTarget('MYAPP', hash), { isTTY: true }).code;
		const reg = registerProject(
			{ org: 'acme', name: 'MYAPP', devUrl, startCommand: [process.execPath, '-v'] },
			{ dev: code }
		);

		const logs: string[] = [];
		const scope = new RunScope('rdev1');
		const res = await ensureDevServer(reg, scope, { log: (l) => logs.push(l) });
		expect(res).toEqual({ origin: devUrl, owned: false });
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatch(/already answering|reusing/i);

		await scope.close();
		// External dev server MUST still be alive and answering
		const check = await fetch(devUrl);
		expect(check.status).toBe(200);
	});

	it('starts, owns and stops a sealed --start dev server when nothing answers on devUrl', async () => {
		const port = await freePort();
		const devUrl = `http://127.0.0.1:${port}`;
		const { writeFileSync } = await import('node:fs');
		const serverScript = join(base, 'dev-srv.cjs');
		writeFileSync(
			serverScript,
			"require('http').createServer((q,s)=>{s.writeHead(200);s.end('owned')}).listen(Number(process.argv[2]),'127.0.0.1');\n"
		);
		const startCommand = [process.execPath, serverScript, String(port)];
		const hash = devConfigHash({ devUrl, startCommand });
		const code = mintApproval('dev', devApprovalTarget('MYAPP', hash), { isTTY: true }).code;
		const reg = registerProject(
			{ org: 'acme', name: 'MYAPP', devUrl, startCommand },
			{ dev: code }
		);

		const logs: string[] = [];
		const scope = new RunScope('rdev2');
		try {
			const res = await ensureDevServer(reg, scope, {
				log: (l) => logs.push(l),
				waitTimeoutMs: 10_000
			});
			expect(res.owned).toBe(true);
			expect(res.pid).toBeGreaterThan(0);
			const check = await fetch(devUrl);
			expect(await check.text()).toBe('owned');
		} finally {
			await scope.close();
		}

		// Owned server must be stopped once RunScope closes
		await expect(fetch(devUrl, { signal: AbortSignal.timeout(800) })).rejects.toThrow();
		if (logs.length && resHasPid(logs[0])) {
			const m = /pid (\d+)/.exec(logs[0] ?? '');
			if (m) expect(pidAlive(Number(m[1]))).toBe(false);
		}
	}, 15_000);

	it('refuses cleanly with DEV_URL_UNREACHABLE when nothing answers and no --start command is registered', async () => {
		const port = await freePort();
		const devUrl = `http://127.0.0.1:${port}`;
		const reg = registerProject({ org: 'acme', name: 'MYAPP', devUrl });
		const scope = new RunScope('rdev3');
		const spawnSpy = vi.fn();
		try {
			await expect(
				ensureDevServer(reg, scope, { spawnFn: spawnSpy as never })
			).rejects.toBeInstanceOf(DevServerError);
			await expect(
				ensureDevServer(reg, scope, { spawnFn: spawnSpy as never })
			).rejects.toMatchObject({
				code: 'DEV_URL_UNREACHABLE'
			});
			expect(spawnSpy).not.toHaveBeenCalled();
		} finally {
			await scope.close();
		}
	});

	it('refuses unapproved or tampered devApprovalHash even when reusing a running dev server or with no startCommand', async () => {
		const srv = createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.end('ok');
		});
		servers.push(srv);
		await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
		const addr = srv.address();
		const port = typeof addr === 'object' && addr ? addr.port : 0;
		const devUrl = `http://127.0.0.1:${port}`;

		const hash = devConfigHash({
			devUrl,
			startCommand: [],
			allowWrites: true,
			writeAllowlist: [{ method: 'POST', pathPrefix: '/api/drafts' }]
		});
		const code = mintApproval('dev', devApprovalTarget('MYAPP', hash), { isTTY: true }).code;
		const reg = registerProject(
			{
				org: 'acme',
				name: 'MYAPP',
				devUrl,
				allowWrites: true,
				writeAllowlist: [{ method: 'POST', pathPrefix: '/api/drafts' }]
			},
			{ dev: code }
		);
		const tampered = { ...reg, allowWrites: true, devApprovalHash: 'bad-hash' };
		saveRegistration(tampered);

		const scope = new RunScope('rdev4');
		const spawnSpy = vi.fn();
		try {
			await expect(
				ensureDevServer(tampered, scope, { spawnFn: spawnSpy as never })
			).rejects.toThrow(/is not approved for/);
			expect(spawnSpy).not.toHaveBeenCalled();
		} finally {
			await scope.close();
		}
	});
});

function resHasPid(line: string | undefined): boolean {
	return Boolean(line && /pid \d+/.test(line));
}
