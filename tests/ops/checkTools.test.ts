// THE AGENT SIDE OF BROWSER CHECKS: SAVE A SCRIPT, ASK FOR A RUN, WAIT FOR IT, ASK WHETHER A TOOL IS ONLINE (AFB-20261019-0510 PHASE 1)
// Every verb here is the one the MCP tools call. A run id is not a handle: a private item, another org and a project a token does
// not cover all answer the same NOT_FOUND.

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
// -- MODULES -- //
import { manualCheck } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import {
	claimCheckJob,
	deleteCheck,
	finishCheckRun,
	getRun,
	itemChecks,
	requestRun,
	runnerStatus,
	toolAgentAction,
	saveCheck,
	waitForRun,
	waitersFor
} from '../../src/lib/server/ops/checks';
import {
	TOOL_PROTOCOL_MIN,
	authenticateRunner,
	registerToolRunner,
	type RunnerAuth
} from '../../src/lib/server/ops/environments';
import { createItem } from '../../src/lib/server/ops/items';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const MASTER = 'test-master-key-for-the-vault-0123456789abcdef';

// -- FUNCTIONS -- //

describe('checks an agent drives alone', () => {
	let db: TestDb;
	let w: World;
	let n = 0;
	let auth: RunnerAuth;
	let token = '';
	const services = { masterKey: MASTER, runnerQueueMinutes: 10 };
	const as = (who: 'owner' | 'admin' | 'member' | 'viewer') => ({ ...w.ctx(who), services });
	/** A token that is limited to another project than the world's. */
	const limited = () => ({
		...w.ctx('member', { tokenCaps: ['read', 'write'], tokenProjects: [w.other.projectId] }),
		services
	});
	/** A member of the other org, who must never see this org's runs. */
	const stranger = () => ({
		handle: db,
		orgId: w.other.orgId,
		services,
		actor: { userId: w.other.userId, kind: 'person' as const, label: 'stranger' }
	});
	const newItem = (extra = {}) =>
		createItem(as('member'), {
			project: w.projectKey,
			title: `Tool item ${++n}`,
			phases: [
				{
					key: '1',
					title: 'Build',
					steps: [{ text: 'Run it', requiredTarget: 'preview' as const }]
				}
			],
			manualChecks: [{ key: 'M1', text: 'The page works' }],
			...extra
		});
	const manual = (itemId: string) =>
		withTenant(
			db,
			{ orgId: w.orgId },
			async (tx) =>
				(
					await tx
						.select()
						.from(manualCheck)
						.where(and(eq(manualCheck.itemId, itemId), eq(manualCheck.key, 'M1')))
				)[0]
		);
	const checkCount = async (itemId: string) =>
		(
			await db.admin.query<{ n: number }>(
				`select count(*)::int as n from "check" where item_id = '${itemId}'`
			)
		)[0].n;
	const online = async () => {
		await db.admin.exec(`update runner set last_seen_at = now()`);
	};

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		await db.admin.exec(`update project set web_app = true where id = '${w.projectId}'`);
		const made = await registerToolRunner(as('admin'), { name: 'Test PC afb-checks' });
		token = made.token;
		auth = (await authenticateRunner(db, token))!;
	}, 240_000);
	afterAll(() => db?.stop());

	it('check_save marks the manual check automatic, check_delete makes it plain, and a closed check keeps its state', async () => {
		const it1 = await newItem();
		expect((await manual(it1.id)).auto).toBe(false);
		const saved = await saveCheck(as('member'), {
			item: it1.ref,
			key: 'M1',
			script: 'await page.goto("/")'
		});
		expect(saved).toMatchObject({ created: true, auto: true, note: null });
		const m = await manual(it1.id);
		expect(m.auto).toBe(true);
		expect(m.version).toBeGreaterThan(1);
		// Saving again replaces the script and changes nothing else
		const again = await saveCheck(as('member'), { item: it1.ref, key: 'M1', script: 's2' });
		expect(again).toMatchObject({ created: false, auto: true });
		expect((await itemChecks(as('member'), it1.ref)).checks[0].script).toBe('s2');
		await deleteCheck(as('member'), it1.ref, 'M1');
		expect((await manual(it1.id)).auto).toBe(false);
		await expect(deleteCheck(as('member'), it1.ref, 'M1')).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		// A manual check that is already done is not flipped, and the answer says why
		const it2 = await newItem();
		await db.admin.exec(`update manual_check set state = 'done' where item_id = '${it2.id}'`);
		const closed = await saveCheck(as('member'), { item: it2.ref, key: 'M1', script: 's' });
		expect(closed.auto).toBe(false);
		expect(closed.note).toMatch(/done/);
		expect((await manual(it2.id)).auto).toBe(false);
		await deleteCheck(as('member'), it2.ref, 'M1');
		expect((await manual(it2.id)).state).toBe('done');
	});

	it('check_save refuses a script the tool would block, and changes a saved script by one edit', async () => {
		const it1 = await newItem();
		// A blocked call is refused at once and nothing is saved; a comment that names it is not a finding
		await expect(
			saveCheck(as('member'), {
				item: it1.ref,
				key: 'M1',
				script: 'await page.addInitScript(() => 1);'
			})
		).rejects.toMatchObject({ code: 'INVALID', details: { code: 'SCRIPT_BLOCKED' } });
		await expect(
			saveCheck(as('member'), {
				item: it1.ref,
				key: 'M1',
				script: 'await page.goto("about:blank");'
			})
		).rejects.toMatchObject({ code: 'INVALID' });
		expect(await checkCount(it1.id)).toBe(0);
		await saveCheck(as('member'), {
			item: it1.ref,
			key: 'M1',
			script: '// addInitScript is blocked\nawait page.goto("/a");\nawait page.goto("/b");',
			coveredPaths: ['src/a']
		});
		// An edit with no saved script, a text that is missing, one that is not unique, and both script and edit: all refused
		const other = await newItem();
		await expect(
			saveCheck(as('member'), { item: other.ref, key: 'M1', edit: { old: 'x', new: 'y' } })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(
			saveCheck(as('member'), { item: it1.ref, key: 'M1', edit: { old: 'nope', new: 'y' } })
		).rejects.toThrow(/not found in the saved script/);
		await expect(
			saveCheck(as('member'), { item: it1.ref, key: 'M1', edit: { old: 'page.goto(', new: 'p(' } })
		).rejects.toThrow(/2 times/);
		await expect(
			saveCheck(as('member'), {
				item: it1.ref,
				key: 'M1',
				script: 'a',
				edit: { old: 'a', new: 'b' }
			})
		).rejects.toMatchObject({ code: 'INVALID' });
		expect((await itemChecks(as('member'), it1.ref)).checks[0].script).toContain('"/a"');
		// A good edit changes only that text, keeps the covered paths, and is also checked for blocked calls
		await saveCheck(as('member'), {
			item: it1.ref,
			key: 'M1',
			edit: { old: 'goto("/a")', new: 'goto("/c")' }
		});
		const saved = (await itemChecks(as('member'), it1.ref)).checks[0];
		expect(saved.script).toBe(
			'// addInitScript is blocked\nawait page.goto("/c");\nawait page.goto("/b");'
		);
		expect(saved.coveredPaths).toEqual(['src/a']);
		await expect(
			saveCheck(as('member'), {
				item: it1.ref,
				key: 'M1',
				edit: { old: 'goto("/c")', new: 'addInitScript(1)' }
			})
		).rejects.toMatchObject({ details: { code: 'SCRIPT_BLOCKED' } });
		expect((await itemChecks(as('member'), it1.ref)).checks[0].script).toContain('"/c"');
	});

	it('marks a run that shared the machine with another run as sharedCpu, and a run that ran alone as not', async () => {
		const a = await newItem();
		const b = await newItem();
		await saveCheck(as('member'), { item: a.ref, key: 'M1', script: 'await page.goto("/")' });
		await saveCheck(as('member'), { item: b.ref, key: 'M1', script: 'await page.goto("/")' });
		const idOf = async (itemId: string) =>
			(
				await db.admin.query<{ id: string }>(`select id from "check" where item_id = '${itemId}'`)
			)[0].id;
		const [ca, cb] = [await idOf(a.id), await idOf(b.id)];
		const insert = (checkId: string, start: string, end: string) =>
			db.admin.exec(
				`insert into check_run (org_id, project_id, check_id, target, result, started_at, finished_at)
				 values ('${w.orgId}', '${w.projectId}', '${checkId}', 'preview', 'pass', now() - interval '${start}', now() - interval '${end}')`
			);
		// Item a ran from 10 to 6 minutes ago, item b from 8 to 4 minutes ago: they overlap. A second run of a, 3 to 2 minutes ago, ran alone
		await insert(ca, '10 minutes', '6 minutes');
		await insert(cb, '8 minutes', '4 minutes');
		await insert(ca, '3 minutes', '2 minutes');
		const runs = (await itemChecks(as('member'), a.ref)).checks[0].runs;
		const flags = runs
			.map((r) => ({ at: r.startedAt!.getTime(), shared: r.sharedCpu }))
			.sort((x, y) => x.at - y.at)
			.map((r) => r.shared);
		expect(flags).toEqual([true, false]);
	});

	it('check_save needs write, hides a private item, stays inside a token, and needs the web app switch', async () => {
		const it3 = await newItem();
		await expect(
			saveCheck(as('viewer'), { item: it3.ref, key: 'M1', script: 's' })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		// A refusal leaves nothing behind: no check row, and the manual check is as it was
		expect(await checkCount(it3.id)).toBe(0);
		expect(await manual(it3.id)).toMatchObject({ auto: false, version: 1 });
		// A private item of the admin is not found by the member, for save and for delete
		const secret = await createItem(as('admin'), {
			project: w.projectKey,
			title: 'Private check item',
			visibility: 'private',
			phases: [{ key: '1', title: 'Build', steps: [{ text: 'Run it' }] }],
			manualChecks: [{ key: 'M1', text: 'Works' }]
		});
		await expect(
			saveCheck(as('member'), { item: secret.ref, key: 'M1', script: 's' })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(deleteCheck(as('member'), secret.ref, 'M1')).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		expect(await checkCount(secret.id)).toBe(0);
		expect(await manual(secret.id)).toMatchObject({ auto: false, version: 1 });
		// A token limited to another project cannot reach this one
		await expect(
			saveCheck(limited(), { item: it3.ref, key: 'M1', script: 's' })
		).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		await db.admin.exec(`update project set web_app = false where id = '${w.projectId}'`);
		await expect(
			saveCheck(as('member'), { item: it3.ref, key: 'M1', script: 's' })
		).rejects.toMatchObject({ code: 'INVALID' });
		await db.admin.exec(`update project set web_app = true where id = '${w.projectId}'`);
		expect(await checkCount(it3.id)).toBe(0);
		expect(await manual(it3.id)).toMatchObject({ auto: false, version: 1 });
	});

	it('check_run returns the open run instead of a second one, even for two calls at the same moment', async () => {
		await online();
		const it4 = await newItem();
		await saveCheck(as('member'), { item: it4.ref, key: 'M1', script: 's' });
		const [a, b] = await Promise.all([
			requestRun(as('member'), { item: it4.ref, key: 'M1', target: 'preview' }),
			requestRun(as('member'), { item: it4.ref, key: 'M1', target: 'preview' })
		]);
		expect(a.run.id).toBe(b.run.id);
		expect([a.reused, b.reused].sort()).toEqual([false, true]);
		const rows = await db.admin.query<{ n: number }>(
			`select count(*)::int as n from check_run where check_id in (select id from "check" where item_id = '${it4.id}')`
		);
		expect(rows[0].n).toBe(1);
		// A step named by the second call is attached when the first named none
		const withStep = await requestRun(as('member'), {
			item: it4.ref,
			key: 'M1',
			target: 'preview',
			step: '1.1'
		});
		expect(withStep.run.stepKey).toBe('1.1');
		expect(withStep.reused).toBe(true);
		// Once finished, the next ask makes a new run
		const job = await claimCheckJob(db, auth, services);
		await finishCheckRun(db, auth, job!.id, { result: 'pass' }, services);
		const next = await requestRun(as('member'), { item: it4.ref, key: 'M1', target: 'preview' });
		expect(next.reused).toBe(false);
		expect(next.run.id).not.toBe(a.run.id);
		await db.admin.exec(
			`update check_run set result = 'timeout' where result in ('queued','running')`
		);
	});

	it('check_wait returns the run the moment it finishes, and an unfinished one after the wait', async () => {
		await online();
		const it5 = await newItem();
		await saveCheck(as('member'), { item: it5.ref, key: 'M1', script: 's' });
		const asked = await requestRun(as('member'), { item: it5.ref, key: 'M1', target: 'preview' });
		// Nothing takes it: zero seconds answers at once, a short wait returns unfinished
		expect(await waitForRun(as('member'), { run: asked.run.id, seconds: 0 })).toMatchObject({
			finished: false
		});
		const short = await waitForRun(
			as('member'),
			{ run: asked.run.id, seconds: 1 },
			{ pollMs: 100 }
		);
		expect(short.finished).toBe(false);
		expect(short.run.result).toBe('queued');
		// A stand-in runner takes it and fails it with a log line seen on 2026-10-19, half way through the wait
		const waiting = waitForRun(as('member'), { run: asked.run.id, seconds: 20 }, { pollMs: 100 });
		await new Promise((r) => setTimeout(r, 400));
		const job = await claimCheckJob(db, auth, services);
		expect(job?.id).toBe(asked.run.id);
		await finishCheckRun(
			db,
			auth,
			job!.id,
			{
				result: 'error',
				reason: 'The preview stopped before it was ready. AFB_BASE_URL is required'
			},
			services
		);
		const done = await waiting;
		expect(done.finished).toBe(true);
		expect(done.run).toMatchObject({
			result: 'error',
			key: 'M1',
			item: it5.ref,
			code: 'PREVIEW_ENV_MISSING'
		});
		expect(done.run.fix).toMatch(/env file/);
	});

	it('a run id gives the same NOT_FOUND for a private item, another org, a limited token and a made up id', async () => {
		await online();
		const secret = await createItem(as('admin'), {
			project: w.projectKey,
			title: 'Private run item',
			visibility: 'private',
			phases: [{ key: '1', title: 'Build', steps: [{ text: 'Run it' }] }],
			manualChecks: [{ key: 'M1', text: 'Works', auto: true }]
		});
		await saveCheck(as('admin'), { item: secret.ref, key: 'M1', script: 's' });
		const asked = await requestRun(as('admin'), { item: secret.ref, key: 'M1', target: 'preview' });
		const same = { code: 'NOT_FOUND', message: 'No such run.' };
		await expect(getRun(as('member'), asked.run.id)).rejects.toMatchObject(same);
		await expect(waitForRun(as('member'), { run: asked.run.id, seconds: 0 })).rejects.toMatchObject(
			same
		);
		await expect(getRun(stranger(), asked.run.id)).rejects.toMatchObject(same);
		await expect(getRun(limited(), asked.run.id)).rejects.toMatchObject(same);
		await expect(
			getRun(as('member'), '00000000-0000-4000-8000-000000000000')
		).rejects.toMatchObject(same);
		// The person who may see the item reads it
		expect((await getRun(as('admin'), asked.run.id)).item).toBe(secret.ref);
		// A wait on something that is not an id is refused as input
		await expect(waitForRun(as('member'), { run: 'nope', seconds: 0 })).rejects.toThrow();
		await db.admin.exec(
			`update check_run set result = 'timeout' where result in ('queued','running')`
		);
	});

	it('only a few waiters run at once per org, and the counter is released when a wait ends', async () => {
		await online();
		const it6 = await newItem();
		await saveCheck(as('member'), { item: it6.ref, key: 'M1', script: 's' });
		const asked = await requestRun(as('member'), { item: it6.ref, key: 'M1', target: 'preview' });
		const held = Array.from({ length: 5 }, () =>
			waitForRun(as('member'), { run: asked.run.id, seconds: 2 }, { pollMs: 200 })
		);
		// Wait for the real state: five waits open, not a fixed time
		await vi.waitFor(() => expect(waitersFor(w.orgId)).toBe(5));
		await expect(
			waitForRun(as('member'), { run: asked.run.id, seconds: 2 }, { pollMs: 200 })
		).rejects.toMatchObject({ code: 'RATE_LIMITED' });
		await Promise.all(held);
		expect(waitersFor(w.orgId)).toBe(0);
		// Free again after they end
		const again = await waitForRun(
			as('member'),
			{ run: asked.run.id, seconds: 1 },
			{ pollMs: 100 }
		);
		expect(again.finished).toBe(false);
		await db.admin.exec(
			`update check_run set result = 'timeout' where result in ('queued','running')`
		);
	});

	it('a run that cannot start says TOOL_OFFLINE at once, and a finished wait returns without waiting', async () => {
		const it7 = await newItem();
		await saveCheck(as('member'), { item: it7.ref, key: 'M1', script: 's' });
		await db.admin.exec(`update runner set last_seen_at = now() - interval '10 minutes'`);
		const down = await requestRun(as('member'), { item: it7.ref, key: 'M1', target: 'preview' });
		expect(down.unavailable).toBe(true);
		expect(down.run).toMatchObject({ result: 'unavailable', code: 'TOOL_OFFLINE' });
		expect(down.run.fix).toMatch(/runner_status/);
		const started = Date.now();
		const waited = await waitForRun(as('member'), { run: down.run.id, seconds: 30 });
		expect(waited.finished).toBe(true);
		expect(Date.now() - started).toBeLessThan(2000);
		// An unavailable run is not an open run, so asking again makes a new one
		await online();
		const up = await requestRun(as('member'), { item: it7.ref, key: 'M1', target: 'preview' });
		expect(up.reused).toBe(false);
		expect(up.unavailable).toBe(false);
		await db.admin.exec(
			`update check_run set result = 'timeout' where result in ('queued','running')`
		);
	});

	it('a repeated requestId returns the first result for save, run and delete, and a changed request is refused', async () => {
		await online();
		const it8 = await newItem();
		const withId = (requestId: string, fingerprint = 'fp') => ({
			...as('member'),
			requestId,
			fingerprint
		});
		const first = await saveCheck(withId('rid-save-0001'), {
			item: it8.ref,
			key: 'M1',
			script: 's'
		});
		expect(first.created).toBe(true);
		// The repeat returns what the first call returned, not "already there"
		expect(
			await saveCheck(withId('rid-save-0001'), { item: it8.ref, key: 'M1', script: 's' })
		).toEqual(first);
		await expect(
			saveCheck(withId('rid-save-0001', 'other'), { item: it8.ref, key: 'M1', script: 'different' })
		).rejects.toMatchObject({ code: 'CONFLICT' });
		// A run asked twice with one id is one run, even after it finished
		const asked = await requestRun(withId('rid-run-00001'), {
			item: it8.ref,
			key: 'M1',
			target: 'preview'
		});
		const job = await claimCheckJob(db, auth, services);
		await finishCheckRun(db, auth, job!.id, { result: 'pass' }, services);
		const again = await requestRun(withId('rid-run-00001'), {
			item: it8.ref,
			key: 'M1',
			target: 'preview'
		});
		expect(again.run.id).toBe(asked.run.id);
		const runs = await db.admin.query<{ n: number }>(
			`select count(*)::int as n from check_run where check_id in (select id from "check" where item_id = '${it8.id}')`
		);
		expect(runs[0].n).toBe(1);
		// A delete retried after a lost reply is not an error
		expect(await deleteCheck(withId('rid-del-00001'), it8.ref, 'M1')).toEqual({ deleted: true });
		expect(await deleteCheck(withId('rid-del-00001'), it8.ref, 'M1')).toEqual({ deleted: true });
		await db.admin.exec(
			`update check_run set result = 'timeout' where result in ('queued','running')`
		);
	});

	it('a run asked for a named environment is not answered with a run queued for another', async () => {
		await online();
		const it9 = await newItem();
		await saveCheck(as('member'), { item: it9.ref, key: 'M1', script: 's' });
		const open = await requestRun(as('member'), { item: it9.ref, key: 'M1', target: 'preview' });
		expect(open.run.result).toBe('queued');
		// No environment named: the open run is returned. One that does not exist is refused, never swapped for the open run
		expect(
			(await requestRun(as('member'), { item: it9.ref, key: 'M1', target: 'preview' })).reused
		).toBe(true);
		await expect(
			requestRun(as('member'), {
				item: it9.ref,
				key: 'M1',
				target: 'preview',
				environment: 'staging'
			})
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await db.admin.exec(
			`update check_run set result = 'timeout' where result in ('queued','running')`
		);
	});

	it('runner_status says online, offline and none, for a reader too, and never shows a token or a name', async () => {
		await online();
		const on = await runnerStatus(as('viewer'), w.projectKey);
		expect(on.projects).toHaveLength(1);
		expect(on.projects[0]).toMatchObject({
			project: w.projectKey,
			online: true,
			kind: 'tool',
			minProtocol: TOOL_PROTOCOL_MIN
		});
		expect(on.projects[0].heldRuns).toBeGreaterThanOrEqual(0);
		const text = JSON.stringify(on);
		expect(text).not.toContain(token);
		expect(text).not.toContain('Test PC');
		await db.admin.exec(`update runner set last_seen_at = now() - interval '10 minutes'`);
		const off = await runnerStatus(as('member'));
		expect(off.projects[0].online).toBe(false);
		expect(off.projects[0].hint).toMatch(/not running/);
		// A tool that is connected but not running gets steps for the agent, never an instruction for a person, and an online one gets none
		expect(on.projects[0].agentAction).toBeNull();
		expect(off.projects[0].agentAction).toMatchObject({ action: 'repair' });
		expect(off.projects[0].agentAction?.steps.join('\n')).toContain(
			'node afb-checks.mjs doctor --fix --json'
		);
		expect(off).toHaveProperty('board');
		// A token limited to another project sees none of this org's projects, and cannot ask for one by name
		expect((await runnerStatus(limited())).projects).toEqual([]);
		await expect(runnerStatus(limited(), w.projectKey)).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		await db.admin.exec(`delete from runner`);
		const none = await runnerStatus(as('member'), w.projectKey);
		expect(none.projects[0]).toMatchObject({ online: false, kind: null, lastSeen: null });
		expect(none.projects[0].hint).toMatch(/connect/);
		// Nothing is connected: the agent connects the tool itself, with the org slug of the caller, and approves its own code through the board
		const connect = none.projects[0].agentAction!;
		expect(connect.action).toBe('connect');
		const steps = connect.steps.join('\n');
		expect(steps).toMatch(/connect --server .* --org world-\d+ --json/);
		expect(steps).toContain('tool_connection_approve');
		expect(steps).toContain('doctor --fix --json');
		// The steps never carry a token, a code or a verifier
		expect(steps).not.toMatch(/afx_|verifier=|userCode=/);
	});

	it('toolAgentAction names no person: three states, each a list of steps for the agent', () => {
		for (const state of ['repair', 'connect', 'runner'] as const) {
			const a = toolAgentAction(state, { board: 'https://afb.example', org: 'acme' });
			expect(a.action).toBe(state);
			expect(a.steps.length).toBeGreaterThan(0);
			expect(JSON.stringify(a)).not.toMatch(/a person|the person|keyboard/i);
		}
		// With nothing known it says what to fill in, and does not invent an address
		expect(toolAgentAction('connect', {}).steps[0]).toContain('<board address>');
	});
});
