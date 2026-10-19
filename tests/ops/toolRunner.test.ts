// THE PORTABLE AFB-CHECKS TOOL AS A RUNNER: IT REGISTERS ITSELF ONCE, NEEDS NO ENVIRONMENT ROW FOR ITS PREVIEW, IS TOLD TO UPGRADE WHEN
// IT IS TOO OLD, AND THE OLDER SETUP SCREENS ARE A PER PROJECT SWITCH THAT ONLY MANAGERS CHANGE.

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { handleRunnerApi } from '../../src/lib/server/api/runner';
import {
	claimCheckJob,
	finishCheckRun,
	itemChecks,
	requestRun,
	saveCheck
} from '../../src/lib/server/ops/checks';
import {
	TOOL_PROTOCOL_HEADER,
	authenticateRunner,
	createRunner,
	listRunners,
	registerToolRunner,
	setRunnerProjects
} from '../../src/lib/server/ops/environments';
import { createItem } from '../../src/lib/server/ops/items';
import { updateProject } from '../../src/lib/server/ops/projects';
import { claimShotsJob, requestMeasure } from '../../src/lib/server/ops/uiShots';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const MASTER = 'test-master-key-for-the-vault-0123456789abcdef';

// -- FUNCTIONS -- //

describe('the afb-checks tool as a runner', () => {
	let db: TestDb;
	let w: World;
	const storage = memoryStorage();
	const services = { masterKey: MASTER, storage, runnerQueueMinutes: 10 };
	const as = (who: 'owner' | 'admin' | 'member' | 'viewer') => ({ ...w.ctx(who), services });
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

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		await db.admin.exec(`update project set web_app = true where id = '${w.projectId}'`);
	}, 240_000);
	afterAll(() => db?.stop());

	it('only a manager registers a tool, the token is shown once, and the same name replaces the old token', async () => {
		await expect(
			registerToolRunner(as('member'), { name: 'My PC afb-checks' })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		const first = await registerToolRunner(as('admin'), { name: 'My PC afb-checks' });
		expect(first.token).toMatch(/^afx_/);
		expect(first.kind).toBe('tool');
		expect(first.projects).toBeGreaterThanOrEqual(1);
		expect(await authenticateRunner(db, first.token)).toMatchObject({
			kind: 'tool',
			name: 'My PC afb-checks'
		});
		const second = await registerToolRunner(as('admin'), { name: 'My PC afb-checks' });
		expect(second.id).toBe(first.id);
		expect(await authenticateRunner(db, first.token)).toBeNull();
		expect(await authenticateRunner(db, second.token)).not.toBeNull();
		const listed = (await listRunners(as('admin'))).filter((r) => r.kind === 'tool');
		expect(listed).toHaveLength(1);
		expect(JSON.stringify(listed)).not.toContain(second.token);
		// A tool named for projects serves only those
		const scoped = await registerToolRunner(as('admin'), {
			name: 'Laptop afb-checks',
			projects: [w.projectKey]
		});
		expect(scoped.projects).toBe(1);
		await expect(
			registerToolRunner(as('admin'), { name: 'Bad', projects: ['NOPE'] })
		).rejects.toThrow();
	});

	it('a project needs no preview environment for the tool: the target is ready, the run is taken, and the tool closes it', async () => {
		const item = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Tool run',
			phases: [
				{
					key: '1',
					title: 'Build',
					steps: [{ text: 'Check it', requiredTarget: 'preview' as const }]
				}
			],
			manualChecks: [{ key: 'M1', text: 'Works', auto: true }]
		});
		await saveCheck(as('member'), { item: item.ref, key: 'M1', script: 'await page.goto("/")' });
		// Nothing is connected yet (the tools made by the earlier tests are removed first)
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const before = (await itemChecks(as('member'), item.ref)).targets.find(
			(t) => t.target === 'preview'
		)!;
		expect(before.available).toBe(false);
		expect(before.reason).toMatch(/afb-checks/);
		const tool = await registerToolRunner(as('admin'), { name: 'Desk afb-checks' });
		const auth = (await authenticateRunner(db, tool.token))!;
		const after = (await itemChecks(as('member'), item.ref)).targets.find(
			(t) => t.target === 'preview'
		)!;
		expect(after).toMatchObject({ available: true, environment: 'afb-checks' });
		// Dev and deployed still need their own environment
		expect(
			(await itemChecks(as('member'), item.ref)).targets.find((t) => t.target === 'deployed')!
				.available
		).toBe(false);
		const asked = await requestRun(as('member'), { item: item.ref, key: 'M1', target: 'preview' });
		expect(asked.unavailable).toBe(false);
		expect(asked.run.result).toBe('queued');
		const job = (await claimCheckJob(db, auth, services))!;
		expect(job.environment).toMatchObject({
			name: 'afb-checks',
			url: '',
			production: false,
			writeAllowed: false
		});
		expect(job.readOnly).toBe(false);
		const done = await finishCheckRun(
			db,
			auth,
			job.id,
			{ result: 'pass', commit: 'abc1234', diffHash: 'h1' },
			services
		);
		expect(done.result).toBe('pass');
	});

	it('a hosted runner never takes the tool-only preview, and a tool that serves no project is not used for one', async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const item = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Hosted',
			phases: [{ key: '1', title: 'B', steps: [{ text: 'x' }] }],
			manualChecks: [{ key: 'M1', text: 'w', auto: true }]
		});
		await saveCheck(as('member'), { item: item.ref, key: 'M1', script: 's' });
		const tool = await registerToolRunner(as('admin'), { name: 'Other afb-checks', projects: [] });
		const toolAuth = (await authenticateRunner(db, tool.token))!;
		const hosted = await createRunner(as('admin'), {
			name: 'Hosted',
			kind: 'hosted',
			projects: [w.projectKey]
		});
		const hostedAuth = (await authenticateRunner(db, hosted.token))!;
		// A hosted runner alone cannot take a preview that has no environment, and a tool serving nothing does not count
		const none = await requestRun(as('member'), { item: item.ref, key: 'M1', target: 'preview' });
		expect(none.unavailable).toBe(true);
		expect(await claimCheckJob(db, toolAuth, services)).toBeNull();
		expect(await claimCheckJob(db, hostedAuth, services)).toBeNull();
		// Once the tool serves the project the run is asked for and the tool takes it
		await setRunnerProjects(as('admin'), tool.id, [w.projectKey]);
		const fresh = (await authenticateRunner(db, tool.token))!;
		const asked = await requestRun(as('member'), { item: item.ref, key: 'M1', target: 'preview' });
		expect(asked.unavailable).toBe(false);
		expect(asked.run.result).toBe('queued');
		expect(await claimCheckJob(db, hostedAuth, services)).toBeNull();
		expect(await claimCheckJob(db, fresh, services)).not.toBeNull();
	});

	it('a UI shots run is taken by the tool without an environment row, and never from production', async () => {
		const tool = await registerToolRunner(as('admin'), { name: 'Shots afb-checks' });
		const auth = (await authenticateRunner(db, tool.token))!;
		await updateProject(as('admin'), { project: w.projectKey, referencePages: ['/a', '/b', '/c'] });
		const asked = await requestMeasure(as('admin'), w.projectKey, 'preview');
		expect(asked.state).toBe('queued');
		const job = await claimShotsJob(db, auth, services);
		expect(job).toMatchObject({
			kind: 'measure',
			afterTarget: 'preview',
			afterUrl: '',
			beforeUrl: null
		});
	});

	it('a tool stops working the moment the person who made it is removed or can no longer manage', async () => {
		const tool = await registerToolRunner(as('admin'), { name: 'Admin afb-checks' });
		expect(await authenticateRunner(db, tool.token)).not.toBeNull();
		await db.admin.exec(
			`update member set role = 'viewer' where org_id = '${w.orgId}' and user_id = '${w.people.admin}'`
		);
		expect(await authenticateRunner(db, tool.token)).toBeNull();
		await db.admin.exec(
			`update member set role = 'admin' where org_id = '${w.orgId}' and user_id = '${w.people.admin}'`
		);
		expect(await authenticateRunner(db, tool.token)).not.toBeNull();
		// A renewal that names no projects keeps the ones the tool serves, and every older token stops working
		const renewed = await registerToolRunner(as('admin'), { name: 'Admin afb-checks' });
		expect(await authenticateRunner(db, tool.token)).toBeNull();
		expect(await authenticateRunner(db, renewed.token)).toMatchObject({
			projectIds: expect.any(Array)
		});
	});

	it('a tool older than the board expects is told to upgrade, and a runner program that names no version is unchanged', async () => {
		const tool = await registerToolRunner(as('admin'), { name: 'Old afb-checks' });
		const old = await call(tool.token, 'POST', '/peek', { [TOOL_PROTOCOL_HEADER]: '0' });
		expect(old.status).toBe(426);
		expect(JSON.stringify(old.body)).toMatch(/upgrade/);
		expect((await call(tool.token, 'POST', '/peek', { [TOOL_PROTOCOL_HEADER]: '1' })).status).toBe(
			200
		);
		expect((await call(tool.token, 'POST', '/peek')).status).toBe(200);
		expect(
			(await call(tool.token, 'POST', '/peek', { [TOOL_PROTOCOL_HEADER]: 'abc' })).status
		).toBe(426);
	});
});
