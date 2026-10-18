// PHASE 11: SECRETS, ENVIRONMENTS, RUNNERS AND THE BROWSER CHECK QUEUE. A pass on the required target closes the plan, a weaker
// one does not, a later fail reopens, nothing with a secret in it is stored, and a runner only ever sees its own projects.

// -- DEP-MODULES -- //
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
// -- MODULES -- //
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { adminFromExecutor } from '../../src/lib/server/backup/admin';
import { attachment, checkRun, manualCheck, secret, step } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import {
	claimCheckJob,
	finishCheckRun,
	isPrivateUrl,
	itemChecks,
	listRuns,
	peekQueue,
	requestRun,
	runAccounts,
	saveCheck,
	storeRunArtifact
} from '../../src/lib/server/ops/checks';
import {
	authenticateRunner,
	createRunner,
	makeRunKey,
	deleteRunner,
	listAccounts,
	listRunners,
	saveAccount,
	saveEnvironment,
	setRunnerProjects
} from '../../src/lib/server/ops/environments';
import { createItem } from '../../src/lib/server/ops/items';
import { rotateMasterKey } from '../../src/lib/server/secrets/vault';
import { handleRunnerApi } from '../../src/lib/server/api/runner';
import { findSecret, maskSecrets } from '../../src/lib/shared/scan';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const MASTER = 'test-master-key-for-the-vault-0123456789abcdef';
const PASSWORD = 'Sup3r-Secret-pw!';

// -- FUNCTIONS -- //

/** A one entry zip, the way Playwright writes a trace, so the scan can be proved to look inside one. */
function makeZip(name: string, content: string): Buffer {
	const data = Buffer.from(content, 'utf8');
	const packed = deflateRawSync(data);
	const nameBuf = Buffer.from(name);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(8, 8);
	local.writeUInt32LE(packed.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(nameBuf.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(8, 10);
	central.writeUInt32LE(packed.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(nameBuf.length, 28);
	central.writeUInt32LE(0, 42);
	const localPart = Buffer.concat([local, nameBuf, packed]);
	const centralPart = Buffer.concat([central, nameBuf]);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(1, 8);
	eocd.writeUInt16LE(1, 10);
	eocd.writeUInt32LE(centralPart.length, 12);
	eocd.writeUInt32LE(localPart.length, 16);
	return Buffer.concat([localPart, centralPart, eocd]);
}

describe('the secret scan', () => {
	const needles = [{ label: 'the password of the test account "default"', value: PASSWORD }];
	it('finds a secret as it is, encoded, and inside a zip, and says which one without printing it', () => {
		expect(findSecret(`user typed ${PASSWORD} here`, needles)).toMatch(/default/);
		expect(findSecret(`p=${encodeURIComponent(PASSWORD)}`, needles)).not.toBeNull();
		expect(findSecret(Buffer.from(PASSWORD).toString('base64'), needles)).not.toBeNull();
		expect(findSecret(JSON.stringify({ password: PASSWORD }), needles)).not.toBeNull();
		expect(findSecret(makeZip('trace.network', `{"post":"${PASSWORD}"}`), needles)).not.toBeNull();
		expect(findSecret(makeZip('trace.network', '{"post":"nothing here"}'), needles)).toBeNull();
		expect(findSecret('a harmless log line', needles)).toBeNull();
		expect(findSecret('short', [{ label: 'x', value: 'short' }])).toBeNull();
		expect(String(findSecret(PASSWORD, needles))).not.toContain(PASSWORD);
	});
	it('masks every spelling in a log that is kept', () => {
		const text = `typed ${PASSWORD} and ${encodeURIComponent(PASSWORD)}`;
		const masked = maskSecrets(text, needles);
		expect(masked).not.toContain(PASSWORD);
		expect(masked).not.toContain(encodeURIComponent(PASSWORD));
		expect(masked).toContain('********');
	});
	it('knows which addresses only a local machine can reach', () => {
		for (const u of [
			'http://localhost:5180',
			'http://127.0.0.1:3000',
			'http://10.1.2.3',
			'http://192.168.0.5',
			'http://intranet/'
		])
			expect(isPrivateUrl(u)).toBe(true);
		for (const u of ['https://app.example.com', 'https://8.8.8.8/x'])
			expect(isPrivateUrl(u)).toBe(false);
	});
});

describe('browser checks', () => {
	const make = makePostgres;
	let db: TestDb;
	let w: World;
	let n = 0;
	const storage = memoryStorage();
	const services = { masterKey: MASTER, storage, runnerQueueMinutes: 10 };
	const as = (who: 'owner' | 'admin' | 'member' | 'viewer') => ({ ...w.ctx(who), services });
	const newItem = (extra = {}) =>
		createItem(as('member'), {
			project: w.projectKey,
			title: `Check item ${++n}`,
			phases: [
				{
					key: '1',
					title: 'Build',
					steps: [
						{ text: 'Write it' },
						{ text: 'Run the check on the preview', requiredTarget: 'preview' as const },
						{ text: 'Run the check on the live site', requiredTarget: 'deployed' as const }
					]
				}
			],
			manualChecks: [{ key: 'M1', text: 'The page works', auto: true }],
			...extra
		});
	const stepState = (itemId: string, key: string) =>
		withTenant(db, { orgId: w.orgId }, async (tx) => {
			const [s] = await tx
				.select()
				.from(step)
				.where(and(eq(step.itemId, itemId), eq(step.key, key)));
			return s;
		});
	const manualState = (itemId: string) =>
		withTenant(
			db,
			{ orgId: w.orgId },
			async (tx) => (await tx.select().from(manualCheck).where(eq(manualCheck.itemId, itemId)))[0]
		);
	let token = '';
	let auth: NonNullable<Awaited<ReturnType<typeof authenticateRunner>>>;

	beforeAll(async () => {
		db = await make();
		w = await makeWorld(db);
		await db.admin.exec(`update project set web_app = true where id = '${w.projectId}'`);
	}, 240_000);
	afterAll(() => db?.stop());

	it('keeps test accounts sealed: names are listed, values never leave, and a moved or re-keyed row does not open', async () => {
		// A server with no master key refuses, so a secret is never stored in the clear
		await expect(
			saveAccount(
				{ ...w.ctx('admin'), services: {} },
				{ project: w.projectKey, name: 'default', email: 'qa@example.com', password: PASSWORD }
			)
		).rejects.toThrow(/AFB_MASTER_KEY/);
		await expect(
			saveAccount(as('member'), {
				project: w.projectKey,
				name: 'default',
				email: 'qa@example.com',
				password: PASSWORD
			})
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			saveAccount(as('admin'), {
				project: w.projectKey,
				name: 'default',
				email: 'qa@example.com',
				password: 'short'
			})
		).rejects.toThrow();
		await saveAccount(as('admin'), {
			project: w.projectKey,
			name: 'default',
			email: 'qa@example.com',
			password: PASSWORD
		});
		const listed = await listAccounts(as('member'), w.projectKey);
		expect(listed.map((a) => a.name)).toEqual(['default']);
		expect(JSON.stringify(listed)).not.toContain(PASSWORD);
		await expect(listAccounts(as('viewer'), w.projectKey)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		const rows = await withTenant(db, { orgId: w.orgId }, (tx) => tx.select().from(secret));
		expect(JSON.stringify(rows)).not.toContain(PASSWORD);
		expect(JSON.stringify(rows)).not.toContain('qa@example.com');
		// The audit trail names the account and holds no value
		const events = await db.admin.query<{ after: unknown }>(
			`select after from event where verb = 'secret.set' and org_id = '${w.orgId}'`
		);
		expect(JSON.stringify(events)).not.toContain(PASSWORD);
		// A row moved to another name does not open (its name is part of what was sealed)
		await db.admin.exec(
			`update secret set name = 'moved' where org_id = '${w.orgId}' and name = 'default'`
		);
		const ctx = { ...as('owner'), services: { ...services } };
		const { openProjectAccounts } = await import('../../src/lib/server/ops/environments');
		await expect(openProjectAccounts(ctx, w.projectId)).rejects.toThrow(/could not be opened/);
		await db.admin.exec(
			`update secret set name = 'default' where org_id = '${w.orgId}' and name = 'moved'`
		);
		expect((await openProjectAccounts(ctx, w.projectId)).default.password).toBe(PASSWORD);
		// Rotating the master key re-wraps the data key and every secret still opens, with the new key only
		const NEW = 'a-brand-new-master-key-0123456789abcdefghij';
		const done = await rotateMasterKey(adminFromExecutor(db.admin), MASTER, NEW);
		expect(done.rewrapped).toBeGreaterThanOrEqual(1);
		await expect(openProjectAccounts(ctx, w.projectId)).rejects.toThrow(/could not be opened/);
		const fresh = { ...ctx, services: { ...services, masterKey: NEW } };
		expect((await openProjectAccounts(fresh, w.projectId)).default.password).toBe(PASSWORD);
		await rotateMasterKey(adminFromExecutor(db.admin), NEW, MASTER);
		expect((await openProjectAccounts(ctx, w.projectId)).default.password).toBe(PASSWORD);
	});

	it('saves environments with their rules, only for web apps, and only for admins', async () => {
		await expect(
			saveEnvironment(as('member'), {
				project: w.projectKey,
				name: 'x',
				url: 'http://localhost:5180',
				kind: 'preview'
			})
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			saveEnvironment(as('admin'), {
				project: w.projectKey,
				name: 'x',
				url: 'http://localhost:5180',
				kind: 'preview',
				production: true
			})
		).rejects.toThrow(/deployed/);
		await expect(
			saveEnvironment(as('admin'), {
				project: w.projectKey,
				name: 'x',
				url: 'ftp://nope',
				kind: 'preview'
			})
		).rejects.toThrow();
		await saveEnvironment(as('admin'), {
			project: w.projectKey,
			name: 'preview',
			url: 'http://localhost:5180',
			kind: 'preview'
		});
		await saveEnvironment(as('admin'), {
			project: w.projectKey,
			name: 'dev',
			url: 'http://localhost:5173',
			kind: 'dev'
		});
		await saveEnvironment(as('admin'), {
			project: w.projectKey,
			name: 'live',
			url: 'https://app.example.com/',
			kind: 'deployed',
			production: true,
			versionPath: '/version'
		});
		const again = await saveEnvironment(as('admin'), {
			project: w.projectKey,
			name: 'dev',
			url: 'http://localhost:5174',
			kind: 'dev'
		});
		expect(again.created).toBe(false);
	});

	it('registers runners with a token shown once, and only the owner of a local runner chooses its projects', async () => {
		await expect(
			createRunner(as('member'), { name: 'mine', kind: 'local', projects: [] })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		const made = await createRunner(as('admin'), {
			name: 'Laptop',
			kind: 'local',
			projects: [w.projectKey]
		});
		token = made.token;
		expect(token).toMatch(/^afx_/);
		const listed = await listRunners(as('member'));
		expect(JSON.stringify(listed)).not.toContain(token);
		expect(listed[0].online).toBe(false);
		expect(await authenticateRunner(db, token + 'x')).toBeNull();
		expect(await authenticateRunner(db, 'afx_nonsense')).toBeNull();
		auth = (await authenticateRunner(db, token))!;
		expect(auth.projectIds).toEqual([w.projectId]);
		expect((await listRunners(as('member')))[0].online).toBe(true);
		// Another admin cannot opt projects into someone else's local runner
		await expect(setRunnerProjects(as('owner'), auth.runnerId, [])).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await setRunnerProjects(as('admin'), auth.runnerId, [w.projectKey]);
		// A runner of another org cannot be reached with this org's token shape
		const forged = token.replace(w.orgId, w.other.orgId);
		expect(await authenticateRunner(db, forged)).toBeNull();
	});

	it('chooses the target by run, then pin, then preference, then project default, and reports an unavailable target with the others', async () => {
		const it1 = await newItem();
		await saveCheck(as('member'), {
			item: it1.ref,
			key: 'M1',
			script: 'await page.goto("/")',
			requiredTarget: 'preview'
		});
		// No runner online yet for this test: take the runner offline first
		await db.admin.exec(`update runner set last_seen_at = now() - interval '10 minutes'`);
		const down = await requestRun(as('member'), { item: it1.ref, key: 'M1' });
		expect(down.unavailable).toBe(true);
		expect(down.run.result).toBe('unavailable');
		expect(down.run.reason).toMatch(/No runner/);
		await authenticateRunner(db, token);
		const byDefault = await requestRun(as('member'), { item: it1.ref, key: 'M1' });
		expect(byDefault.target).toBe('preview');
		expect(byDefault.unavailable).toBe(false);
		// Preference over default
		await db.admin.exec(
			`insert into user_pref (user_id, check_target) values ('${w.people.member}', 'deployed') on conflict (user_id) do update set check_target = 'deployed'`
		);
		expect((await requestRun(as('member'), { item: it1.ref, key: 'M1' })).target).toBe('deployed');
		// Pin over preference, and this run over the pin
		await saveCheck(as('member'), {
			item: it1.ref,
			key: 'M1',
			script: 's',
			requiredTarget: 'preview',
			pinnedTarget: 'dev'
		});
		expect((await requestRun(as('member'), { item: it1.ref, key: 'M1' })).target).toBe('dev');
		expect(
			(await requestRun(as('member'), { item: it1.ref, key: 'M1', target: 'preview' })).target
		).toBe('preview');
		await db.admin.exec(`delete from user_pref where user_id = '${w.people.member}'`);
		// A viewer cannot ask, and an item with no check says so
		await expect(requestRun(as('viewer'), { item: it1.ref, key: 'M1' })).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		const bare = await newItem();
		await expect(requestRun(as('member'), { item: bare.ref, key: 'M1' })).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		// An unavailable target offers the ones that can run now (only deployed has no runner reach problem: public address)
		await db.admin.exec(`delete from environment where kind = 'preview'`);
		const noEnv = await requestRun(as('member'), { item: it1.ref, key: 'M1', target: 'preview' });
		expect(noEnv.unavailable).toBe(true);
		expect(noEnv.offer.sort()).toEqual(['deployed', 'dev']);
		expect(noEnv.run.reason).toMatch(/no preview environment/i);
		await saveEnvironment(as('admin'), {
			project: w.projectKey,
			name: 'preview',
			url: 'http://localhost:5180',
			kind: 'preview'
		});
		await db.admin.exec(
			`update check_run set result = 'timeout' where result in ('queued','running')`
		);
	});

	it('a pass on the required target closes the check and its step, a weaker pass closes nothing, a later fail reopens', async () => {
		const it2 = await newItem();
		await saveCheck(as('member'), {
			item: it2.ref,
			key: 'M1',
			script: 's',
			requiredTarget: 'preview'
		});
		const ask = async (target: 'dev' | 'preview' | 'deployed', stepKey?: string) => {
			const asked = await requestRun(as('member'), {
				item: it2.ref,
				key: 'M1',
				target,
				step: stepKey
			});
			const job = await claimCheckJob(db, auth, services);
			expect(job?.id).toBe(asked.run.id);
			return job!;
		};
		// Preview pass: the manual check M1 and step 1.2 close
		const p1 = await ask('preview', '1.2');
		expect(p1.environment.url).toBe('http://localhost:5180');
		expect(p1.readOnly).toBe(false);
		const r1 = await finishCheckRun(
			db,
			auth,
			p1.id,
			{ result: 'pass', commit: 'abc1234', diffHash: 'd1', durationMs: 900 },
			services
		);
		expect(r1.ticked.sort()).toEqual(['1.2', 'M1']);
		expect((await stepState(it2.id, '1.2')).state).toBe('done');
		expect((await manualState(it2.id)).state).toBe('waived');
		// A dev pass for the step that needs deployed: recorded, nothing closed
		const p2 = await ask('dev', '1.3');
		const r2 = await finishCheckRun(
			db,
			auth,
			p2.id,
			{ result: 'pass', commit: 'abc1234', diffHash: 'd1' },
			services
		);
		expect(r2.ticked).toEqual([]);
		expect(r2.note).toMatch(/weaker/);
		expect((await stepState(it2.id, '1.3')).state).toBe('open');
		// A deployed pass closes it, and the production environment is read only
		const p3 = await ask('deployed', '1.3');
		expect(p3.readOnly).toBe(true);
		expect(p3.environment.production).toBe(true);
		const r3 = await finishCheckRun(
			db,
			auth,
			p3.id,
			{ result: 'pass', commit: 'abc1234', diffHash: 'd1' },
			services
		);
		expect(r3.ticked).toEqual(['1.3']);
		// Passing the same step with a run that does not reach its target says why
		const it3 = await newItem();
		await saveCheck(as('member'), {
			item: it3.ref,
			key: 'M1',
			script: 's',
			requiredTarget: 'preview'
		});
		const weak = await requestRun(as('member'), {
			item: it3.ref,
			key: 'M1',
			target: 'dev',
			step: '1.2'
		});
		const wj = await claimCheckJob(db, auth, services);
		expect(wj?.id).toBe(weak.run.id);
		const wr = await finishCheckRun(
			db,
			auth,
			wj!.id,
			{ result: 'pass', commit: 'e', diffHash: 'f' },
			services
		);
		expect(wr.ticked).toEqual([]);
		expect(wr.note).toMatch(/weaker/);
		expect((await stepState(it3.id, '1.2')).state).toBe('open');
		// A later fail on the same target reopens what the pass closed, and both runs are flagged as flaky: same code, two answers
		const p4 = await ask('preview');
		const r4 = await finishCheckRun(
			db,
			auth,
			p4.id,
			{ result: 'fail', commit: 'abc1234', diffHash: 'd1', reason: 'Save button missing' },
			services
		);
		expect(r4.reopened.sort()).toEqual(['1.2', 'M1']);
		expect(r4.flaky).toBe(true);
		expect((await stepState(it2.id, '1.2')).state).toBe('open');
		expect((await manualState(it2.id)).state).toBe('open');
		// The deployed pass is untouched by a preview fail
		expect((await stepState(it2.id, '1.3')).state).toBe('done');
		const flagged = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(checkRun).where(eq(checkRun.flaky, true))
		);
		expect(flagged.map((r) => r.id)).toContain(p1.id);
		// The Checks view shows the runs, newest first, and the targets that can run
		const view = await itemChecks(as('member'), it2.ref);
		expect(view.checks[0].runs[0].result).toBe('fail');
		expect(view.targets.find((t) => t.target === 'preview')?.available).toBe(true);
		const all = await listRuns(as('member'), { item: it2.ref });
		expect(all.length).toBeGreaterThanOrEqual(4);
	});

	it('a run nobody takes is reported stuck, and a runner only sees runs of the projects it serves and holds', async () => {
		const it4 = await newItem();
		await saveCheck(as('member'), { item: it4.ref, key: 'M1', script: 's' });
		const asked = await requestRun(as('member'), { item: it4.ref, key: 'M1', target: 'preview' });
		await db.admin.exec(
			`update check_run set created_at = now() - interval '11 minutes' where id = '${asked.run.id}'`
		);
		const runs = await listRuns(as('member'), { item: it4.ref });
		const stuck = runs.find((r) => r.id === asked.run.id)!;
		expect(stuck.result).toBe('timeout');
		expect(stuck.reason).toMatch(/within 10 minutes/);
		// A second runner with no project takes nothing; one holding a run is the only one that can finish it
		const other = await createRunner(as('admin'), { name: 'Hosted', kind: 'hosted', projects: [] });
		const otherAuth = (await authenticateRunner(db, other.token))!;
		const fresh = await requestRun(as('member'), { item: it4.ref, key: 'M1', target: 'preview' });
		expect(await claimCheckJob(db, otherAuth, services)).toBeNull();
		// A supervisor can ask how many wait without taking any
		expect(await peekQueue(db, auth)).toBeGreaterThanOrEqual(1);
		expect(await peekQueue(db, otherAuth)).toBe(0);
		const job = await claimCheckJob(db, auth, services);
		expect(job?.id).toBe(fresh.run.id);
		await expect(
			finishCheckRun(db, otherAuth, job!.id, { result: 'pass' }, services)
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(runAccounts(db, otherAuth, job!.id, services)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		const accounts = await runAccounts(db, auth, job!.id, services);
		expect(accounts.default.email).toBe('qa@example.com');
		await finishCheckRun(
			db,
			auth,
			job!.id,
			{ result: 'error', reason: 'Browser did not start' },
			services
		);
		await expect(
			finishCheckRun(db, auth, job!.id, { result: 'pass' }, services)
		).rejects.toMatchObject({ code: 'CONFLICT' });
		// Accounts are opened only while the run is running
		await expect(runAccounts(db, auth, job!.id, services)).rejects.toMatchObject({
			code: 'CONFLICT'
		});
		// A hosted runner cannot use an environment on a private address
		const privateOnly = await requestRun(as('member'), {
			item: it4.ref,
			key: 'M1',
			target: 'preview'
		});
		expect(await claimCheckJob(db, otherAuth, services)).toBeNull();
		await setRunnerProjects(as('admin'), otherAuth.runnerId, [w.projectKey]);
		const otherAuth2 = (await authenticateRunner(db, other.token))!;
		expect(await claimCheckJob(db, otherAuth2, services)).toBeNull();
		const back = await claimCheckJob(db, auth, services);
		expect(back?.id).toBe(privateOnly.run.id);
		await finishCheckRun(db, auth, back!.id, { result: 'error', reason: 'done with it' }, services);
		await deleteRunner(as('admin'), otherAuth.runnerId);
		expect(await authenticateRunner(db, other.token)).toBeNull();
	});

	it('refuses an artifact or a log that holds a secret, keeps a clean one private, and masks what it keeps', async () => {
		const it5 = await newItem();
		await saveCheck(as('member'), { item: it5.ref, key: 'M1', script: 's' });
		await requestRun(as('member'), { item: it5.ref, key: 'M1', target: 'preview' });
		const job = (await claimCheckJob(db, auth, services))!;
		// A clean picture is stored private
		const ok = await storeRunArtifact(
			db,
			auth,
			job.id,
			{
				filename: 'after.png',
				caption: 'Page after sign in',
				bytes: Uint8Array.from([137, 80, 78, 71, 1, 2, 3])
			},
			services
		);
		const [att] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(attachment).where(eq(attachment.id, ok.attachmentId))
		);
		expect(att.visibility).toBe('private');
		expect(att.kind).toBe('check-evidence');
		// A trace with the password inside is refused, the run stops, and nothing is kept
		const trace = makeZip(
			'0-trace.network',
			`{"request":{"postData":"password=${encodeURIComponent(PASSWORD)}"}}`
		);
		await expect(
			storeRunArtifact(
				db,
				auth,
				job.id,
				{ filename: 'trace.zip', caption: 'Trace', bytes: trace },
				services
			)
		).rejects.toThrow(/was not stored/);
		const [stopped] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(checkRun).where(eq(checkRun.id, job.id))
		);
		expect(stopped.result).toBe('error');
		expect(stopped.reason).toMatch(/refused/);
		expect(stopped.reason).not.toContain(PASSWORD);
		// A log with the password is not kept, and a log without it is kept with the secret masked
		await requestRun(as('member'), { item: it5.ref, key: 'M1', target: 'preview' });
		const job2 = (await claimCheckJob(db, auth, services))!;
		const leaked = await finishCheckRun(
			db,
			auth,
			job2.id,
			{ result: 'pass', log: `typed ${PASSWORD}` },
			services
		);
		expect(leaked.result).toBe('error');
		const [row] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(checkRun).where(eq(checkRun.id, job2.id))
		);
		expect(row.log).toBeNull();
		expect(row.reason).toMatch(/password/);
		expect(row.reason).not.toContain(PASSWORD);
		await requestRun(as('member'), { item: it5.ref, key: 'M1', target: 'preview' });
		const job3 = (await claimCheckJob(db, auth, services))!;
		const clean = await finishCheckRun(
			db,
			auth,
			job3.id,
			{ result: 'pass', log: 'step 1 ok\nstep 2 ok' },
			services
		);
		expect(clean.result).toBe('pass');
		const [kept] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(checkRun).where(eq(checkRun.id, job3.id))
		);
		expect(kept.log).toContain('step 2 ok');
		// No stored row anywhere holds the password
		const dump = JSON.stringify(
			await db.admin.query(`select * from check_run where org_id = '${w.orgId}'`)
		);
		expect(dump).not.toContain(PASSWORD);
	});

	it('a run key opens the one run it was made for and nothing else, and the runner token never has to enter a container', async () => {
		const it7 = await newItem();
		await saveCheck(as('member'), { item: it7.ref, key: 'M1', script: 's' });
		await requestRun(as('member'), { item: it7.ref, key: 'M1', target: 'preview' });
		const job = (await claimCheckJob(db, auth, services))!;
		const key = makeRunKey(MASTER, 'runs', auth, job.id);
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
				{ handle: db, baseUrl: 'http://board.test', masterKey: MASTER, storage }
			);
		// It reads the accounts of its own run, once
		const mine = await call(key, 'GET', `/runs/${job.id}/accounts`);
		expect(mine.status).toBe(200);
		// It cannot take other runs, give back runs, or reach another run
		for (const [m, p] of [
			['POST', '/claim'],
			['POST', '/peek'],
			['POST', '/release'],
			['GET', '/runs/00000000-0000-4000-8000-000000000000/accounts']
		] as const)
			expect((await call(key, m, p)).status).toBe(403);
		// A changed key, a key of another run and a key with no secret behind it are refused
		expect(
			(
				await call(
					key.slice(0, -1) + (key.endsWith('0') ? '1' : '0'),
					'GET',
					`/runs/${job.id}/accounts`
				)
			).status
		).toBe(401);
		expect(
			(
				await call(
					makeRunKey('another-master-key-0123456789abcdef0123', 'runs', auth, job.id),
					'GET',
					`/runs/${job.id}/accounts`
				)
			).status
		).toBe(401);
		const done = await call(
			key,
			'POST',
			`/runs/${job.id}/finish`,
			JSON.stringify({ result: 'error', reason: 'stopped' })
		);
		expect(done.status).toBe(200);
	});
});
