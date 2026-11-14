// ONE MACHINE, MORE THAN ONE ORGANISATION: EACH ORGANISATION HAS ITS OWN TOOL RUNNER AND TOKEN, A TOKEN NEVER REACHES ANOTHER ORGANISATION'S RUNS, GIVING RUNS BACK TOUCHES ONLY THAT RUNNER'S, AND THE CAPACITY
// THE TOOL REPORTS IS ONLY SHOWN: STRICTLY PARSED, BOUNDED, AND NEVER USED TO DECIDE WHERE A RUN GOES.

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { handleRunnerApi } from '../../src/lib/server/api/runner';
import {
	claimCheckJob,
	peekQueue,
	releaseRunnerRuns,
	requestRun,
	runnerStatus,
	saveCheck
} from '../../src/lib/server/ops/checks';
import {
	TOOL_SLOTS_HEADER,
	authenticateRunner,
	listRunners,
	parseToolSlots,
	registerToolRunner,
	createRunner
} from '../../src/lib/server/ops/environments';
import { createItem } from '../../src/lib/server/ops/items';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const MASTER = 'test-master-key-for-the-vault-0123456789abcdef';

// -- FUNCTIONS -- //

describe('one tool machine serving more than one organisation', () => {
	let db: TestDb;
	let w: World;
	let n = 0;
	const storage = memoryStorage();
	const services = { masterKey: MASTER, storage, runnerQueueMinutes: 10 };
	const as = (who: 'owner' | 'admin' | 'member' | 'viewer') => ({ ...w.ctx(who), services });
	/** The second organisation of the world, as its owner. */
	const asOther = () => ({
		handle: db,
		orgId: w.other.orgId,
		services,
		actor: { userId: w.other.userId, kind: 'person' as const, label: 'other' }
	});
	const call = (
		bearer: string,
		method: string,
		path: string,
		headers: Record<string, string> = {}
	) =>
		handleRunnerApi(
			{
				method,
				path: `/runner${path}`,
				query: {},
				headers: new Headers({ authorization: `Bearer ${bearer}`, ...headers }),
				body: new TextEncoder().encode(''),
				session: null
			},
			{ handle: db, baseUrl: 'http://board.test', masterKey: MASTER, storage }
		);

	/** A queued run in the first organisation. */
	const queueRun = async () => {
		const made = await createItem(as('member'), {
			project: w.projectKey,
			title: `Multi org item ${++n}`,
			phases: [{ key: '1', title: 'Build', steps: [{ text: 'Run it' }] }],
			manualChecks: [{ key: 'M1', text: 'Works' }]
		});
		await saveCheck(as('member'), { item: made.ref, key: 'M1', script: 's' });
		await db.admin.exec(`update runner set last_seen_at = now()`);
		await requestRun(as('member'), { item: made.ref, key: 'M1', target: 'preview' });
		return made.ref;
	};

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		await db.admin.exec(
			`update project set web_app = true where id in ('${w.projectId}', '${w.other.projectId}')`
		);
	}, 240_000);
	afterAll(() => db?.stop());

	it('two organisations each have their own tool runner, and a token reaches its own organisation only', async () => {
		const mine = await registerToolRunner(as('admin'), { name: 'Shared PC afb-checks' });
		const theirs = await registerToolRunner(asOther(), { name: 'Shared PC afb-checks' });
		// The same machine name in two organisations is two runners, with two tokens that are not interchangeable
		expect(mine.id).not.toBe(theirs.id);
		expect(mine.token).not.toBe(theirs.token);
		const authMine = (await authenticateRunner(db, mine.token))!;
		const authTheirs = (await authenticateRunner(db, theirs.token))!;
		expect(authMine.orgId).toBe(w.orgId);
		expect(authTheirs.orgId).toBe(w.other.orgId);
		// A run queued in the first organisation is seen and claimed by its own tool and never by the other one
		await queueRun();
		expect(await peekQueue(db, authMine)).toBe(1);
		expect(await peekQueue(db, authTheirs)).toBe(0);
		expect(await claimCheckJob(db, authTheirs, services)).toBeNull();
		const job = await claimCheckJob(db, authMine, services);
		expect(job).not.toBeNull();
		// The tool of one organisation cannot beat or finish the run of another through the runner API
		expect(
			(await call(theirs.token, 'POST', `/runs/${job!.id}/beat`)).status
		).toBeGreaterThanOrEqual(400);
		expect((await call(mine.token, 'POST', `/runs/${job!.id}/beat`)).status).toBe(200);
		await db.admin.exec(
			`update check_run set result = 'timeout' where result in ('queued','running')`
		);
	});

	it('giving runs back touches only the runs of the runner that asks', async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const a = await registerToolRunner(as('admin'), { name: 'First PC afb-checks' });
		const b = await registerToolRunner(as('admin'), { name: 'Second PC afb-checks' });
		const authA = (await authenticateRunner(db, a.token))!;
		const authB = (await authenticateRunner(db, b.token))!;
		await queueRun();
		const heldByA = (await claimCheckJob(db, authA, services))!;
		await queueRun();
		const heldByB = (await claimCheckJob(db, authB, services))!;
		expect(heldByA.id).not.toBe(heldByB.id);
		expect(await releaseRunnerRuns(db, authA)).toBe(1);
		const state = async (id: string) =>
			(
				await db.admin.query<{ result: string; runner_id: string | null }>(
					`select result, runner_id from check_run where id = '${id}'`
				)
			)[0];
		expect(await state(heldByA.id)).toMatchObject({ result: 'queued', runner_id: null });
		expect(await state(heldByB.id)).toMatchObject({ result: 'running', runner_id: authB.runnerId });
		await db.admin.exec(
			`update check_run set result = 'timeout' where result in ('queued','running')`
		);
	});

	it('the capacity header is two small numbers, shown as they were reported, and anything else is ignored', async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		expect(TOOL_SLOTS_HEADER).toBe('x-afb-tool-slots');
		expect(parseToolSlots('3:2')).toEqual({ slots: 3, busy: 2 });
		for (const bad of [
			null,
			'',
			'3',
			'3:4',
			'0:0',
			'65:1',
			'3:-1',
			'3:2:1',
			'x:y',
			'3: 2',
			'003:2',
			`${'9'.repeat(40)}:1`,
			'3:2\n',
			' 3:2'
		])
			expect(parseToolSlots(bad), String(bad)).toBeNull();
		const tool = await registerToolRunner(as('admin'), { name: 'Slots afb-checks' });
		const capacity = async () =>
			(await runnerStatus(as('admin'), w.projectKey)).projects[0].capacity;
		expect(await capacity()).toBeNull();
		await call(tool.token, 'POST', '/peek', { [TOOL_SLOTS_HEADER]: '3:1' });
		expect(await capacity()).toEqual({ slots: 3, busy: 1, free: 2 });
		// A value that does not fit the form changes nothing and never breaks the call
		for (const bad of ['3:9', '999:1', 'abc', '3:1; drop table runner'])
			expect((await call(tool.token, 'POST', '/peek', { [TOOL_SLOTS_HEADER]: bad })).status).toBe(
				200
			);
		expect(await capacity()).toEqual({ slots: 3, busy: 1, free: 2 });
		// The list the Browser checks tab reads carries the same two numbers
		const listed = (await listRunners(as('admin'))).find((r) => r.id === tool.id);
		expect(listed).toMatchObject({ slots: 3, busy: 1 });
		// A runner that is not the tool never has a capacity recorded
		const hosted = await createRunner(as('admin'), {
			name: 'Hosted slots',
			kind: 'hosted',
			projects: [w.projectKey]
		});
		await call(hosted.token, 'POST', '/peek', { [TOOL_SLOTS_HEADER]: '5:5' });
		const rows = await db.admin.query<{ capacity_slots: number | null }>(
			`select capacity_slots from runner where id = '${hosted.id}'`
		);
		expect(rows[0].capacity_slots).toBeNull();
		// The capacity is never used to place a run: a tool that says every slot is busy still takes the next run
		await call(tool.token, 'POST', '/peek', { [TOOL_SLOTS_HEADER]: '3:3' });
		await queueRun();
		const auth = (await authenticateRunner(db, tool.token))!;
		expect(await claimCheckJob(db, auth, services)).not.toBeNull();
	});
});
