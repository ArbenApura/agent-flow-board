// THE COMPLETED RULES OF TESTING (AFB-20261127-0438): AN AGENT CANNOT CLOSE A PLAN WHOSE TESTS ARE MISSING, NOT RUN, FAILING OR
// REGRESSED; A PERSON CAN; PLANS FROM BEFORE TESTING STARTED ARE NEVER ASKED; A UI CASE OWED FOR WANT OF A BROWSER LETS IT CLOSE

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { upsertSection } from '../../src/lib/server/ops/docs';
import { createItem } from '../../src/lib/server/ops/items';
import { setStatus } from '../../src/lib/server/ops/status';
import {
	adoptCases,
	owedTests,
	recordResults,
	saveCase,
	startRun,
	waiverOf
} from '../../src/lib/server/ops/testing';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

describe('the testing helpers', () => {
	it('reads owed test lines and their state', () => {
		expect(
			owedTests(
				'- [ ] test: TC-AUTH-01 (no browser)\n- [x] test: TC-AUTH-02\n- [ ] deploy: the VPS'
			)
		).toEqual([
			{ key: 'TC-AUTH-01', note: 'no browser', done: false },
			{ key: 'TC-AUTH-02', note: '', done: true }
		]);
	});
	it('accepts only the fixed waiver reasons', () => {
		expect(waiverOf('Docs only: this plan rewrites the README.')).toBe('docs only');
		expect(waiverOf('Because I said so')).toBeNull();
		expect(waiverOf('')).toBeNull();
	});
});

describe('testing COMPLETED rules', () => {
	let db: TestDb;
	let w: World;
	const services = {
		storage: memoryStorage('testing-status-secret-0123456789'),
		baseUrl: 'https://afb.test'
	};
	const as = (who: keyof World['people']) => ({ ...w.ctx(who), services });
	const agent = () => ({ ...w.ctx('owner', { kind: 'agent' }), services });
	// A plan with no counted steps, so only the testing rules can refuse it
	const plan = async (title: string) =>
		(await createItem(as('member'), { project: w.projectKey, title })).ref as string;
	const close = (ref: string, who = agent()) =>
		setStatus(who, { item: ref, status: 'COMPLETED', note: 'Done at the board', confirmed: true });

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 120_000);
	afterAll(() => db?.stop());

	it('refuses an agent with tests-missing, and lets a waiver or a person through', async () => {
		const ref = await plan('Tests missing plan');
		await expect(close(ref)).rejects.toMatchObject({
			code: 'COMPLETED_REFUSED',
			details: { reason: 'tests-missing' }
		});
		await upsertSection(as('member'), {
			item: ref,
			slug: 'tests-waiver',
			title: 'Tests waiver',
			body: 'Docs only: no code runs.'
		});
		expect((await close(ref)).item.status).toBe('COMPLETED');
		const other = await plan('Person closes it');
		expect((await close(other, as('owner'))).item.status).toBe('COMPLETED');
	});

	it('refuses tests-not-run, then tests-failed, and lets the plan close once the case passes', async () => {
		const ref = await plan('Tests run plan');
		const made = await saveCase(agent(), {
			project: w.projectKey,
			area: 'AUTH',
			kind: 'api',
			title: 'Refuses a request with no token',
			steps: [{ action: 'Call /api/v1/items with no token' }],
			checks: [{ kind: 'text', expect: '401' }],
			devices: [],
			plan: ref
		});
		await expect(close(ref)).rejects.toMatchObject({ details: { reason: 'tests-not-run' } });
		const started = await startRun(agent(), { project: w.projectKey, item: ref });
		const result = (status: 'pass' | 'fail', output: string) =>
			recordResults(agent(), {
				run: started.run,
				results: [{ case: made.case.key, device: 'laptop', mode: 'light', status, output }]
			});
		await result('fail', 'got 200');
		await expect(close(ref)).rejects.toMatchObject({ details: { reason: 'tests-failed' } });
		await result('pass', 'got 401');
		expect((await close(ref)).item.status).toBe('COMPLETED');
	});

	it('refuses tests-regression when a case that passed before the plan fails now', async () => {
		const first = await plan('Regression first plan');
		const made = await saveCase(agent(), {
			project: w.projectKey,
			area: 'NOTES',
			kind: 'mcp',
			title: 'note_folder renames a folder',
			steps: [{ action: 'Rename a folder' }],
			checks: [{ kind: 'text', expect: 'renamed' }],
			devices: [],
			plan: first
		});
		const one = await startRun(agent(), { project: w.projectKey, item: first });
		await recordResults(agent(), {
			run: one.run,
			results: [
				{ case: made.case.key, device: 'laptop', mode: 'light', status: 'pass', output: 'ok' }
			]
		});
		const second = await plan('Regression second plan');
		await adoptCases(agent(), { item: second, cases: [{ key: made.case.key, role: 'reuse' }] });
		const two = await startRun(agent(), { project: w.projectKey, item: second });
		await recordResults(agent(), {
			run: two.run,
			results: [
				{
					case: made.case.key,
					device: 'laptop',
					mode: 'light',
					status: 'fail',
					output: 'kept the old name'
				}
			]
		});
		await expect(close(second)).rejects.toMatchObject({
			details: { reason: 'tests-regression', cases: [made.case.key] }
		});
	});

	it('refuses a UI pass with no screenshot, and lets a UI case owed for want of a browser through', async () => {
		const ref = await plan('No browser plan');
		const made = await saveCase(agent(), {
			project: w.projectKey,
			area: 'apps/web/booking',
			kind: 'ui',
			title: 'Book a slot from the centre page',
			steps: [{ action: 'Open the centre page and book' }],
			checks: [{ kind: 'text', expect: 'Booked' }],
			devices: [{ device: 'phone', width: 408, height: 840 }],
			plan: ref
		});
		expect(made.case.key).toBe('TC-BOOKING-01');
		const r = await startRun(agent(), { project: w.projectKey, item: ref });
		await expect(
			recordResults(agent(), {
				run: r.run,
				results: [{ case: made.case.key, device: 'phone', mode: 'light', status: 'pass' }]
			})
		).rejects.toMatchObject({ code: 'PROOF_REQUIRED' });
		await upsertSection(agent(), {
			item: ref,
			slug: 'owed',
			title: 'Owed',
			body: `- [ ] test: ${made.case.key} (no browser)`
		});
		expect((await close(ref)).item.status).toBe('COMPLETED');
	});

	it('skips a child that fails the testing rules when an agent closes its master', async () => {
		const master = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Master of tests'
		});
		const kid = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Child with no tests',
			parent: master.ref
		});
		await upsertSection(as('member'), {
			item: master.ref,
			slug: 'tests-waiver',
			title: 'Tests waiver',
			body: 'Docs only.'
		});
		const res = await close(master.ref);
		expect(res.skipped).toContainEqual({ ref: kid.ref, reason: 'tests-missing' });
	});

	it('never asks a plan made before its project started Testing', async () => {
		// The project's Testing started when the world was made; a plan dated before it is never asked
		const old = await plan('Plan made before Testing');
		await db.admin.exec(
			`update item set created_at = now() - interval '2 days' where ref = '${old}'`
		);
		expect((await close(old)).item.status).toBe('COMPLETED');
	});
});
