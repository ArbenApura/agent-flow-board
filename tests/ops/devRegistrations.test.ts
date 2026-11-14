// ACCESS AND REFUSAL TESTS FOR ADVISORY DEV REGISTRATIONS (STEP A.1, AFB-20261113-1008)
// Every refusal asserts zero database side effects, live role checks, tenant RLS and trust split.

// -- DEP-MODULES -- //
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { handleApi } from '../../src/lib/server/api/dispatch';
import { handleRunnerApi } from '../../src/lib/server/api/runner';
import { devRegistration, event } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import {
	DEV_WRITE_GUARD_NOTE,
	deleteDevRegistration,
	devStatusFixLine,
	listDevRegistrations,
	saveDevRegistration
} from '../../src/lib/server/ops/devRegistrations';
import {
	claimCheckJob,
	itemChecks,
	requestRun,
	runnerStatus,
	saveCheck
} from '../../src/lib/server/ops/checks';
import { createItem } from '../../src/lib/server/ops/items';
import { authenticateRunner, createRunner } from '../../src/lib/server/ops/environments';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const MASTER = 'test-master-key-for-the-vault-0123456789abcdef';

// -- FUNCTIONS -- //

describe('dev registrations trust split and refusals', () => {
	let db: TestDb;
	let w: World;
	const storage = memoryStorage();
	const services = { masterKey: MASTER, storage, runnerQueueMinutes: 10 };
	const as = (who: 'owner' | 'admin' | 'member' | 'viewer') => ({ ...w.ctx(who), services });
	const orgSlug = () => `world-${w.projectKey.slice(3)}`;

	const countRows = async (orgId = w.orgId) =>
		withTenant(db, { orgId }, async (tx) => (await tx.select().from(devRegistration)).length);

	const countEvents = async (orgId = w.orgId) =>
		withTenant(db, { orgId }, async (tx) => (await tx.select().from(event)).length);

	const apiCall = (
		method: 'GET' | 'PUT' | 'DELETE',
		path: string,
		who: 'owner' | 'admin' | 'member' | 'viewer' | 'guest',
		body?: unknown
	) =>
		handleApi(
			{
				method,
				path,
				query: {},
				headers: new Headers({ origin: 'http://board.test' }),
				body:
					body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body)),
				session: {
					id: w.ctx(who).actor.userId!,
					name: w.ctx(who).actor.label ?? who
				}
			},
			{ handle: db, baseUrl: 'http://board.test', masterKey: MASTER, storage }
		);

	const runnerCall = (bearer: string, body: unknown) =>
		handleRunnerApi(
			{
				method: 'POST',
				path: '/runner/dev-status',
				query: {},
				headers: new Headers({ authorization: `Bearer ${bearer}` }),
				body: new TextEncoder().encode(JSON.stringify(body)),
				session: null
			},
			{ handle: db, baseUrl: 'http://board.test', masterKey: MASTER, storage }
		);

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 240_000);

	afterAll(async () => {
		await db?.stop();
	});

	beforeEach(async () => {
		await db.admin.exec(`delete from dev_registration where org_id = '${w.orgId}'`);
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
	});

	it('refuses non-local URLs and missing ports with no side effect', async () => {
		for (const badUrl of [
			'https://example.com:5173',
			'http://192.168.1.25:5173',
			'http://localhost',
			'http://user:pass@localhost:5173',
			'http://localhost:5173/subpath',
			'ftp://localhost:5173'
		]) {
			await expect(
				saveDevRegistration(as('owner'), {
					project: w.projectKey,
					name: 'app',
					devUrl: badUrl
				})
			).rejects.toMatchObject({ code: 'INVALID' });
		}
		expect(await countRows()).toBe(0);
	});

	it('refuses reserved ports 5180, 5190 and 5433 with no side effect', async () => {
		for (const port of [5180, 5190, 5433]) {
			await expect(
				saveDevRegistration(as('owner'), {
					project: w.projectKey,
					name: 'app',
					devUrl: `http://localhost:${port}`
				})
			).rejects.toMatchObject({ code: 'FORBIDDEN' });
		}
		expect(await countRows()).toBe(0);
	});

	it('refuses non-managers (member and viewer) on save and delete with no side effect', async () => {
		await saveDevRegistration(as('owner'), {
			project: w.projectKey,
			name: 'app',
			devUrl: 'http://localhost:5173',
			profiles: ['patient']
		});

		for (const role of ['member', 'viewer'] as const) {
			await expect(
				saveDevRegistration(as(role), {
					project: w.projectKey,
					name: 'app',
					devUrl: 'http://127.0.0.1:4173'
				})
			).rejects.toMatchObject({ code: 'FORBIDDEN' });

			await expect(deleteDevRegistration(as(role), w.projectKey, 'app')).rejects.toMatchObject({
				code: 'FORBIDDEN'
			});
		}

		const rows = await listDevRegistrations(as('viewer'), w.projectKey);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.devUrl).toBe('http://localhost:5173');
	});

	it('refuses board-supplied startCommand, allowWrites or writeAllowlist through ops, API and runner', async () => {
		for (const badField of [
			{ startCommand: ['yarn', 'dev'] },
			{ allowWrites: true },
			{ writeAllowlist: [{ method: 'POST', pathPrefix: '/api' }] }
		]) {
			await expect(
				saveDevRegistration(as('owner'), {
					project: w.projectKey,
					name: 'app',
					devUrl: 'http://localhost:5173',
					...badField
				})
			).rejects.toMatchObject({ code: 'INVALID' });

			const apiRes = await apiCall(
				'PUT',
				`/orgs/${orgSlug()}/projects/${w.projectKey}/dev-registrations`,
				'owner',
				{ name: 'app', devUrl: 'http://localhost:5173', ...badField }
			);
			expect(apiRes.status).toBe(400);
		}
		expect(await countRows()).toBe(0);

		const created = await createRunner(as('owner'), {
			name: 'dev-runner',
			kind: 'local',
			projects: [w.projectKey]
		});
		const runRes = await runnerCall(created.token, {
			project: w.projectKey,
			name: 'app',
			devUrl: 'http://localhost:5173',
			status: 'reachable',
			startCommand: ['yarn', 'dev']
		});
		expect(runRes.status).toBe(400);
		expect(await countRows()).toBe(0);
	});

	it('lets managers save advisory facts and an authorised runner update status', async () => {
		const saved = await saveDevRegistration(as('admin'), {
			project: w.projectKey,
			name: 'web-dev',
			devUrl: 'http://[::1]:5173',
			profiles: ['patient', 'doctor'],
			activeProfile: 'patient'
		});
		expect(saved.devUrl).toBe('http://[::1]:5173');
		expect(saved.profiles).toEqual(['patient', 'doctor']);

		const created = await createRunner(as('owner'), {
			name: 'dev-runner',
			kind: 'local',
			projects: [w.projectKey]
		});
		const res = await runnerCall(created.token, {
			project: w.projectKey,
			name: 'web-dev',
			devUrl: 'http://[::1]:5173',
			status: 'reachable',
			reasonCode: 'DEV_URL_REACHABLE',
			activeProfile: 'doctor'
		});
		expect(res.status).toBe(200);

		const listRes = await apiCall(
			'GET',
			`/orgs/${orgSlug()}/projects/${w.projectKey}/dev-registrations`,
			'member'
		);
		expect(listRes.status).toBe(200);
		expect(listRes.body).toMatchObject([
			{
				name: 'web-dev',
				devUrl: 'http://[::1]:5173',
				activeProfile: 'doctor',
				lastStatus: 'reachable',
				lastReasonCode: 'DEV_URL_REACHABLE'
			}
		]);

		// Tenant isolation: another org sees zero rows under forced RLS
		const otherOrg = await makeWorld(db);
		const otherRows = await withTenant(db, { orgId: otherOrg.orgId }, async (tx) =>
			tx.select().from(devRegistration)
		);
		expect(otherRows).toHaveLength(0);
	});

	it('keeps API, runnerStatus and itemChecks in step with canonical fixed fix lines', async () => {
		const createdItem = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Dev check status test'
		});
		const created = await createRunner(as('owner'), {
			name: 'dev-runner-sync',
			kind: 'local',
			projects: [w.projectKey]
		});
		await runnerCall(created.token, {
			project: w.projectKey,
			name: 'app',
			devUrl: 'http://127.0.0.1:4199',
			status: 'unreachable',
			reasonCode: 'DEV_URL_UNREACHABLE',
			fixLine: 'Untrusted free-form text that must be ignored',
			profiles: ['default', 'admin'],
			activeProfile: 'admin'
		});

		const statusRes = await runnerStatus(as('member'), w.projectKey);
		const checksRes = await itemChecks(as('member'), createdItem.ref);
		expect(statusRes.projects[0]?.devTargets).toHaveLength(1);
		expect(checksRes.devTargets).toEqual(statusRes.projects[0]?.devTargets);
		expect(checksRes.devTargets[0]).toMatchObject({
			name: 'app',
			devUrl: 'http://127.0.0.1:4199',
			reachable: false,
			status: 'unreachable',
			signedIn: true,
			activeProfile: 'admin',
			profiles: ['default', 'admin'],
			code: 'DEV_URL_UNREACHABLE',
			fixLine: devStatusFixLine('DEV_URL_UNREACHABLE'),
			writeGuardNote: DEV_WRITE_GUARD_NOTE
		});
		expect(checksRes.devTargets[0]?.fixLine).not.toContain('Untrusted');
		const devTarget = checksRes.targets.find((t) => t.target === 'dev');
		expect(devTarget?.available).toBe(false);
		expect(devTarget?.reason).toContain('DEV_URL_UNREACHABLE');
	});

	it('refuses guest/non-manager REST calls, limited runners, invalid status, unknown reasonCode, and strips raw lastFixLine with no side effects', async () => {
		const eventsBefore = await countEvents();

		// Invalid lastStatus produces 400 INVALID (not 500) and writes 0 rows / 0 events
		const badStatus = await apiCall(
			'PUT',
			`/orgs/${orgSlug()}/projects/${w.projectKey}/dev-registrations`,
			'owner',
			{ name: 'app', devUrl: 'http://localhost:5173', lastStatus: 'broken' }
		);
		expect(badStatus.status).toBe(400);

		// Unknown reasonCode produces 400 INVALID and writes 0 rows
		const badCode = await apiCall(
			'PUT',
			`/orgs/${orgSlug()}/projects/${w.projectKey}/dev-registrations`,
			'owner',
			{
				name: 'app',
				devUrl: 'http://localhost:5173',
				lastStatus: 'unreachable',
				lastReasonCode: 'FAKE_CODE'
			}
		);
		expect(badCode.status).toBe(400);
		expect(await countRows()).toBe(0);
		expect(await countEvents()).toBe(eventsBefore);

		// Save valid row with raw lastFixLine attempt and verify lastFixLine is stripped / computed canonically
		const saved = await saveDevRegistration(as('owner'), {
			project: w.projectKey,
			name: 'app',
			devUrl: 'http://localhost:5173',
			lastStatus: 'unreachable',
			lastReasonCode: 'DEV_PROFILE_MISSING',
			lastFixLine: 'Arbitrary text that must never be served'
		});
		expect(saved.lastFixLine).not.toContain('Arbitrary');
		expect(saved.lastFixLine).toContain(`--org ${orgSlug()}`);
		expect(saved.writeGuardNote).toBe(DEV_WRITE_GUARD_NOTE);

		const eventsAfterSave = await countEvents();

		// Guest / member / viewer refused on REST PUT & DELETE with zero DB side effects (version and event count unchanged)
		for (const role of ['guest', 'member', 'viewer'] as const) {
			const expectedStatus = role === 'guest' ? 404 : 403;
			const putRes = await apiCall(
				'PUT',
				`/orgs/${orgSlug()}/projects/${w.projectKey}/dev-registrations`,
				role,
				{ name: 'app', devUrl: 'http://127.0.0.1:4173' }
			);
			expect(putRes.status).toBe(expectedStatus);

			const delRes = await apiCall(
				'DELETE',
				`/orgs/${orgSlug()}/projects/${w.projectKey}/dev-registrations/app`,
				role
			);
			expect(delRes.status).toBe(expectedStatus);
		}
		const currentRows = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(devRegistration)
		);
		expect(currentRows[0]?.version).toBe(1);
		expect(await countEvents()).toBe(eventsAfterSave);

		// Runner that serves zero projects is refused (403) with zero side effects
		const emptyRunner = await createRunner(as('owner'), {
			name: 'unscoped-runner',
			kind: 'local',
			projects: []
		});
		const deniedRun = await runnerCall(emptyRunner.token, {
			project: w.projectKey,
			name: 'app',
			devUrl: 'http://localhost:5173',
			status: 'reachable'
		});
		expect(deniedRun.status).toBe(403);
		const afterDenied = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(devRegistration)
		);
		expect(afterDenied[0]?.lastStatus).toBe('unreachable');
		expect(afterDenied[0]?.version).toBe(1);

		// Hosted runner is refused from reporting localhost dev targets (403)
		const hostedRunner = await createRunner(as('owner'), {
			name: 'hosted-runner',
			kind: 'hosted',
			projects: [w.projectKey]
		});
		const deniedHosted = await runnerCall(hostedRunner.token, {
			project: w.projectKey,
			name: 'app',
			devUrl: 'http://localhost:5173',
			status: 'reachable'
		});
		expect(deniedHosted.status).toBe(403);

		// Reachable dev target without an online private runner reports targetStatuses('dev') unavailable
		await saveDevRegistration(as('owner'), {
			project: w.projectKey,
			name: 'app',
			devUrl: 'http://localhost:5173',
			lastStatus: 'reachable'
		});
		const it = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Dev online gating',
			manualChecks: [{ key: 'M1', text: 'Dev server check' }]
		});
		const chkOffline = await itemChecks(as('member'), it.ref);
		expect(chkOffline.targets.find((t) => t.target === 'dev')?.available).toBe(false);
		expect(chkOffline.targets.find((t) => t.target === 'dev')?.reason).toContain('No local runner');

		// Once an online private-capable runner reports reachable, targetStatuses('dev') is available
		const localRunner = await createRunner(as('owner'), {
			name: 'local-runner',
			kind: 'local',
			projects: [w.projectKey]
		});
		const okReport = await runnerCall(localRunner.token, {
			project: w.projectKey,
			name: 'app',
			devUrl: 'http://localhost:5173',
			status: 'reachable'
		});
		expect(okReport.status).toBe(200);
		const chkOnline = await itemChecks(as('member'), it.ref);
		expect(chkOnline.targets.find((t) => t.target === 'dev')?.available).toBe(true);

		// Claiming a dev run resolves the dev registration with kind='dev', writeAllowed=false, versionPath=null
		await db.admin.exec(`update project set web_app = true where org_id = '${w.orgId}'`);
		await saveCheck(as('member'), { item: it.ref, key: 'M1', script: 'await page.goto("/")' });
		const req = await requestRun(as('member'), { item: it.ref, key: 'M1', target: 'dev' });
		expect(req.target).toBe('dev');
		const runnerAuth = await authenticateRunner(db, localRunner.token);
		const claimed = await claimCheckJob(db, runnerAuth!, services);
		expect(claimed?.environment).toMatchObject({
			name: 'app',
			url: 'http://localhost:5173',
			kind: 'dev',
			production: false,
			writeAllowed: false,
			versionPath: null
		});

		// Owner delete succeeds
		const delOk = await apiCall(
			'DELETE',
			`/orgs/${orgSlug()}/projects/${w.projectKey}/dev-registrations/app`,
			'owner'
		);
		expect(delOk.status).toBe(200);
		expect(await countRows()).toBe(0);
	});
});
