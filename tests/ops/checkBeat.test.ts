// THE HEARTBEAT OF A RUN (AFB-20261019-0510 STEP 4.2): a tool that beats is held to its beat, a runner that never beats keeps the longer rule,
// a run the board gave up on cannot be finished by a late tool, and a beat is only accepted from the runner that holds the run.

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { handleRunnerApi } from '../../src/lib/server/api/runner';
import {
	BEAT_TIMEOUT_MINUTES,
	RUNNING_TIMEOUT_MINUTES,
	beatCheckRun,
	claimCheckJob,
	finishCheckRun,
	getRun,
	releaseRunnerRuns,
	requestRun,
	saveCheck
} from '../../src/lib/server/ops/checks';
import { authenticateRunner, registerToolRunner } from '../../src/lib/server/ops/environments';
import { createItem } from '../../src/lib/server/ops/items';
import { classifyRun } from '../../src/lib/shared/runErrors';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const MASTER = 'test-master-key-for-the-vault-0123456789abcdef';

// -- FUNCTIONS -- //

describe('the heartbeat of a run', () => {
	let db: TestDb;
	let w: World;
	let n = 0;
	let token = '';
	let auth: NonNullable<Awaited<ReturnType<typeof authenticateRunner>>>;
	const services = { masterKey: MASTER, runnerQueueMinutes: 10 };
	const as = (who: 'owner' | 'admin' | 'member' | 'viewer') => ({ ...w.ctx(who), services });
	const call = (bearer: string, method: string, path: string, body = '') =>
		handleRunnerApi(
			{
				method,
				path: `/runner${path}`,
				query: {},
				headers: new Headers({ authorization: `Bearer ${bearer}` }),
				body: new TextEncoder().encode(body),
				session: null
			},
			{ handle: db, baseUrl: 'http://board.test', masterKey: MASTER }
		);
	/** A run that a runner holds: queued, then taken. */
	const heldRun = async () => {
		const made = await createItem(as('member'), {
			project: w.projectKey,
			title: `Beat item ${++n}`,
			phases: [{ key: '1', title: 'Build', steps: [{ text: 'Run it' }] }],
			manualChecks: [{ key: 'M1', text: 'Works' }]
		});
		await saveCheck(as('member'), { item: made.ref, key: 'M1', script: 's' });
		await db.admin.exec(`update runner set last_seen_at = now()`);
		await requestRun(as('member'), { item: made.ref, key: 'M1', target: 'preview' });
		const job = (await claimCheckJob(db, auth, services))!;
		return { id: job.id, ref: made.ref };
	};
	const age = (id: string, startedMinutes: number, beatMinutes: number | null) =>
		db.admin.exec(
			`update check_run set started_at = now() - interval '${startedMinutes} minutes', last_beat_at = ${beatMinutes === null ? 'null' : `now() - interval '${beatMinutes} minutes'`} where id = '${id}'`
		);

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		await db.admin.exec(`update project set web_app = true where id = '${w.projectId}'`);
		token = (await registerToolRunner(as('admin'), { name: 'Beat PC afb-checks' })).token;
		auth = (await authenticateRunner(db, token))!;
	}, 240_000);
	afterAll(() => db?.stop());

	it('a beat is recorded for the run the runner holds, and a run that beats is not swept while it keeps beating', async () => {
		const run = await heldRun();
		expect(
			(
				await db.admin.query<{ b: string | null }>(
					`select last_beat_at as b from check_run where id = '${run.id}'`
				)
			)[0].b
		).toBeNull();
		const first = await beatCheckRun(db, auth, run.id);
		expect(first).toMatchObject({ ok: true, beatMinutes: BEAT_TIMEOUT_MINUTES });
		expect(
			(
				await db.admin.query<{ b: string | null }>(
					`select last_beat_at as b from check_run where id = '${run.id}'`
				)
			)[0].b
		).not.toBeNull();
		// A long healthy run: started 40 minutes ago (past the old 30 minute rule), beat a minute ago
		await age(run.id, 40, 1);
		expect((await getRun(as('member'), run.id)).result).toBe('running');
		// It can still finish
		await finishCheckRun(db, auth, run.id, { result: 'pass' }, services);
		expect((await getRun(as('member'), run.id)).result).toBe('pass');
	});

	it('a run whose beat stopped is reported stuck after ten minutes, with the code RUN_TIMED_OUT, and a late finish is refused with that code', async () => {
		const run = await heldRun();
		await beatCheckRun(db, auth, run.id);
		// Nine minutes of silence is not enough; eleven is
		await age(run.id, 12, 9);
		expect((await getRun(as('member'), run.id)).result).toBe('running');
		await age(run.id, 12, 11);
		const swept = await getRun(as('member'), run.id);
		expect(swept.result).toBe('timeout');
		expect(swept.reason).toMatch(
			new RegExp(`stopped reporting for ${BEAT_TIMEOUT_MINUTES} minutes`)
		);
		expect(swept.code).toBe('RUN_TIMED_OUT');
		expect(classifyRun('timeout', swept.reason).code).toBe('RUN_TIMED_OUT');
		// The tool comes back and tries to finish or to beat: both are refused, naming the code, and nothing is written
		for (const attempt of [
			() => finishCheckRun(db, auth, run.id, { result: 'pass' }, services),
			() => beatCheckRun(db, auth, run.id)
		])
			await expect(attempt()).rejects.toMatchObject({
				code: 'CONFLICT',
				details: { code: 'RUN_TIMED_OUT' }
			});
		expect((await getRun(as('member'), run.id)).result).toBe('timeout');
	});

	it('a runner that never beats (an older tool) keeps the longer rule: not swept at ten minutes, swept after thirty', async () => {
		const run = await heldRun();
		await age(run.id, BEAT_TIMEOUT_MINUTES + 5, null);
		expect((await getRun(as('member'), run.id)).result).toBe('running');
		await age(run.id, RUNNING_TIMEOUT_MINUTES - 1, null);
		expect((await getRun(as('member'), run.id)).result).toBe('running');
		await age(run.id, RUNNING_TIMEOUT_MINUTES + 1, null);
		const swept = await getRun(as('member'), run.id);
		expect(swept.result).toBe('timeout');
		expect(swept.reason).toMatch(/did not report back within 30 minutes/);
		expect(swept.code).toBe('RUN_TIMED_OUT');
	});

	it('only the runner that holds a run may beat for it, and a run that finished or does not exist is refused', async () => {
		const run = await heldRun();
		const other = await registerToolRunner(as('admin'), { name: 'Other PC afb-checks' });
		const otherAuth = (await authenticateRunner(db, other.token))!;
		await expect(beatCheckRun(db, otherAuth, run.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			beatCheckRun(db, auth, '00000000-0000-4000-8000-000000000000')
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await finishCheckRun(db, auth, run.id, { result: 'pass' }, services);
		await expect(beatCheckRun(db, auth, run.id)).rejects.toMatchObject({ code: 'CONFLICT' });
		// The same call through the runner API: 200 while running, 409 after, 401 with no token
		const live = await heldRun();
		const ok = await call(token, 'POST', `/runs/${live.id}/beat`);
		expect(ok.status).toBe(200);
		expect(ok.body).toMatchObject({ ok: true });
		expect((await call('afx_nonsense', 'POST', `/runs/${live.id}/beat`)).status).toBe(401);
		await finishCheckRun(db, auth, live.id, { result: 'error', reason: 'done' }, services);
		expect((await call(token, 'POST', `/runs/${live.id}/beat`)).status).toBe(409);
	});

	it('giving runs back clears their beat, so a run taken again starts without one', async () => {
		const run = await heldRun();
		await beatCheckRun(db, auth, run.id);
		expect(await releaseRunnerRuns(db, auth)).toBeGreaterThanOrEqual(1);
		const row = (
			await db.admin.query<{ result: string; b: string | null; r: string | null }>(
				`select result, last_beat_at as b, runner_id as r from check_run where id = '${run.id}'`
			)
		)[0];
		expect(row).toMatchObject({ result: 'queued', b: null, r: null });
		await db.admin.exec(
			`update check_run set result = 'timeout' where result in ('queued','running')`
		);
	});
});
