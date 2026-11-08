// CLAIMING A RUN BY ITS ID (AFB-20261108-0827 STEP 3.1): the bridge asks for a run and claims that run only, and one process of a runner
// that stops gives back its own runs only. Without a run id the board behaves as before: the oldest queued run goes first.

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { handleApi } from '../../src/lib/server/api/dispatch';
import { handleRunnerApi } from '../../src/lib/server/api/runner';
import {
	claimCheckJob,
	getRun,
	releaseRunnerRuns,
	requestRun,
	saveCheck
} from '../../src/lib/server/ops/checks';
import { authenticateRunner, registerToolRunner } from '../../src/lib/server/ops/environments';
import { createItem } from '../../src/lib/server/ops/items';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const MASTER = 'test-master-key-for-the-vault-0123456789abcdef';

// -- FUNCTIONS -- //

describe('claiming a check run by its id', () => {
	let db: TestDb;
	let w: World;
	let n = 0;
	let token = '';
	let auth: NonNullable<Awaited<ReturnType<typeof authenticateRunner>>>;
	const services = { masterKey: MASTER, runnerQueueMinutes: 10 };
	const as = (who: 'owner' | 'admin' | 'member' | 'viewer') => ({ ...w.ctx(who), services });
	const call = (method: string, path: string, body = '') =>
		handleRunnerApi(
			{
				method,
				path: `/runner${path}`,
				query: {},
				headers: new Headers({ authorization: `Bearer ${token}` }),
				body: new TextEncoder().encode(body),
				session: null
			},
			{ handle: db, baseUrl: 'http://board.test', masterKey: MASTER }
		);
	/** A queued run, not yet claimed. */
	const queuedRun = async () => {
		const made = await createItem(as('member'), {
			project: w.projectKey,
			title: `Claim item ${++n}`,
			phases: [{ key: '1', title: 'Build', steps: [{ text: 'Run it' }] }],
			manualChecks: [{ key: 'M1', text: 'Works' }]
		});
		await saveCheck(as('member'), { item: made.ref, key: 'M1', script: 's' });
		await db.admin.exec(`update runner set last_seen_at = now()`);
		const run = await requestRun(as('member'), { item: made.ref, key: 'M1', target: 'preview' });
		return run.run.id as string;
	};
	const clear = () =>
		db.admin.exec(`update check_run set result = 'timeout' where result in ('queued','running')`);

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		await db.admin.exec(`update project set web_app = true where id = '${w.projectId}'`);
		token = (await registerToolRunner(as('admin'), { name: 'Claim PC afb-checks' })).token;
		auth = (await authenticateRunner(db, token))!;
	}, 240_000);
	afterAll(() => db?.stop());

	it('without a run id the oldest queued run goes first, as before', async () => {
		await clear();
		const first = await queuedRun();
		await queuedRun();
		expect((await claimCheckJob(db, auth, services))?.id).toBe(first);
		await clear();
	});

	it('with a run id only that run is taken, even when an older one is waiting', async () => {
		await clear();
		const older = await queuedRun();
		const wanted = await queuedRun();
		const job = await claimCheckJob(db, auth, services, { runId: wanted });
		expect(job?.id).toBe(wanted);
		// The older run was not touched
		expect((await getRun(as('member'), older)).result).toBe('queued');
		await clear();
	});

	it('a run id that is not queued, or does not exist, takes nothing', async () => {
		await clear();
		await queuedRun();
		expect(
			await claimCheckJob(db, auth, services, { runId: '00000000-0000-4000-8000-000000000000' })
		).toBeNull();
		const taken = await queuedRun();
		expect((await claimCheckJob(db, auth, services, { runId: taken }))?.id).toBe(taken);
		// Already running: a second claim by id gets nothing
		expect(await claimCheckJob(db, auth, services, { runId: taken })).toBeNull();
		await clear();
	});

	it('the runner API takes an optional body with the run id, and no body means the oldest run', async () => {
		await clear();
		const older = await queuedRun();
		const wanted = await queuedRun();
		const byId = await call('POST', '/claim', JSON.stringify({ runId: wanted }));
		expect(byId.status).toBe(200);
		expect((byId.body as { job: { id: string } | null }).job?.id).toBe(wanted);
		const plain = await call('POST', '/claim');
		expect((plain.body as { job: { id: string } | null }).job?.id).toBe(older);
		await clear();
	});

	it('the runner token of the bridge is refused on the personal endpoints', async () => {
		const res = await handleApi(
			{
				method: 'GET',
				path: '/me',
				query: {},
				headers: new Headers({ authorization: `Bearer ${token}` }),
				body: new Uint8Array(),
				session: null
			},
			{ handle: db, baseUrl: 'http://board.test', masterKey: MASTER }
		);
		expect(res.status).toBe(401);
	});

	it('giving runs back by id returns those runs only, and an empty list returns nothing', async () => {
		await clear();
		const a = await queuedRun();
		const b = await queuedRun();
		await claimCheckJob(db, auth, services, { runId: a });
		await claimCheckJob(db, auth, services, { runId: b });
		expect(await releaseRunnerRuns(db, auth, [])).toBe(0);
		expect(await releaseRunnerRuns(db, auth, [a])).toBe(1);
		expect((await getRun(as('member'), a)).result).toBe('queued');
		expect((await getRun(as('member'), b)).result).toBe('running');
		// Through the API: a body with runIds is scoped, no body gives back what is left
		const scoped = await call('POST', '/release', JSON.stringify({ runIds: [] }));
		expect((scoped.body as { released: number }).released).toBe(0);
		const rest = await call('POST', '/release');
		expect((rest.body as { released: number }).released).toBe(1);
		expect((await getRun(as('member'), b)).result).toBe('queued');
		await clear();
	});
});
