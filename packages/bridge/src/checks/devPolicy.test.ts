// TRUST-SPLIT, HASH-BOUND APPROVAL AND REFUSAL TESTS FOR BRIDGE DEV TARGET (STEP A.1, AFB-20261113-1008)

// IMPORTED DEP-MODULES
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// IMPORTED MODULES
import { mintApproval } from './approve.js';
import {
	cleanDevUrl,
	cleanWriteAllowlist,
	devApprovalTarget,
	devConfigHash,
	probeDevUrl
} from './devPolicy.js';
import { guardContext } from './guard.js';
import {
	findRegistration,
	registerProject,
	saveRegistration,
	verifySealedDevCommand
} from './registry.js';

// -- FUNCTIONS -- //

describe('dev target bridge policy and refusals', () => {
	let base = '';
	let savedHome: string | undefined;

	beforeEach(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-devpolicy-')));
		savedHome = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(base, 'bridge-home');
		mkdirSync(process.env.AFB_BRIDGE_HOME, { recursive: true });
	});

	afterEach(() => {
		if (savedHome === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = savedHome;
		rmSync(base, { recursive: true, force: true });
	});

	it('refuses non-local URLs, missing ports and forbidden ports 5180, 5190, 5433 without saving', () => {
		for (const bad of [
			'https://staging.example.com:5173',
			'http://10.0.0.5:5173',
			'http://localhost',
			'http://localhost:5180',
			'http://127.0.0.1:5190',
			'http://[::1]:5433',
			'http://localhost:5173/app'
		]) {
			expect(() => cleanDevUrl(bad)).toThrow();
			expect(() => registerProject({ org: 'acme', name: 'MYAPP', devUrl: bad })).toThrow();
		}
		expect(findRegistration('acme', 'MYAPP')).toBeNull();
	});

	it('blocks cross-host and cross-port redirects when probing a dev URL', async () => {
		const crossHostFetch = vi.fn(
			async () =>
				new Response(null, { status: 302, headers: { location: 'https://evil.example/login' } })
		) as unknown as typeof fetch;
		const res = await probeDevUrl('http://localhost:5173', crossHostFetch);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe('DEV_CROSS_HOST_REDIRECT');

		const crossPortFetch = vi.fn(
			async () =>
				new Response(null, { status: 302, headers: { location: 'http://localhost:5180/' } })
		) as unknown as typeof fetch;
		const resPort = await probeDevUrl('http://localhost:5173', crossPortFetch);
		expect(resPort.ok).toBe(false);
		if (!resPort.ok) expect(resPort.code).toBe('DEV_CROSS_HOST_REDIRECT');
	});

	it('requires a hash-bound dev approval for startCommand/write allowlist and rejects hash mismatch with no save', () => {
		const input = {
			org: 'acme',
			name: 'MYAPP',
			devUrl: 'http://localhost:5173',
			startCommand: ['yarn', 'dev', '--port', '5173'],
			allowWrites: true,
			writeAllowlist: [{ method: 'POST' as const, pathPrefix: '/api/drafts' }]
		};
		expect(() => registerProject(input)).toThrow(/action dev/);
		expect(findRegistration('acme', 'MYAPP')).toBeNull();

		const hash = devConfigHash(input);
		const wrongHash = devConfigHash({ ...input, startCommand: ['yarn', 'evil'] });
		const badCode = mintApproval('dev', devApprovalTarget('MYAPP', wrongHash), {
			isTTY: true
		}).code;
		expect(() => registerProject(input, { dev: badCode })).toThrow(
			/wrong, used or expired|does not match/
		);
		expect(findRegistration('acme', 'MYAPP')).toBeNull();

		const goodCode = mintApproval('dev', devApprovalTarget('MYAPP', hash), { isTTY: true }).code;
		const saved = registerProject(input, { dev: goodCode });
		expect(saved.devApprovalHash).toBe(hash);
		expect(saved.startCommand).toEqual(['yarn', 'dev', '--port', '5173']);
		expect(verifySealedDevCommand(saved)).toEqual(['yarn', 'dev', '--port', '5173']);
	});

	it('never spawns a board-supplied startCommand and refuses tampered local approval hashes', () => {
		const input = {
			org: 'acme',
			name: 'MYAPP',
			devUrl: 'http://localhost:5173',
			startCommand: ['yarn', 'dev']
		};
		const hash = devConfigHash(input);
		const code = mintApproval('dev', devApprovalTarget('MYAPP', hash), { isTTY: true }).code;
		const reg = registerProject(input, { dev: code });

		expect(() => verifySealedDevCommand(reg, { startCommand: ['rm', '-rf', '/'] })).toThrow(
			/sealed locally/
		);
		const tampered = { ...reg, startCommand: ['node', '-e', 'evil()'] };
		saveRegistration(tampered);
		expect(() => verifySealedDevCommand(tampered)).toThrow(/is not approved for/);
	});

	it('refuses GET/HEAD/OPTIONS in the write allowlist and enforces write guard rules', async () => {
		expect(() => cleanWriteAllowlist(['GET /api/items'])).toThrow(/GET\/HEAD\/OPTIONS/);
		expect(() => cleanWriteAllowlist(['HEAD /api/items'])).toThrow(/GET\/HEAD\/OPTIONS/);
		expect(() => cleanWriteAllowlist(['OPTIONS /api/items'])).toThrow(/GET\/HEAD\/OPTIONS/);

		let handler: ((route: unknown) => Promise<void>) | undefined;
		const ctx = {
			route: async (_url: string, h: (route: unknown) => Promise<void>) => {
				handler = h;
			}
		};

		// Default: writes stopped even on same origin
		const counts = await guardContext(ctx as never, { origin: 'http://localhost:5173' });
		const aborted = vi.fn(async () => {});
		const continued = vi.fn(async () => {});
		await handler!({
			request: () => ({
				url: () => 'http://localhost:5173/api/save',
				method: () => 'POST',
				resourceType: () => 'fetch'
			}),
			abort: aborted,
			continue: continued,
			fulfill: vi.fn(async () => {})
		});
		expect(aborted).toHaveBeenCalledTimes(1);
		expect(continued).not.toHaveBeenCalled();
		expect(counts.writes).toBe(1);

		// Allowlist opt-in: lets matching POST /api/drafts through, stops DELETE /api/users
		const optCounts = await guardContext(ctx as never, {
			origin: 'http://localhost:5173',
			allowWrites: true,
			writeAllowlist: [{ method: 'POST', pathPrefix: '/api/drafts' }]
		});
		const aborted2 = vi.fn(async () => {});
		const continued2 = vi.fn(async () => {});
		await handler!({
			request: () => ({
				url: () => 'http://localhost:5173/api/drafts/1',
				method: () => 'POST',
				resourceType: () => 'fetch'
			}),
			abort: aborted2,
			continue: continued2,
			fulfill: vi.fn(async () => {})
		});
		expect(continued2).toHaveBeenCalledTimes(1);
		expect(optCounts.writes).toBe(0);

		await handler!({
			request: () => ({
				url: () => 'http://localhost:5173/api/users/1',
				method: () => 'DELETE',
				resourceType: () => 'fetch'
			}),
			abort: aborted2,
			continue: continued2,
			fulfill: vi.fn(async () => {})
		});
		expect(aborted2).toHaveBeenCalledTimes(1);
		expect(optCounts.writes).toBe(1);
	});
});
