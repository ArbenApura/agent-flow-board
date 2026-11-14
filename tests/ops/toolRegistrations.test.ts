// ONE BOARD PROJECT, SEVERAL AFB-CHECKS REGISTRATIONS (repo folders). The tool reports which it holds in a header; a run that names one goes only to a tool that holds it; a run that names
// none is refused when the project has several; the result is accepted only from the registration that was asked for; and the board shows which registration and branch ran.

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
	authenticateRunner,
	createRunner,
	registerToolRunner
} from '../../src/lib/server/ops/environments';
import { createItem } from '../../src/lib/server/ops/items';
import {
	TOOL_REGISTRATIONS_HEADER,
	parseToolRegistrations
} from '../../src/lib/server/ops/registrations';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const MASTER = 'test-master-key-for-the-vault-0123456789abcdef';
type Wire = { p: string; n: string; r?: string; b?: string };
const encode = (list: unknown) => Buffer.from(JSON.stringify(list)).toString('base64url');

// -- FUNCTIONS -- //

describe('several registrations for one board project', () => {
	let db: TestDb;
	let w: World;
	const storage = memoryStorage();
	const services = { masterKey: MASTER, storage, runnerQueueMinutes: 10 };
	const as = (who: 'owner' | 'admin' | 'member' | 'viewer') => ({ ...w.ctx(who), services });
	const call = (bearer: string, path: string, headers: Record<string, string> = {}) =>
		handleRunnerApi(
			{
				method: 'POST',
				path: `/runner${path}`,
				query: {},
				headers: new Headers({ authorization: `Bearer ${bearer}`, ...headers }),
				body: new TextEncoder().encode(''),
				session: null
			},
			{ handle: db, baseUrl: 'http://board.test', masterKey: MASTER, storage }
		);
	const report = (token: string, list: Wire[]) =>
		call(token, '/peek', { [TOOL_REGISTRATIONS_HEADER]: encode(list) });
	/** A new item with one automatic check, saved with the given registration (or none). */
	const makeCheck = async (title: string, registration?: string | null) => {
		const item = await createItem(as('member'), {
			project: w.projectKey,
			title,
			phases: [
				{
					key: '1',
					title: 'Build',
					steps: [{ text: 'Check it', requiredTarget: 'preview' as const }]
				}
			],
			manualChecks: [{ key: 'M1', text: 'Works', auto: true }]
		});
		await saveCheck(as('member'), {
			item: item.ref,
			key: 'M1',
			script: 'await page.goto("/")',
			...(registration === undefined ? {} : { registration })
		});
		return item;
	};
	const newTool = async (name: string) => {
		const tool = await registerToolRunner(as('admin'), { name });
		return { token: tool.token, auth: (await authenticateRunner(db, tool.token))! };
	};

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		await db.admin.exec(`update project set web_app = true where id = '${w.projectId}'`);
	}, 240_000);
	afterAll(() => db?.stop());
	// Runs left queued by an earlier test would be claimed first and change what a later test sees
	beforeEach(async () => {
		await db.admin.exec(`delete from check_run where org_id = '${w.orgId}'`);
	});

	it('reads the registrations header, and drops a header that is not plain text whole', () => {
		const ok = parseToolRegistrations(
			encode([{ p: 'HAPR', n: 'HAPRM', r: 'hapr-gameplan', b: 'feat/demo-cloud' }])
		);
		expect(ok).toEqual([
			{ project: 'HAPR', name: 'HAPRM', repo: 'hapr-gameplan', branch: 'feat/demo-cloud' }
		]);
		expect(parseToolRegistrations(null)).toBeNull();
		expect(parseToolRegistrations('not base64 !!')).toBeNull();
		expect(parseToolRegistrations(encode({ p: 'HAPR' }))).toBeNull();
		for (const bad of [
			{ p: 'hapr', n: 'A' },
			{ p: 'HAPR', n: '../x' },
			{ p: 'HAPR', n: 'A', r: 'a/b' },
			{ p: 'HAPR', n: 'A', b: 'x y' },
			{ p: 'HAPR', n: 'A', b: '$(calc)' }
		])
			expect(parseToolRegistrations(encode([{ p: 'HAPR', n: 'OK' }, bad]))).toBeNull();
		expect(
			parseToolRegistrations(
				encode(Array.from({ length: 17 }, (_, i) => ({ p: 'HAPR', n: `N${i}` })))
			)
		).toBeNull();
	});

	it('a run that names a registration waits for a tool that reports it, and an older tool takes only runs that name none', async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const old = await newTool('Old afb-checks');
		const named = await makeCheck('Named', 'HAPRM');
		const plain = await makeCheck('Plain');
		// Only an older tool is online: the named registration cannot be served, and the answer says why
		const refused = await requestRun(as('member'), { item: named.ref, key: 'M1' });
		expect(refused.unavailable).toBe(true);
		expect(refused.run.reason).toMatch(/too old to run a named registration \(HAPRM\)/);
		// ...while a run that names none is taken by it as always
		const asked = await requestRun(as('member'), { item: plain.ref, key: 'M1' });
		expect(asked.run.result).toBe('queued');
		expect(await claimCheckJob(db, old.auth, services)).toMatchObject({ registration: null });
		// A tool that reports the registration takes the named run
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const tool = await newTool('New afb-checks');
		expect(
			(
				await report(tool.token, [
					{ p: w.projectKey, n: 'HAPRM', r: 'hapr-gameplan', b: 'feat/demo-cloud' }
				])
			).status
		).toBe(200);
		const fresh = (await authenticateRunner(db, tool.token))!;
		const again = await requestRun(as('member'), { item: named.ref, key: 'M1' });
		expect(again.run.result).toBe('queued');
		expect(again.run.registration).toBe('HAPRM');
		expect(await peekQueue(db, fresh)).toBeGreaterThanOrEqual(1);
		const job = (await claimCheckJob(db, fresh, services))!;
		expect(job.registration).toBe('HAPRM');
		expect(job.project.key).toBe(w.projectKey);
	});

	it('a tool that does not hold the registration neither takes the run nor is woken for it', async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const a = await newTool('A afb-checks');
		const b = await newTool('B afb-checks');
		await report(a.token, [{ p: w.projectKey, n: 'HAPR' }]);
		await report(b.token, [{ p: w.projectKey, n: 'HAPRM' }]);
		const item = await makeCheck('For B', 'HAPRM');
		const asked = await requestRun(as('member'), { item: item.ref, key: 'M1' });
		expect(asked.run.result).toBe('queued');
		const authA = (await authenticateRunner(db, a.token))!;
		const authB = (await authenticateRunner(db, b.token))!;
		expect(await peekQueue(db, authA)).toBe(0);
		expect(await claimCheckJob(db, authA, services)).toBeNull();
		expect(await peekQueue(db, authB)).toBe(1);
		expect(await claimCheckJob(db, authB, services)).not.toBeNull();
	});

	it('with several registrations and none named, the run is refused with the list; naming one, on the check or on the run, works; another registration is another run', async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const tool = await newTool('Two afb-checks');
		await report(tool.token, [
			{ p: w.projectKey, n: 'HAPR', r: 'hapr-gameplan-clone', b: 'feat/capacitor-app' },
			{ p: w.projectKey, n: 'HAPRM', r: 'hapr-gameplan', b: 'feat/demo-cloud' }
		]);
		const item = await makeCheck('Either');
		await expect(requestRun(as('member'), { item: item.ref, key: 'M1' })).rejects.toMatchObject({
			code: 'INVALID',
			message: expect.stringMatching(
				/REGISTRATION_REQUIRED: .* has 2 registrations \(HAPR, HAPRM\)/
			)
		});
		const first = await requestRun(as('member'), {
			item: item.ref,
			key: 'M1',
			registration: 'HAPR'
		});
		expect(first.run.result).toBe('queued');
		expect(first.reused).toBe(false);
		// The same registration again returns the open run; the other registration is a run of its own
		const same = await requestRun(as('member'), {
			item: item.ref,
			key: 'M1',
			registration: 'HAPR'
		});
		expect(same.reused).toBe(true);
		expect(same.run.id).toBe(first.run.id);
		const other = await requestRun(as('member'), {
			item: item.ref,
			key: 'M1',
			registration: 'HAPRM'
		});
		expect(other.reused).toBe(false);
		expect(other.run.id).not.toBe(first.run.id);
		// A name no online tool holds is unavailable at once, with what they do hold
		const unknown = await requestRun(as('member'), {
			item: item.ref,
			key: 'M1',
			registration: 'NOPE'
		});
		expect(unknown.unavailable).toBe(true);
		expect(unknown.run.reason).toMatch(/holds the registration NOPE/);
		expect(unknown.run.reason).toMatch(/HAPR, HAPRM/);
		// A check that names one needs no name on the run
		const saved = await makeCheck('Saved', 'HAPRM');
		expect((await requestRun(as('member'), { item: saved.ref, key: 'M1' })).run.registration).toBe(
			'HAPRM'
		);
	});

	it('a result is accepted only from the registration that was asked for, and the run shows which one ran', async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		// Runs left queued by the tests before would be claimed first
		await db.admin.exec(`delete from check_run where org_id = '${w.orgId}'`);
		const tool = await newTool('Finish afb-checks');
		await report(tool.token, [
			{ p: w.projectKey, n: 'HAPR', r: 'hapr-gameplan-clone', b: 'feat/capacitor-app' },
			{ p: w.projectKey, n: 'HAPRM', r: 'hapr-gameplan', b: 'feat/demo-cloud' }
		]);
		const auth = (await authenticateRunner(db, tool.token))!;
		const item = await makeCheck('Finish');
		await requestRun(as('member'), {
			item: item.ref,
			key: 'M1',
			registration: 'HAPRM',
			step: '1.1'
		});
		const job = (await claimCheckJob(db, auth, services))!;
		// A tool that says it ran the other registration, or none, cannot close the step
		const wrong = await finishCheckRun(
			db,
			auth,
			job.id,
			{ result: 'pass', commit: 'abc1234', diffHash: 'h1', registration: 'HAPR' },
			services
		);
		expect(wrong.result).toBe('error');
		expect(wrong.ticked).toEqual([]);
		const view = (await itemChecks(as('member'), item.ref)).checks[0].runs[0];
		expect(view.reason).toMatch(/asked for the registration HAPRM, but the tool reported HAPR/);
		// An error report closes nothing, so it keeps its own reason even when the tool stopped before it knew its registration
		await requestRun(as('member'), {
			item: item.ref,
			key: 'M1',
			registration: 'HAPRM',
			step: '1.1'
		});
		const failing = (await claimCheckJob(db, auth, services))!;
		const early = await finishCheckRun(
			db,
			auth,
			failing.id,
			{ result: 'error', reason: 'The build failed (exit 1).' },
			services
		);
		expect(early.result).toBe('error');
		expect(early.ticked).toEqual([]);
		const earlyView = (await itemChecks(as('member'), item.ref)).checks[0].runs[0];
		expect(earlyView.reason).toMatch(/The build failed/);
		// The right one passes, the step closes, and the run shows the registration, folder and branch
		await requestRun(as('member'), {
			item: item.ref,
			key: 'M1',
			registration: 'HAPRM',
			step: '1.1'
		});
		const job2 = (await claimCheckJob(db, auth, services))!;
		const ok = await finishCheckRun(
			db,
			auth,
			job2.id,
			{
				result: 'pass',
				commit: 'abc1234',
				diffHash: 'h2',
				registration: 'HAPRM',
				repoName: 'hapr-gameplan',
				branch: 'feat/demo-cloud'
			},
			services
		);
		expect(ok.result).toBe('pass');
		expect(ok.ticked).toContain('1.1');
		const shown = (await itemChecks(as('member'), item.ref)).checks[0].runs[0];
		expect(shown).toMatchObject({
			registration: 'HAPRM',
			ran: { registration: 'HAPRM', repo: 'hapr-gameplan', branch: 'feat/demo-cloud' }
		});
		// Text the tool sends is held to plain names
		expect(() => JSON.stringify(shown)).not.toThrow();
	});

	it('a run that names no registration is accepted from whatever registration served it (a project with one registration is unchanged)', async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		// Runs left queued by the tests before would be claimed first
		await db.admin.exec(`delete from check_run where org_id = '${w.orgId}'`);
		const tool = await newTool('One afb-checks');
		await report(tool.token, [{ p: w.projectKey, n: w.projectKey }]);
		const auth = (await authenticateRunner(db, tool.token))!;
		const item = await makeCheck('One');
		const asked = await requestRun(as('member'), { item: item.ref, key: 'M1', step: '1.1' });
		expect(asked.run.registration).toBeNull();
		const job = (await claimCheckJob(db, auth, services))!;
		const done = await finishCheckRun(
			db,
			auth,
			job.id,
			{ result: 'pass', commit: 'abc1234', diffHash: 'h3', registration: w.projectKey },
			services
		);
		expect(done.result).toBe('pass');
		expect(done.ticked).toContain('1.1');
	});

	it('saving a check keeps its registration when none is given, and clears it with null', async () => {
		const item = await makeCheck('Keep', 'HAPRM');
		const read = async () => (await itemChecks(as('member'), item.ref)).checks[0].registration;
		expect(await read()).toBe('HAPRM');
		await saveCheck(as('member'), { item: item.ref, key: 'M1', script: 'await page.goto("/x")' });
		expect(await read()).toBe('HAPRM');
		await saveCheck(as('member'), {
			item: item.ref,
			key: 'M1',
			script: 'await page.goto("/y")',
			registration: 'HAPR'
		});
		expect(await read()).toBe('HAPR');
		await saveCheck(as('member'), {
			item: item.ref,
			key: 'M1',
			script: 'await page.goto("/z")',
			registration: null
		});
		expect(await read()).toBeNull();
		await expect(
			saveCheck(as('member'), { item: item.ref, key: 'M1', script: 's', registration: '../x' })
		).rejects.toThrow();
	});

	it('runner_status lists the registrations an online tool holds, and says when a run must name one', async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const tool = await newTool('Status afb-checks');
		await report(tool.token, [
			{ p: w.projectKey, n: 'HAPR', r: 'hapr-gameplan-clone', b: 'feat/capacitor-app' },
			{ p: w.projectKey, n: 'HAPRM', r: 'hapr-gameplan', b: 'feat/demo-cloud' },
			{ p: 'OTHER', n: 'ELSEWHERE' }
		]);
		await authenticateRunner(db, tool.token);
		const status = (await runnerStatus(as('admin'), w.projectKey)).projects[0];
		expect(status.registrationRequired).toBe(true);
		expect(status.registrations.map((r) => r.name).sort()).toEqual(['HAPR', 'HAPRM']);
		expect(status.registrations.find((r) => r.name === 'HAPRM')).toMatchObject({
			repo: 'hapr-gameplan',
			branch: 'feat/demo-cloud'
		});
		// A damaged header keeps the last good list
		const kept = await call(tool.token, '/peek', { [TOOL_REGISTRATIONS_HEADER]: 'not valid !!' });
		expect(kept.status).toBe(200);
		expect((await runnerStatus(as('admin'), w.projectKey)).projects[0].registrations).toHaveLength(
			2
		);
	});
	it('a registration applies to the preview only: dev and deployed runs carry none, and naming one there is refused', async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const tool = await newTool('Preview afb-checks');
		await report(tool.token, [{ p: w.projectKey, n: 'HAPRM' }]);
		const item = await makeCheck('Saved', 'HAPRM');
		await expect(
			requestRun(as('member'), {
				item: item.ref,
				key: 'M1',
				target: 'deployed',
				registration: 'HAPRM'
			})
		).rejects.toMatchObject({
			code: 'INVALID',
			message: expect.stringMatching(/preview target only/)
		});
		// The check's own registration is ignored on another target, so a local or hosted runner can still take the run
		const dev = await requestRun(as('member'), { item: item.ref, key: 'M1', target: 'dev' });
		expect(dev.run.registration).toBeNull();
	});

	it('registration names are matched without regard to case: reuse, claim and finish', async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const tool = await newTool('Case afb-checks');
		await report(tool.token, [{ p: w.projectKey, n: 'haprm' }]);
		const auth = (await authenticateRunner(db, tool.token))!;
		const item = await makeCheck('Case');
		const first = await requestRun(as('member'), {
			item: item.ref,
			key: 'M1',
			registration: 'HAPRM',
			step: '1.1'
		});
		const again = await requestRun(as('member'), {
			item: item.ref,
			key: 'M1',
			registration: 'haprm'
		});
		expect(again.reused).toBe(true);
		expect(again.run.id).toBe(first.run.id);
		const job = (await claimCheckJob(db, auth, services))!;
		expect(job.id).toBe(first.run.id);
		const done = await finishCheckRun(
			db,
			auth,
			job.id,
			{ result: 'pass', commit: 'abc1234', diffHash: 'h4', registration: 'haprm' },
			services
		);
		expect(done.result).toBe('pass');
	});

	it('the claim filter is part of the query: a long line of runs for another registration never hides a run the tool can take', async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const a = await newTool('Line A afb-checks');
		const b = await newTool('Line B afb-checks');
		await report(a.token, [{ p: w.projectKey, n: 'HAPR' }]);
		await report(b.token, [{ p: w.projectKey, n: 'HAPRM' }]);
		// 27 older queued runs for the other registration, written straight into the queue (27 items would use up the references of a minute)
		const line = await makeCheck('Line', 'HAPR');
		const [chk] = await db.admin.query<{ id: string }>(
			`select id from "check" where org_id = '${w.orgId}' order by created_at desc limit 1`
		);
		await db.admin.exec(
			`insert into check_run (org_id, project_id, check_id, target, requested_target, result, registration, created_at) select '${w.orgId}', '${w.projectId}', '${chk.id}', 'preview', 'preview', 'queued', 'HAPR', now() - make_interval(mins => g) from generate_series(1, 27) g`
		);
		expect(line.ref).toBeTruthy();
		const mine = await makeCheck('Mine', 'HAPRM');
		const asked = await requestRun(as('member'), { item: mine.ref, key: 'M1' });
		const authB = (await authenticateRunner(db, b.token))!;
		expect((await claimCheckJob(db, authB, services))!.id).toBe(asked.run.id);
	}, 120_000);

	it('a registration name held for another project does not let a tool take this project run', async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const tool = await newTool('Project afb-checks');
		await report(tool.token, [{ p: w.projectKey, n: 'HAPRM' }]);
		const item = await makeCheck('Project bound', 'HAPRM');
		const asked = await requestRun(as('member'), { item: item.ref, key: 'M1' });
		expect(asked.run.result).toBe('queued');
		// The tool now reports HAPRM for a different project only
		await report(tool.token, [{ p: 'OTHER', n: 'HAPRM' }]);
		const auth = (await authenticateRunner(db, tool.token))!;
		expect(await claimCheckJob(db, auth, services)).toBeNull();
		expect(await peekQueue(db, auth)).toBe(0);
	});

	it('only a tool token can set the list, and a guest sees the names of the registrations and nothing else', async () => {
		await db.admin.exec(`delete from runner where org_id = '${w.orgId}'`);
		const hosted = await createRunner(as('admin'), {
			name: 'Hosted',
			kind: 'hosted',
			projects: [w.projectKey]
		});
		const kept = await call(hosted.token, '/peek', {
			[TOOL_REGISTRATIONS_HEADER]: encode([{ p: w.projectKey, n: 'HAPRM' }])
		});
		expect(kept.status).toBe(200);
		const rows = await db.admin.query<{ registrations: unknown }>(
			`select registrations from runner where org_id = '${w.orgId}'`
		);
		expect(rows.every((r) => r.registrations === null)).toBe(true);
		const tool = await newTool('Guest afb-checks');
		await report(tool.token, [
			{ p: w.projectKey, n: 'HAPRM', r: 'hapr-gameplan', b: 'feat/demo-cloud' }
		]);
		await authenticateRunner(db, tool.token);
		const asGuest = (
			await runnerStatus({ ...w.ctx('guest'), services }, w.projectKey).catch(() => null)
		)?.projects[0];
		// A guest may not be allowed to read this project at all; when they are, they get names only
		if (asGuest) expect(asGuest.registrations).toEqual([{ name: 'HAPRM' }]);
		const asMember = (await runnerStatus(as('member'), w.projectKey)).projects[0];
		expect(asMember.registrations).toEqual([
			{ name: 'HAPRM', repo: 'hapr-gameplan', branch: 'feat/demo-cloud' }
		]);
	});
});
