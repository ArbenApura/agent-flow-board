// QA MAP (AFB-20261125-0442): THE MERGE KEEPS A PERSON'S EDITS, SAFE TARGETS, PROOF AND MASKING, ONE BUG PER CAUSE, THE CLOSE RULE,
// PRIVATE RUNS, THE TRASH AND ORG PURGES, AND THE ORG WALL

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { updateTask } from '../../src/lib/server/ops/docs';
import { purgeTrash } from '../../src/lib/server/ops/history';
import { createItem, getItem, listItems, trashItem } from '../../src/lib/server/ops/items';
import {
	baselineOf,
	causeKeyOf,
	deriveStatus,
	keepRemoved,
	liveCaseKeys,
	editFeature,
	getMap,
	globToRegExp,
	linkPlanFeatures,
	maskEntered,
	maskObserved,
	mergeFeatureMap,
	mergeMap,
	planFeatureCount,
	planFeatures,
	redactResult,
	setTargets,
	type QaResultLite
} from '../../src/lib/server/ops/qa';
import { listBugs, recordResults, startRun } from '../../src/lib/server/ops/qaRuns';
import { setStatus } from '../../src/lib/server/ops/status';
import { recordSteps } from '../../src/lib/server/ops/steps';
import { dueOrgPurges, purgeOrg } from '../../src/lib/server/orgs/purge';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, PLAN, type World } from '../support/ops';

// -- CONSTANTS -- //

const PREVIEW = 'http://localhost:7174/planning';
const map = (expected = 'Form opens') => ({
	journeys: [
		{
			key: 'new',
			name: 'New estimate',
			steps: [
				{
					key: 'open',
					page: '/planning',
					action: 'Click New estimate',
					expected: { screen: 'Brief form opens' },
					cases: [{ key: 'click', input: 'click', expected }]
				}
			]
		}
	]
});
const CASE = 'new/open/click';
let n = 0;
const rid = (label: string) => `qa-test-${label}-${++n}`;

// -- FUNCTIONS -- //

describe('qa map, pure rules', () => {
	const r = (over: Partial<QaResultLite>): QaResultLite => ({
		id: String(Math.random()),
		featureId: 'f',
		caseKey: CASE,
		outcome: 'works',
		width: 1440,
		mode: 'light',
		targetHost: 'http://localhost:7174',
		commit: 'a',
		createdAt: new Date('2026-11-25T10:00:00Z'),
		runItemId: 'i',
		role: '',
		...over
	});

	it('an admin who may see it and a guest who must not are two checks, never one flaky one', () => {
		const d = deriveStatus([
			r({ outcome: 'works', role: 'admin', runItemId: 'run-1' }),
			r({
				outcome: 'broken',
				role: 'guest',
				runItemId: 'run-1',
				createdAt: new Date('2026-11-25T11:00:00Z')
			})
		]);
		expect(d.flaky).toBe(false);
		expect(d.brokenCases).toEqual([CASE]);
	});

	it('casesWorking counts each case once, however many widths and modes it was tested at', () => {
		const works = [390, 768, 1440].flatMap((width) =>
			(['light', 'dark'] as const).map((mode) => r({ outcome: 'works', width, mode }))
		);
		// One case tested at 6 tuples is 6 works but one working case
		const d = deriveStatus(works);
		expect(d.counts.works).toBe(6);
		expect(d.casesWorking).toBe(1);
		// The same case broken at one width is no longer a working case
		const mixed = deriveStatus([
			...works,
			r({
				outcome: 'broken',
				width: 390,
				mode: 'dark',
				createdAt: new Date('2026-11-25T12:00:00Z'),
				runItemId: 'run-2'
			})
		]);
		expect(mixed.casesWorking).toBe(0);
		expect(deriveStatus([]).casesWorking).toBe(0);
	});

	it('a feature that only flickered before the plan keeps a works baseline', () => {
		const flicker = deriveStatus([
			r({ outcome: 'works', runItemId: 'run-1' }),
			r({ outcome: 'broken', runItemId: 'run-1', createdAt: new Date('2026-11-25T11:00:00Z') })
		]);
		expect(baselineOf(flicker)).toBe('works');
		expect(baselineOf(deriveStatus([r({ outcome: 'broken' })]))).toBe('broken');
	});

	it('an edited map keeps what the map flagged removed', () => {
		const stored = map();
		stored.journeys[0].steps[0].cases[0] = {
			...stored.journeys[0].steps[0].cases[0],
			removedAt: '2026-11-25T00:00:00Z'
		} as never;
		const kept = keepRemoved(stored, map('Edited'));
		expect(kept.journeys[0].steps[0].cases[0].removedAt).toBe('2026-11-25T00:00:00Z');
		expect(liveCaseKeys(kept).size).toBe(0);
	});

	it('a works in one run then a broken in a later run is a regression, even at the same commit', () => {
		// A plan builds on an uncommitted tree, so both runs report the same commit (code review, 2026-11-25)
		for (const commit of ['a', '']) {
			const d = deriveStatus([
				r({ outcome: 'works', commit, runItemId: 'run-1' }),
				r({
					outcome: 'broken',
					commit,
					runItemId: 'run-2',
					createdAt: new Date('2026-11-25T11:00:00Z')
				})
			]);
			expect(d.status).toBe('broken');
			expect(d.flaky).toBe(false);
			expect(d.brokenCases).toEqual([CASE]);
		}
	});

	it('works and broken within one run is flaky: shown Broken, but not a break the close rule counts', () => {
		const d = deriveStatus([
			r({ outcome: 'works', runItemId: 'run-1' }),
			r({ outcome: 'broken', runItemId: 'run-1', createdAt: new Date('2026-11-25T11:00:00Z') })
		]);
		expect(d.flaky).toBe(true);
		expect(d.status).toBe('broken');
		expect(d.brokenCases).toEqual([]);
	});

	it("a later Couldn't test never hides an earlier break", () => {
		const d = deriveStatus([
			r({ outcome: 'broken', runItemId: 'run-1' }),
			r({
				outcome: 'could_not_test',
				runItemId: 'run-2',
				createdAt: new Date('2026-11-25T11:00:00Z')
			})
		]);
		expect(d.status).toBe('broken');
		expect(d.brokenCases).toEqual([CASE]);
	});

	it('a plan that finished after the latest result means Needs retest', () => {
		const d = deriveStatus([r({})], [new Date('2026-11-26T00:00:00Z')]);
		expect(d.status).toBe('needs_retest');
		expect(deriveStatus([]).status).toBe('not_tested');
	});

	it('a merge keeps the edited path, writes a conflict and flags what is gone', () => {
		const merged = mergeFeatureMap(map('Person text'), map('Agent text'), [
			'new/open/click.expected'
		]);
		expect(merged.map.journeys[0].steps[0].cases[0].expected).toBe('Person text');
		expect(merged.conflicts[0]).toContain('new/open/click.expected');
		const gone = mergeFeatureMap(map(), { journeys: [] }, []);
		expect(gone.map.journeys[0].removedAt).toBeTruthy();
		expect(gone.diff.removed).toEqual(['new']);
	});

	it('matches globs, masks secrets and gives one cause key for the same break', () => {
		expect(globToRegExp('src/routes/planning/**').test('src/routes/planning/+page.svelte')).toBe(
			true
		);
		expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
		expect(maskEntered([{ field: 'Password', value: 'hunter2' }])[0].value).toBe('[hidden]');
		expect(maskEntered([{ field: 'Name', value: 'Ana' }])[0].value).toBe('Ana');
		expect(maskObserved('token abcdefghijklmnopqrstuvwxyz0123456789 seen')).not.toContain(
			'abcdefghij'
		);
		expect(causeKeyOf('f', '/p', 'Error 500 at line 12')).toBe(
			causeKeyOf('f', '/p', 'Error  501 at line 9')
		);
	});
});

describe('qa map, operations', () => {
	let db: TestDb;
	let w: World;
	const storage = memoryStorage('qa-test-secret-0123456789abcdef');
	const services = { storage, baseUrl: 'https://afb.test' };
	const as = (who: keyof World['people'], requestId?: string) => ({
		...w.ctx(who, requestId ? { requestId } : {}),
		services
	});
	const agent = (who: keyof World['people'], requestId?: string) => ({
		...w.ctx(who, { kind: 'agent', ...(requestId ? { requestId } : {}) }),
		services
	});
	const feature = async (key: string) =>
		(await getMap(as('member'), { project: w.projectKey, feature: key })).features[0];
	const addFeature = (key: string) =>
		mergeMap(as('member', rid('merge')), {
			project: w.projectKey,
			features: [
				{
					key,
					name: `Feature ${key}`,
					area: 'Planning',
					codeGlobs: [`src/${key}/**`],
					sizes: [1440],
					map: map()
				}
			]
		});
	const run = (commit: string, features: string[]) =>
		startRun(as('member', rid('run')), {
			project: w.projectKey,
			target: PREVIEW,
			commit,
			features
		});
	const result = (
		runRef: string,
		key: string,
		outcome: 'works' | 'broken',
		observed = 'Form opened'
	) =>
		recordResults(as('member', rid('res')), {
			run: runRef,
			results: [
				{
					feature: key,
					caseKey: CASE,
					outcome,
					width: 1440,
					mode: 'light',
					observed,
					page: '/planning'
				}
			]
		});
	const plan = async (title: string) => {
		const p = await createItem(as('owner'), { project: w.projectKey, title, ...PLAN });
		return p;
	};
	const finish = (ref: string) =>
		recordSteps(as('owner'), {
			item: ref,
			marks: ['1.1', '1.2', '2.1', '2.2'].map((key) => ({ key, mark: 'done' as const }))
		});

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 120_000);
	afterAll(() => db?.stop());

	it('adds a feature, then refuses a merge without the version or with an old one', async () => {
		const made = await addFeature('estimate');
		expect(made.features[0].created).toBe(true);
		await expect(addFeature('estimate')).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			mergeMap(as('member', rid('m')), {
				project: w.projectKey,
				features: [{ key: 'estimate', name: 'x', map: map(), expectVersion: 99 }]
			})
		).rejects.toMatchObject({ code: 'STALE_VERSION' });
	});

	it("keeps a person's edit through the next merge and flags a missing feature", async () => {
		const f = await feature('estimate');
		const edited = map('The person wrote this');
		await editFeature(as('member', rid('edit')), {
			project: w.projectKey,
			feature: 'estimate',
			expectVersion: f.version,
			map: edited
		});
		const after = await feature('estimate');
		expect(after.editedPaths).toContain('new/open/click.expected');
		await mergeMap(as('member', rid('m')), {
			project: w.projectKey,
			features: [
				{
					key: 'estimate',
					name: after.name,
					map: map('Agent wrote this'),
					expectVersion: after.version
				}
			]
		});
		const kept = await feature('estimate');
		expect(kept.map.journeys[0].steps[0].cases[0].expected).toBe('The person wrote this');
		expect(kept.conflicts.length).toBeGreaterThan(0);
		await addFeature('gone');
		await mergeMap(as('member', rid('m')), {
			project: w.projectKey,
			features: [{ key: 'estimate', name: kept.name, map: kept.map, expectVersion: kept.version }],
			missing: ['gone']
		});
		const map2 = await getMap(as('member'), { project: w.projectKey });
		expect(map2.features.map((x) => x.key)).not.toContain('gone');
		expect((await feature('gone')).removedAt).toBeTruthy();
	});

	it('refuses a target that is not allowed, and the build preview never takes writes', async () => {
		await expect(
			startRun(as('member', rid('r')), {
				project: w.projectKey,
				target: 'https://live.example.com'
			})
		).rejects.toMatchObject({ code: 'INVALID' });
		const r = await run('a', ['estimate']);
		expect(r.writes).toBe(false);
		await expect(
			setTargets(as('member', rid('t')), {
				project: w.projectKey,
				targets: [{ origin: 'https://staging.example.com', writes: true }]
			})
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await setTargets(as('admin', rid('t')), {
			project: w.projectKey,
			targets: [{ origin: 'https://staging.example.com', writes: true }]
		});
		const staged = await startRun(as('member', rid('r')), {
			project: w.projectKey,
			target: 'https://staging.example.com/x',
			features: ['estimate']
		});
		expect(staged.writes).toBe(true);
	});

	it('hides run items from the list, but finds them by reference', async () => {
		const r = await run('a', ['estimate']);
		const list = await listItems(as('member'), { project: w.projectKey });
		expect(list.items.map((i: { ref: string }) => i.ref)).not.toContain(r.run);
		expect((await getItem(as('member'), r.run)).item.ref).toBe(r.run);
	});

	it('needs a request id and proof, writes a retried batch once, numbers tries and masks secrets', async () => {
		const r = await run('a', ['estimate']);
		await expect(
			recordResults(as('member'), {
				run: r.run,
				results: [
					{
						feature: 'estimate',
						caseKey: CASE,
						outcome: 'works',
						width: 1440,
						mode: 'light',
						observed: 'ok'
					}
				]
			})
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			recordResults(as('member', rid('p')), {
				run: r.run,
				results: [
					{ feature: 'estimate', caseKey: CASE, outcome: 'works', width: 1440, mode: 'light' }
				]
			})
		).rejects.toMatchObject({ code: 'INVALID' });
		const same = rid('same');
		const batch = {
			run: r.run,
			results: [
				{
					feature: 'estimate',
					caseKey: CASE,
					outcome: 'works' as const,
					width: 1440,
					mode: 'light' as const,
					observed: 'Form opened',
					dataEntered: [{ field: 'Password', value: 'hunter2' }],
					flaky: true
				}
			]
		};
		await recordResults(as('member', same), batch as never);
		await recordResults(as('member', same), batch as never);
		await recordResults(as('member', rid('again')), batch as never);
		const rows = await db.admin.query<{
			attempt: number;
			data: { value: string }[];
			observed: string;
		}>(
			`select attempt, data_entered as data, observed from qa_result r join qa_run q on q.id = r.run_id
			 join item i on i.id = q.item_id where i.ref = '${r.run}' order by attempt`
		);
		expect(rows.map((x) => x.attempt)).toEqual([1, 2]);
		expect(rows[0].data[0].value).toBe('[hidden]');
	});

	it('files one bug per cause, and a new one when the old bug is done', async () => {
		await addFeature('bugs');
		const r = await run('a', ['bugs']);
		const first = await result(r.run, 'bugs', 'broken', 'Error 500 on save');
		const second = await result(r.run, 'bugs', 'broken', 'Error 501 on save');
		expect(first.bugs[0].created).toBe(true);
		expect(second.bugs[0].created).toBe(false);
		expect(second.bugs[0].ref).toBe(first.bugs[0].ref);
		const bugs = await listBugs(as('member'), { project: w.projectKey });
		const bug = bugs.find((b) => b.ref === first.bugs[0].ref)!;
		await updateTask(as('member', rid('done')), { task: bug.id, status: 'DONE' });
		const third = await result(r.run, 'bugs', 'broken', 'Error 502 on save');
		expect(third.bugs[0].created).toBe(true);
		expect(third.bugs[0].ref).not.toBe(first.bugs[0].ref);
	});

	it('refuses to close a plan that broke a feature, lets the owner close anyway, never an agent', async () => {
		await addFeature('close');
		const before = await run('a', ['close']);
		await result(before.run, 'close', 'works');
		const p = await plan('A plan that breaks close');
		const linked = await linkPlanFeatures(as('owner', rid('l')), {
			item: p.ref,
			files: ['src/close/page.svelte']
		});
		expect(linked.features[0].baseline).toBe('works');
		await finish(p.ref);
		// The same commit on purpose: the plan is built on an uncommitted tree, so the rerun reports the same HEAD
		const after = await run('a', ['close']);
		await result(after.run, 'close', 'broken', 'The form does not open');
		await expect(
			setStatus(as('owner', rid('s')), { item: p.ref, status: 'COMPLETED', note: 'Done here' })
		).rejects.toMatchObject({ code: 'COMPLETED_REFUSED', details: { reason: 'qa-broken' } });
		await expect(
			setStatus(agent('owner', rid('s')), {
				item: p.ref,
				status: 'COMPLETED',
				note: 'Done here',
				override: { reason: 'Ship it' }
			})
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			setStatus(as('admin', rid('s')), {
				item: p.ref,
				status: 'COMPLETED',
				note: 'Done here',
				override: { reason: 'Ship it' }
			})
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		const done = await setStatus(as('owner', rid('s')), {
			item: p.ref,
			status: 'COMPLETED',
			note: 'Done here',
			override: { reason: 'Known, fixed next week' }
		});
		expect(done.statusChanges[0].to).toBe('COMPLETED');
		const [ev] = await db.admin.query<{ n: number }>(
			`select count(*)::int as n from event where verb = 'qa.close.override' and item_id = '${p.id}'`
		);
		expect(ev.n).toBe(1);
	});

	it('lets a plan close when the feature was already broken before it, and a late link never hides a break', async () => {
		await addFeature('early');
		const before = await run('a', ['early']);
		await result(before.run, 'early', 'broken', 'Broken from the start');
		const p = await plan('A plan on a broken feature');
		await linkPlanFeatures(as('owner', rid('l')), { item: p.ref, files: ['src/early/x.ts'] });
		await finish(p.ref);
		const ok = await setStatus(as('owner', rid('s')), {
			item: p.ref,
			status: 'COMPLETED',
			note: 'Done here'
		});
		expect(ok.statusChanges[0].to).toBe('COMPLETED');

		await addFeature('late');
		const good = await run('a', ['late']);
		await result(good.run, 'late', 'works');
		const q = await plan('A plan that links late');
		await finish(q.ref);
		const bad = await run('b', ['late']);
		await result(bad.run, 'late', 'broken', 'Now broken');
		const linked = await linkPlanFeatures(as('owner', rid('l')), {
			item: q.ref,
			files: ['src/late/x.ts']
		});
		expect(linked.features[0].baseline).toBe('works');
		await expect(
			setStatus(as('owner', rid('s')), { item: q.ref, status: 'COMPLETED', note: 'Done here' })
		).rejects.toMatchObject({ code: 'COMPLETED_REFUSED' });
		expect((await planFeatures(as('owner'), q.ref))[0].status).toBe('broken');
	});

	it("hides a private run's results from another member and gives its bug a neutral title", async () => {
		await addFeature('secret');
		const r = await run('a', ['secret']);
		await db.admin.exec(
			`update item set visibility = 'private', created_by = '${w.people.member}' where ref = '${r.run}'`
		);
		const res = await result(r.run, 'secret', 'broken', 'The secret feature shows an error');
		expect((await feature('secret')).status).toBe('broken');
		const seenByAdmin = await getMap(as('admin'), { project: w.projectKey, feature: 'secret' });
		expect(seenByAdmin.features[0].status).toBe('not_tested');
		const bugs = await listBugs(as('admin'), { project: w.projectKey });
		const bug = bugs.find((b) => b.ref === res.bugs[0].ref)!;
		expect(bug.title).toContain('private run');
		expect(bug.title).not.toContain('secret feature');
	});

	it('keeps Testing from guests in every read, while their item page still counts 0 features', async () => {
		// A guest invited to the project reads its plans, but not its Testing page
		await db.admin.exec(
			`insert into project_member (org_id, project_id, user_id, role) values ('${w.orgId}', '${w.projectId}', '${w.people.guest}', 'guest') on conflict do nothing`
		);
		await expect(getMap(as('guest'), { project: w.projectKey })).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await expect(listBugs(as('guest'), { project: w.projectKey })).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		const p = await plan('A plan a guest opens');
		expect(await planFeatureCount(as('guest'), p.ref)).toBe(0);
	});

	it('refuses a broken result with no words and a case that is not on the map', async () => {
		const r = await run('a', ['estimate']);
		await expect(
			recordResults(as('member', rid('w')), {
				run: r.run,
				results: [
					{ feature: 'estimate', caseKey: CASE, outcome: 'broken', width: 1440, mode: 'light' }
				]
			})
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			recordResults(as('member', rid('w')), {
				run: r.run,
				results: [
					{
						feature: 'estimate',
						caseKey: 'new/open/typo',
						outcome: 'works',
						width: 1440,
						mode: 'light',
						observed: 'ok'
					}
				]
			})
		).rejects.toMatchObject({ code: 'INVALID' });
	});

	it('redacts the bug filed from a result too', async () => {
		await addFeature('redact-bug');
		const r = await run('a', ['redact-bug']);
		const res = await result(r.run, 'redact-bug', 'broken', 'Shows a private address');
		const [row] = await db.admin.query<{ id: string }>(
			`select r.id from qa_result r join item i on i.id = r.run_item_id where i.ref = '${r.run}'`
		);
		await redactResult(as('owner', rid('x')), { result: row.id });
		const bugs = await listBugs(as('member'), { project: w.projectKey });
		const bug = bugs.find((b) => b.ref === res.bugs[0].ref)!;
		expect(bug.title).toBe('QA: a redacted issue');
	});

	it('only the owner redacts a result', async () => {
		await addFeature('redact');
		const r = await run('a', ['redact']);
		await result(r.run, 'redact', 'works', 'Saw something private');
		const [row] = await db.admin.query<{ id: string }>(
			`select r.id from qa_result r join item i on i.id = r.run_item_id where i.ref = '${r.run}'`
		);
		await expect(redactResult(as('admin', rid('x')), { result: row.id })).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await redactResult(as('owner', rid('x')), { result: row.id });
		const [after] = await db.admin.query<{ observed: string }>(
			`select observed from qa_result where id = '${row.id}'`
		);
		expect(after.observed).toBe('[redacted]');
	});

	it('keeps the org wall: another organisation cannot read this map', async () => {
		const other = {
			handle: db,
			orgId: w.other.orgId,
			actor: { userId: w.other.userId, kind: 'person' as const },
			services
		};
		await expect(getMap(other, { project: w.projectKey })).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		const seen = await db.admin.query<{ n: number }>(
			`select count(*)::int as n from qa_feature where org_id = '${w.other.orgId}'`
		);
		expect(seen[0].n).toBe(0);
	});

	it('purges a trashed bug task and a trashed run item with results', async () => {
		await addFeature('purge');
		const r = await run('a', ['purge']);
		const res = await result(r.run, 'purge', 'broken', 'Purge me');
		const bugs = await listBugs(as('member'), { project: w.projectKey });
		const bug = bugs.find((b) => b.ref === res.bugs[0].ref)!;
		await db.admin.exec(
			`update task set deleted_at = now() - interval '31 days' where id = '${bug.id}'`
		);
		await trashItem(as('member'), r.run);
		await db.admin.exec(
			`update item set deleted_at = now() - interval '31 days' where ref = '${r.run}' and org_id = '${w.orgId}'`
		);
		await purgeTrash(as('admin'));
		const [left] = await db.admin.query<{ n: number }>(
			`select count(*)::int as n from qa_run q join item i on i.id = q.item_id where i.ref = '${r.run}'`
		);
		expect(left.n).toBe(0);
		const [task] = await db.admin.query<{ n: number }>(
			`select count(*)::int as n from task where id = '${bug.id}'`
		);
		expect(task.n).toBe(0);
	});

	it('purges an organisation with QA data', async () => {
		await db.admin.exec(
			`update org set deleted_at = now() - interval '40 days' where id = '${w.orgId}'`
		);
		expect(await dueOrgPurges(db)).toContain(w.orgId);
		expect(await purgeOrg({ handle: db, storage, backups: null }, w.orgId)).toBe('purged');
		const [n] = await db.admin.query<{ n: number }>(
			`select count(*)::int as n from qa_feature where org_id = '${w.orgId}'`
		);
		expect(n.n).toBe(0);
	});
});
