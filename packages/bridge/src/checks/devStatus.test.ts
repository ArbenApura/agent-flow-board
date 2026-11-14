// DOCTOR, STATUS & DEV-TARGET SAFETY TESTS (STEPS A.7 & A.9, AFB-20261113-1008)

// -- DEP-MODULES -- //
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	DEV_WRITE_GUARD_NOTE,
	cleanWriteAllowlist,
	devStatusFixLine,
	inspectDevEnvDatabase
} from './devPolicy.js';
import { inspectDevRegistration, runDoctor, runStatus } from './doctor.js';
import { DEFAULT_PROFILE, profileKey, saveProfile } from './profiles.js';
import { readRegistrations, registerProject } from './registry.js';
import { addRoot } from './roots.js';
import { cleanResult } from './sandbox.js';
import { mintApproval } from './approve.js';

// -- FUNCTIONS -- //

describe('doctor, status and dev-target safety (A.7 & A.9)', () => {
	let base = '';
	let work = '';
	let savedHome: string | undefined;

	beforeEach(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-devstatus-')));
		savedHome = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(base, 'bridge-home');
		work = join(base, 'repo');
		mkdirSync(join(work, '.git'), { recursive: true });
		work = realpathSync.native(work);
		const rootCode = mintApproval('roots', work, { isTTY: true });
		addRoot(work, rootCode.code);
	});

	afterEach(() => {
		if (savedHome === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = savedHome;
		rmSync(base, { recursive: true, force: true });
	});

	const ctx = () => ({ log: () => {}, out: () => {} });

	it('reports dev URL reachability, readiness mode, signed-in profile, and browser-layer write guard note', async () => {
		registerProject({
			org: 'arbenger',
			name: 'webapp',
			boardProject: 'WEBAPP',
			devUrl: 'http://127.0.0.1:4199'
		});
		saveProfile(
			'arbenger',
			'webapp',
			profileKey('http://127.0.0.1:4199', DEFAULT_PROFILE),
			{
				cookies: [
					{
						name: 'sess',
						value: 'secret-token-value',
						domain: '127.0.0.1',
						path: '/',
						expires: Math.floor(Date.now() / 1000) + 3600
					}
				],
				origins: []
			},
			{ profile: DEFAULT_PROFILE }
		);

		const status = await runStatus(ctx(), {
			browserInstalled: () => true,
			hasPermissionModel: () => true,
			probeDevUrl: async (url) => ({ ok: true, status: 200, url, mode: 'vite' })
		});
		const reg = status.registrations.find((r) => r.name === 'webapp');
		expect(reg?.kind).toBe('dev');
		expect(reg?.dev).toMatchObject({
			devUrl: 'http://127.0.0.1:4199',
			reachable: true,
			status: 'reachable',
			readinessMode: 'vite',
			signedIn: true,
			activeProfile: 'default',
			profiles: ['default'],
			code: null,
			fixLine: null
		});
		expect(reg?.dev?.writeGuardNote).toContain('Browser-layer only');
		expect(reg?.dev?.writeGuardNote).toContain('service workers blocked');
		expect(reg?.dev?.writeGuardNote).toContain('WebSocket');
		expect(DEV_WRITE_GUARD_NOTE).toContain('sendBeacon');
	});

	it('warns in doctor when dev DB is not throwaway, never leaking secrets, and refuses GET allowlist rules', async () => {
		writeFileSync(
			join(work, '.env.local'),
			'DATABASE_URL="postgresql://app:supersecret@127.0.0.1:5433/real_data"\n'
		);
		const dbWarn = inspectDevEnvDatabase(work);
		expect(dbWarn.nonThrowaway).toBe(true);
		expect(JSON.stringify(dbWarn)).not.toContain('supersecret');

		expect(() => cleanWriteAllowlist(['GET /api/items'])).toThrow(/not covered by approval/);

		registerProject({
			org: 'arbenger',
			name: 'webapp',
			boardProject: 'WEBAPP',
			devUrl: 'http://127.0.0.1:4199'
		});
		const doc = await runDoctor(
			ctx(),
			{ fix: false },
			{
				browserInstalled: () => true,
				hasPermissionModel: () => true,
				cwd: work,
				probeDevUrl: async () => ({
					ok: false,
					code: 'DEV_URL_UNREACHABLE',
					message: 'Connection refused'
				})
			}
		);
		expect(doc.ok).toBe(false);
		expect(doc.problems.some((p) => p.problem.includes('DEV_URL_UNREACHABLE'))).toBe(true);
		expect(doc.problems.some((p) => p.problem.includes('DEV_DB_NOT_THROWAWAY'))).toBe(true);
		expect(JSON.stringify(doc)).not.toContain('supersecret');
		expect(devStatusFixLine('DEV_URL_UNREACHABLE')).toBeTruthy();

		// Direct inspection of a registration carrying a GET allowlist rule surfaces DEV_ALLOWLIST_GET_REFUSED
		const target = readRegistrations().registrations.find((r) => r.name === 'webapp')!;
		const inspected = await inspectDevRegistration(
			{
				...target,
				allowWrites: true,
				writeAllowlist: [{ method: 'GET' as never, pathPrefix: '/api/v1/items' }]
			},
			{
				probeDevUrl: async (url) => ({ ok: true, status: 200, url, mode: 'vite' })
			}
		);
		expect(inspected.allowlistHasReadMethod).toBe(true);
		expect(inspected.code).toBe('DEV_ALLOWLIST_GET_REFUSED');

		// Fallback readiness surfaces DEV_FALLBACK_READINESS note in doctor without failing health
		const fallbackDoc = await runDoctor(
			ctx(),
			{ fix: false },
			{
				browserInstalled: () => true,
				hasPermissionModel: () => true,
				cwd: work,
				probeDevUrl: async (url) => ({ ok: true, status: 200, url, mode: 'fallback' })
			}
		);
		expect(fallbackDoc.notes?.some((n) => n.includes('DEV_FALLBACK_READINESS'))).toBe(true);

		// cleanResult preserves coldMs, warmMs, readinessMode and earlyChecks
		const cleaned = cleanResult(
			{
				schema: 1,
				result: 'pass',
				reason: null,
				durationMs: 1200,
				coldMs: 800,
				warmMs: 400,
				readinessMode: 'vite',
				earlyChecks: {
					shotsChecked: 4,
					maxCls: 0.02,
					clsViolations: 0,
					tapViolations: 0,
					passed: true
				},
				steps: [],
				log: 'ok',
				blockedWrites: 0,
				blockedOutside: 0
			},
			[]
		);
		expect(cleaned).toMatchObject({
			coldMs: 800,
			warmMs: 400,
			readinessMode: 'vite',
			earlyChecks: {
				shotsChecked: 4,
				maxCls: 0.02,
				clsViolations: 0,
				tapViolations: 0,
				passed: true
			}
		});
	});
});
