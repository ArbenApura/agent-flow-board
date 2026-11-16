// THE PORTABLE AFB-CHECKS TOOL AS A RUNNER: IT REGISTERS ITSELF ONCE, NEEDS NO ENVIRONMENT ROW FOR ITS PREVIEW, IS TOLD TO UPGRADE WHEN
// IT IS TOO OLD, AND THE OLDER SETUP SCREENS ARE A PER PROJECT SWITCH THAT ONLY MANAGERS CHANGE.

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { handleRunnerApi } from '../../src/lib/server/api/runner';
import {
	claimCheckJob,
	finishCheckRun,
	itemChecks,
	peekQueue,
	requestRun,
	runnerStatus,
	saveCheck
} from '../../src/lib/server/ops/checks';
import {
	listMyBridges,
	removeMyBridge,
	setMyBridgeProjects
} from '../../src/lib/server/ops/bridgeRunners';
import {
	TOOL_AUDIT_HEADER,
	TOOL_PROTOCOL_HEADER,
	authenticateRunner,
	createRunner,
	registerToolRunner
} from '../../src/lib/server/ops/environments';
import { createItem } from '../../src/lib/server/ops/items';
import { updateProject } from '../../src/lib/server/ops/projects';
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

	it('a member who may write registers their own tool, a viewer cannot, the token is shown once, and the same name replaces the old token', async () => {
		await expect(
			registerToolRunner(as('viewer'), { name: 'My PC afb-checks' })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		const first = await registerToolRunner(as('member'), { name: 'My PC afb-checks' });
		expect(first.token).toMatch(/^afx_/);
		expect(first.kind).toBe('tool');
		expect(first.projects).toBeGreaterThanOrEqual(1);
		expect(await authenticateRunner(db, first.token)).toMatchObject({
			kind: 'tool',
			name: 'My PC afb-checks'
		});
		const second = await registerToolRunner(as('member'), { name: 'My PC afb-checks' });
		expect(second.id).toBe(first.id);
		expect(await authenticateRunner(db, first.token)).toBeNull();
		expect(await authenticateRunner(db, second.token)).not.toBeNull();
		const listed = (await listMyBridges(as('member'))).bridges;
		expect(listed).toHaveLength(1);
		expect(JSON.stringify(listed)).not.toContain(second.token);
		// A tool named for projects serves only those
		const scoped = await registerToolRunner(as('member'), {
			name: 'Laptop afb-checks',
			projects: [w.projectKey]
		});
		expect(scoped.projects).toBe(1);
		await expect(
			registerToolRunner(as('member'), { name: 'Bad', projects: ['NOPE'] })
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
			]
		});
		await saveCheck(as('member'), { item: item.ref, key: 'M1', script: 'await page.goto("/")' });
		// Nothing is connected yet (the tools made by the earlier tests are removed first)
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const before = (await itemChecks(as('member'), item.ref)).targets.find(
			(t) => t.target === 'preview'
		)!;
		expect(before.available).toBe(false);
		expect(before.reason).toMatch(/afb-checks/);
		const tool = await registerToolRunner(as('member'), { name: 'Desk afb-checks' });
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

	it("there is no default target setting: a run that names no target is on the preview, the old field is ignored, and a pin or a person's saved choice still wins", async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const tool = await registerToolRunner(as('member'), { name: 'Target afb-checks' });
		// A tool counts as online once it has called the board
		await authenticateRunner(db, tool.token);
		const item = await createItem(as('member'), {
			project: w.projectKey,
			title: 'No default target',
			phases: [{ key: '1', title: 'B', steps: [{ text: 'x' }] }]
		});
		await saveCheck(as('member'), { item: item.ref, key: 'M1', script: 's' });
		await saveCheck(as('member'), { item: item.ref, key: 'M2', script: 's', pinnedTarget: 'dev' });
		// The old field is no longer part of a project update: sent by an older client, it changes nothing and breaks nothing
		await updateProject(as('admin'), { project: w.projectKey, defaultTarget: 'deployed' } as never);
		const view = await itemChecks(as('member'), item.ref);
		expect(view).not.toHaveProperty('defaultTarget');
		const plain = await requestRun(as('member'), { item: item.ref, key: 'M1' });
		expect(plain.target).toBe('preview');
		expect(plain.unavailable).toBe(false);
		// A pin on the check still wins over the preview
		expect((await requestRun(as('member'), { item: item.ref, key: 'M2' })).target).toBe('dev');
		// A person's own saved choice still wins too
		await db.admin.exec(
			`insert into user_pref (user_id, check_target) values ('${w.people.member}', 'deployed') on conflict (user_id) do update set check_target = 'deployed'`
		);
		expect((await requestRun(as('member'), { item: item.ref, key: 'M1' })).target).toBe('deployed');
		await db.admin.exec(`delete from user_pref where user_id = '${w.people.member}'`);
	});

	it('a hosted runner never takes the tool-only preview, and a tool that serves no project is not used for one', async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const item = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Hosted',
			phases: [{ key: '1', title: 'B', steps: [{ text: 'x' }] }]
		});
		await saveCheck(as('member'), { item: item.ref, key: 'M1', script: 's' });
		const tool = await registerToolRunner(as('member'), { name: 'Other afb-checks', projects: [] });
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
		await setMyBridgeProjects(as('member'), { id: tool.id, projects: [w.projectKey] });
		const fresh = (await authenticateRunner(db, tool.token))!;
		const asked = await requestRun(as('member'), { item: item.ref, key: 'M1', target: 'preview' });
		expect(asked.unavailable).toBe(false);
		expect(asked.run.result).toBe('queued');
		expect(await claimCheckJob(db, hostedAuth, services)).toBeNull();
		expect(await claimCheckJob(db, fresh, services)).not.toBeNull();
	});

	it('a tool stops working the moment the person who made it is removed or can no longer write', async () => {
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

	it("the head of the tool's audit chain is kept, and a log that got shorter or changed under the same length shows on runner_status as a regression", async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const tool = await registerToolRunner(as('admin'), { name: 'Audit afb-checks' });
		const hex = (c: string) => c.repeat(64);
		const report = (h: string) => call(tool.token, 'POST', '/peek', { [TOOL_AUDIT_HEADER]: h });
		const audit = async () => (await runnerStatus(as('admin'), w.projectKey)).projects[0].audit;
		expect(await audit()).toBeNull();
		expect((await report(`2:${hex('a')}`)).status).toBe(200);
		expect(await audit()).toEqual({ lines: 2, regressedAt: null });
		// The chain grows: no regression
		await report(`3:${hex('b')}`);
		expect(await audit()).toEqual({ lines: 3, regressedAt: null });
		// The same report again is not a regression
		await report(`3:${hex('b')}`);
		expect((await audit())?.regressedAt).toBeNull();
		// A header that is not in the form is ignored and changes nothing, and never breaks the call
		for (const bad of [
			'3',
			'x:y',
			`3:${hex('g')}`,
			`0:${hex('a')}`,
			`4:`,
			'-1:' + hex('a'),
			`99999999999:${hex('a')}`
		])
			expect((await report(bad)).status).toBe(200);
		expect(await audit()).toEqual({ lines: 3, regressedAt: null });
		// A shorter chain: the log was cut
		await report(`2:${hex('a')}`);
		const cut = await audit();
		expect(cut?.lines).toBe(2);
		expect(cut?.regressedAt).toBeInstanceOf(Date);
		// The same length with another head: the log was rewritten
		await db.admin.exec(`update runner set audit_regressed_at = null where org_id = '${w.orgId}'`);
		await report(`2:${hex('c')}`);
		expect((await audit())?.regressedAt).toBeInstanceOf(Date);
		// Only a count and a hash are kept: runner_status shows no head, and nothing else of the log
		expect(JSON.stringify(await audit())).not.toContain(hex('c'));
		// A runner that is not the tool is never recorded
		const hosted = await createRunner(as('admin'), {
			name: 'Hosted audit',
			kind: 'hosted',
			projects: [w.projectKey]
		});
		await call(hosted.token, 'POST', '/peek', { [TOOL_AUDIT_HEADER]: `7:${hex('d')}` });
		const rows = await db.admin.query<{ audit_lines: number | null }>(
			`select audit_lines from runner where id = '${hosted.id}'`
		);
		expect(rows[0].audit_lines).toBeNull();
	});

	it("a colleague's computer never takes my run, is never listed or counted, and I cannot change or remove it", async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const theirs = await registerToolRunner(as('admin'), { name: 'Their afb-checks' });
		const theirAuth = (await authenticateRunner(db, theirs.token))!;
		const item = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Not shared',
			phases: [{ key: '1', title: 'B', steps: [{ text: 'x' }] }]
		});
		await saveCheck(as('member'), { item: item.ref, key: 'M1', script: 's' });
		// Their computer is online, yet for me the preview target is not available and the status says nobody is online
		const mine = (await itemChecks(as('member'), item.ref)).targets.find(
			(t) => t.target === 'preview'
		)!;
		expect(mine.available).toBe(false);
		expect((await runnerStatus(as('member'), w.projectKey)).projects[0].online).toBe(false);
		expect((await runnerStatus(as('admin'), w.projectKey)).projects[0].online).toBe(true);
		const asked = await requestRun(as('member'), { item: item.ref, key: 'M1', target: 'preview' });
		expect(asked.unavailable).toBe(true);
		// A run that does sit queued for me is not taken, and does not wake, their computer
		await db.admin.exec(
			`update check_run set result = 'queued', finished_at = null where id = '${asked.run.id}'`
		);
		expect(await claimCheckJob(db, theirAuth, services)).toBeNull();
		expect(await peekQueue(db, theirAuth)).toBe(0);
		// I see none of their computers, and cannot change or remove one by its id
		expect((await listMyBridges(as('member'))).bridges).toHaveLength(0);
		await expect(
			setMyBridgeProjects(as('member'), { id: theirs.id, projects: [w.projectKey] })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(removeMyBridge(as('member'), theirs.id)).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		expect(await authenticateRunner(db, theirs.token)).not.toBeNull();
		// Their own list shows it, and a computer of mine takes my run
		expect((await listMyBridges(as('admin'))).bridges.map((b) => b.id)).toEqual([theirs.id]);
		const mineTool = await registerToolRunner(as('member'), { name: 'My afb-checks' });
		const mineAuth = (await authenticateRunner(db, mineTool.token))!;
		// Runs queued by earlier tests are closed, so the next one waiting for me is this one
		await db.admin.exec(
			`update check_run set result = 'error', finished_at = now() where result = 'queued' and id <> '${asked.run.id}'`
		);
		expect((await claimCheckJob(db, mineAuth, services))?.id).toBe(asked.run.id);
		// Removing my own computer ends the run it held with a plain reason
		await removeMyBridge(as('member'), mineTool.id);
		expect(await authenticateRunner(db, mineTool.token)).toBeNull();
		const [ended] = await db.admin.query<{ result: string; reason: string }>(
			`select result, reason from check_run where id = '${asked.run.id}'`
		);
		expect(ended.result).toBe('error');
		expect(ended.reason).toMatch(/removed/);
	});

	it('only a person who may write changes or removes their own computer, only for projects they may write to, and two registrations at once make one row', async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const mine = await registerToolRunner(as('member'), { name: 'Edges afb-checks' });
		// A viewer has no computer, and cannot change or remove one, even by its id
		await expect(
			setMyBridgeProjects(as('viewer'), { id: mine.id, projects: [w.projectKey] })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(removeMyBridge(as('viewer'), mine.id)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		// An unknown project is refused and changes nothing
		await expect(
			setMyBridgeProjects(as('member'), { id: mine.id, projects: ['NOPE'] })
		).rejects.toThrow();
		// A project this person may not write to is refused: a viewer of the project cannot opt a computer into it
		await db.admin.exec(
			`update member set role = 'viewer' where org_id = '${w.orgId}' and user_id = '${w.people.member}'`
		);
		await expect(
			setMyBridgeProjects(as('member'), { id: mine.id, projects: [w.projectKey] })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await db.admin.exec(
			`update member set role = 'member' where org_id = '${w.orgId}' and user_id = '${w.people.member}'`
		);
		// Two registrations of one computer at once end in one row, and its newest token is the one that works
		const [a, b] = await Promise.all([
			registerToolRunner(as('member'), { name: 'Twin afb-checks' }),
			registerToolRunner(as('member'), { name: 'Twin afb-checks' })
		]);
		const rows = await db.admin.query<{ id: string }>(
			`select id from runner where org_id = '${w.orgId}' and name = 'Twin afb-checks'`
		);
		expect(rows).toHaveLength(1);
		expect(a.id).toBe(b.id);
		const works = [await authenticateRunner(db, a.token), await authenticateRunner(db, b.token)];
		expect(works.filter(Boolean)).toHaveLength(1);
	});

	it('a tool older than the board expects is told to upgrade, and a runner program that names no version is unchanged', async () => {
		const tool = await registerToolRunner(as('admin'), { name: 'Old afb-checks' });
		const old = await call(tool.token, 'POST', '/peek', { [TOOL_PROTOCOL_HEADER]: '0' });
		expect(old.status).toBe(426);
		expect(JSON.stringify(old.body)).toMatch(/upgrade/);
		// Protocol 1 sent pages from a table; a capture now names none, so an older tool is told to upgrade
		expect((await call(tool.token, 'POST', '/peek', { [TOOL_PROTOCOL_HEADER]: '1' })).status).toBe(
			426
		);
		expect((await call(tool.token, 'POST', '/peek', { [TOOL_PROTOCOL_HEADER]: '2' })).status).toBe(
			200
		);
		expect((await call(tool.token, 'POST', '/peek')).status).toBe(200);
		expect(
			(await call(tool.token, 'POST', '/peek', { [TOOL_PROTOCOL_HEADER]: 'abc' })).status
		).toBe(426);
	});
});
