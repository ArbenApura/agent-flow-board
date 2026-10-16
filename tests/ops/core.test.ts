// 5.2 TO 5.7: PERMISSIONS, STALE WRITES, RETRIES, LIMITS, THE AUTOMATIC STATUS MOVES AND THE COMPLETED RULES

// -- DEP-MODULES -- //
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { event, item, project, task } from '../../src/lib/server/db/schema';
import { LIMITS, OpError } from '../../src/lib/server/ops/context';
import {
	createItem,
	getItem,
	listItems,
	restoreItem,
	trashItem,
	updateItem
} from '../../src/lib/server/ops/items';
import { recordSteps } from '../../src/lib/server/ops/steps';
import { automaticMoves, setStatus } from '../../src/lib/server/ops/status';
import { withTenant } from '../../src/lib/server/db/tenant';
import { makePglite, makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

describe('automatic status rules (pure)', () => {
	const base = { total: 4, done: 0, changedCounted: true, anyDone: false };
	it('the first done step moves PLANNED to IN PROGRESS', () => {
		expect(automaticMoves({ ...base, status: 'PLANNED', done: 1, anyDone: true })).toEqual([
			'IN PROGRESS'
		]);
	});
	it('100% moves IN PROGRESS and TESTING to IN REVIEW, and PLANNED gets both moves in order', () => {
		expect(automaticMoves({ ...base, status: 'IN PROGRESS', done: 4, anyDone: true })).toEqual([
			'IN REVIEW'
		]);
		expect(automaticMoves({ ...base, status: 'TESTING', done: 4, anyDone: true })).toEqual([
			'IN REVIEW'
		]);
		expect(automaticMoves({ ...base, status: 'PLANNED', done: 4, anyDone: true })).toEqual([
			'IN PROGRESS',
			'IN REVIEW'
		]);
	});
	it('nothing moves without a changed counted step, never backwards, never from closing or hold states', () => {
		expect(
			automaticMoves({ ...base, status: 'PLANNED', done: 1, anyDone: true, changedCounted: false })
		).toEqual([]);
		expect(automaticMoves({ ...base, status: 'IN REVIEW', done: 2 })).toEqual([]);
		for (const s of ['ON HOLD', 'COMPLETED', 'REMOVED'] as const)
			expect(automaticMoves({ ...base, status: s, done: 4, anyDone: true })).toEqual([]);
		expect(
			automaticMoves({ ...base, status: 'IN PROGRESS', total: 0, done: 0, anyDone: true })
		).toEqual([]);
	});
});

describe.each([
	['pglite', makePglite],
	['postgres', makePostgres]
] as const)('operations on %s', (name, make) => {
	let db: TestDb;
	let w: World;
	beforeAll(async () => {
		db = await make();
		w = await makeWorld(db);
	}, 180_000);
	afterAll(async () => {
		await db?.stop();
	});

	const create = (
		who: keyof World['people'] = 'member',
		extra: Record<string, unknown> = {},
		ctxExtra = {}
	) =>
		createItem(w.ctx(who, ctxExtra), {
			project: w.projectKey,
			title: 'A planned item',
			phases: PLAN.phases,
			manualChecks: PLAN.manualChecks,
			...extra
		});

	it('creates an item with its plan, a readable reference and a tab name', async () => {
		const made = await create('member');
		expect(made.ref).toMatch(/^WRL/);
		expect(made.item.status).toBe('PLANNED');
		expect(made.item.totalSteps).toBe(4);
		expect(made.item.percent).toBe(0);
		expect(made.item.tabName).toBe('A_PLANNED_ITEM');
		const d = await getItem(w.ctx('viewer'), made.ref);
		expect(d.phases.map((p) => p.steps.map((s) => s.key))).toEqual([
			['1.1', '1.2'],
			['2.1', '2.2']
		]);
		expect(d.manualChecks.map((m) => m.key)).toEqual(['M1', 'M2']);
	});

	it('roles decide who may write, and a token never exceeds its user', async () => {
		await expect(create('viewer')).rejects.toMatchObject({ code: 'FORBIDDEN' });
		// A guest sees no project until given one, so the project is simply not found
		await expect(create('guest')).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(create('member', {}, { tokenCaps: ['read'] })).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		// A viewer's token that lists write still cannot write, because the intersection uses the live role
		await expect(create('viewer', {}, { tokenCaps: ['read', 'write'] })).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await expect(create('member', {}, { tokenCaps: ['read', 'write'] })).resolves.toBeTruthy();
	});

	it('a demoted user loses access on the next call', async () => {
		const made = await create('member');
		await db.admin.exec(
			`update member set role = 'viewer' where org_id = '${w.orgId}' and user_id = '${w.people.member}'`
		);
		await expect(
			updateItem(w.ctx('member'), { item: made.ref, title: 'Renamed while demoted' })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await db.admin.exec(
			`update member set role = 'member' where org_id = '${w.orgId}' and user_id = '${w.people.member}'`
		);
		await expect(
			updateItem(w.ctx('member'), { item: made.ref, title: 'Renamed after restore' })
		).resolves.toBeTruthy();
	});

	it('another org cannot read or change an item, and gets the same answer as for a missing one', async () => {
		const made = await create('member');
		const intruder = {
			handle: db,
			orgId: w.other.orgId,
			actor: { userId: w.other.userId, kind: 'person' as const }
		};
		await expect(getItem(intruder, made.ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(getItem(intruder, made.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(
			updateItem(intruder, { item: made.id, title: 'Hijacked title' })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(getItem(w.ctx('member'), 'NOPE-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
		// Naming the real org with the intruder's person is refused, not leaked
		await expect(getItem({ ...intruder, orgId: w.orgId }, made.ref)).rejects.toBeTruthy();
	});

	it('private items are visible only to admins, owners, their maker and holder', async () => {
		const priv = await create('member', { visibility: 'private', title: 'A private plan' });
		await expect(getItem(w.ctx('viewer'), priv.ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(getItem(w.ctx('admin'), priv.ref)).resolves.toBeTruthy();
		await expect(getItem(w.ctx('member'), priv.ref)).resolves.toBeTruthy();
		const seen = await listItems(w.ctx('viewer'), { project: w.projectKey });
		expect(seen.items.some((i) => i.id === priv.id)).toBe(false);
		const adminSees = await listItems(w.ctx('admin'), { project: w.projectKey });
		expect(adminSees.items.some((i) => i.id === priv.id)).toBe(true);
	});

	it('a stale write is refused and names the current version', async () => {
		const made = await create('member');
		await updateItem(w.ctx('member'), {
			item: made.ref,
			title: 'First rename',
			expectVersion: made.item.version
		});
		const stale = await updateItem(w.ctx('member'), {
			item: made.ref,
			title: 'Second rename',
			expectVersion: made.item.version
		}).catch((e) => e);
		expect(stale).toBeInstanceOf(OpError);
		expect(stale).toMatchObject({ code: 'STALE_VERSION' });
		expect(stale.details.currentVersion).toBeGreaterThan(made.item.version);
	});

	it('a retried create with the same request id returns the same item and writes nothing twice', async () => {
		const first = await create(
			'member',
			{ title: 'Retry safe item' },
			{ requestId: 'req-create-1' }
		);
		const again = await create(
			'member',
			{ title: 'Retry safe item' },
			{ requestId: 'req-create-1' }
		);
		expect(again.id).toBe(first.id);
		const rows = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(item).where(eq(item.title, 'Retry safe item'))
		);
		expect(rows).toHaveLength(1);
	});

	it('limits writes per actor, and a refused call writes nothing', async () => {
		const saved = { ...LIMITS.create };
		LIMITS.create.max = 2;
		try {
			const ctxExtra = { tokenId: '00000000-0000-4000-8000-0000000000f1' };
			await create('member', { title: 'Limited one' }, ctxExtra);
			await create('member', { title: 'Limited two' }, ctxExtra);
			await expect(create('member', { title: 'Limited three' }, ctxExtra)).rejects.toMatchObject({
				code: 'RATE_LIMITED'
			});
			const rows = await withTenant(db, { orgId: w.orgId }, (tx) =>
				tx.select().from(item).where(eq(item.title, 'Limited three'))
			);
			expect(rows).toHaveLength(0);
		} finally {
			Object.assign(LIMITS.create, saved);
		}
	});

	it('M17 status moves: first done step, last step, reopen, log only, manual check, waived', async () => {
		const made = await create('member');
		const rec = (
			marks: {
				key: string;
				mark: 'done' | 'open' | 'waived' | 'superseded';
				reason?: string;
				supersededBy?: string;
			}[],
			extra = {}
		) => recordSteps(w.ctx('member'), { item: made.ref, marks, ...extra });
		// A log line alone moves nothing
		const logged = await rec([], { log: 'Looked around the code' });
		expect(logged.statusChanges).toEqual([]);
		expect((await getItem(w.ctx('member'), made.ref)).item.status).toBe('PLANNED');
		// A manual check moves nothing
		expect(
			(await rec([{ key: 'M1', mark: 'waived', reason: 'Arben checked it' }])).statusChanges
		).toEqual([]);
		// A waived counted step is not counted, so it moves nothing either
		const waived = await rec([{ key: '2.2', mark: 'waived', reason: 'Not needed any more' }]);
		expect(waived.statusChanges).toEqual([]);
		expect(waived.percent).toBe(0);
		// The first done step moves PLANNED to IN PROGRESS with the note Automatic
		const one = await rec([{ key: '1.1', mark: 'done' }]);
		expect(one.statusChanges).toEqual([{ from: 'PLANNED', to: 'IN PROGRESS', note: 'Automatic' }]);
		expect(one.percent).toBe(33);
		expect(one.nextOpen[0].key).toBe('1.2');
		// The last counted step moves it to IN REVIEW and says the phase is complete
		await rec([{ key: '1.2', mark: 'done' }]);
		const last = await rec([{ key: '2.1', mark: 'done' }]);
		expect(last.statusChanges).toEqual([
			{ from: 'IN PROGRESS', to: 'IN REVIEW', note: 'Automatic' }
		]);
		expect(last.percent).toBe(100);
		expect(last.finishedPhases).toEqual(['2']);
		expect(last.nextPhase).toBeNull();
		// Reopening a step leaves the status where it is (never backwards)
		const reopened = await rec([{ key: '2.1', mark: 'open' }]);
		expect(reopened.statusChanges).toEqual([]);
		expect(reopened.status).toBe('IN REVIEW');
		const d = await getItem(w.ctx('member'), made.ref);
		expect(d.item.status).toBe('IN REVIEW');
		expect(d.item.health.drift).toContain('in-review-with-open-steps');
		// The history carries Automatic notes
		const history = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(event).where(eq(event.itemId, made.id))
		);
		const moves = history
			.filter((e) => e.verb === 'item.status')
			.map((e) => e.after as { status: string; note: string });
		expect(moves).toEqual([
			{ status: 'IN PROGRESS', note: 'Automatic' },
			{ status: 'IN REVIEW', note: 'Automatic' }
		]);
	});

	it('a PLANNED item that reaches 100% in one call gets both moves in order', async () => {
		const made = await create('member', {
			phases: [{ key: '1', title: 'One', steps: [{ text: 'Only step' }] }],
			manualChecks: []
		});
		const r = await recordSteps(w.ctx('member'), {
			item: made.ref,
			marks: [{ key: '1.1', mark: 'done' }]
		});
		expect(r.statusChanges.map((c) => c.to)).toEqual(['IN PROGRESS', 'IN REVIEW']);
	});

	it('ON HOLD never moves by itself, and an item with no steps is never complete', async () => {
		const made = await create('member', {
			phases: [{ key: '1', title: 'One', steps: [{ text: 'Only step' }] }],
			manualChecks: []
		});
		await setStatus(w.ctx('member'), {
			item: made.ref,
			status: 'ON HOLD',
			note: 'Waiting for the client'
		});
		const r = await recordSteps(w.ctx('member'), {
			item: made.ref,
			marks: [{ key: '1.1', mark: 'done' }]
		});
		expect(r.statusChanges).toEqual([]);
		expect(r.status).toBe('ON HOLD');
		const empty = await create('member', {
			phases: [],
			manualChecks: [],
			title: 'No steps at all'
		});
		expect(
			(
				await recordSteps(w.ctx('member'), {
					item: empty.ref,
					marks: [],
					log: 'Nothing to record yet'
				})
			).statusChanges
		).toEqual([]);
	});

	it('a replayed request id returns the stored result and adds no second event', async () => {
		const made = await create('member');
		const marks = [{ key: '1.1', mark: 'done' as const }];
		const a = await recordSteps(w.ctx('member', { requestId: 'req-record-1' }), {
			item: made.ref,
			marks
		});
		const b = await recordSteps(w.ctx('member', { requestId: 'req-record-1' }), {
			item: made.ref,
			marks
		});
		expect(b).toEqual(a);
		const history = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(event).where(eq(event.itemId, made.id))
		);
		expect(history.filter((e) => e.verb === 'step.update')).toHaveLength(1);
		expect(history.filter((e) => e.verb === 'item.status')).toHaveLength(1);
	});

	it('a dry run shows the result and writes nothing', async () => {
		const made = await create('member');
		const dry = await recordSteps(w.ctx('member'), {
			item: made.ref,
			marks: [{ key: '1.1', mark: 'done' }],
			dryRun: true
		});
		expect(dry.dryRun).toBe(true);
		expect(dry.statusChanges).toHaveLength(1);
		const d = await getItem(w.ctx('member'), made.ref);
		expect(d.item.status).toBe('PLANNED');
		expect(d.phases[0].steps[0].state).toBe('open');
	});

	it('refuses an unknown key, a waiver with no reason and a supersede with no item', async () => {
		const made = await create('member');
		await expect(
			recordSteps(w.ctx('member'), { item: made.ref, marks: [{ key: '9.9', mark: 'done' }] })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(
			recordSteps(w.ctx('member'), { item: made.ref, marks: [{ key: '1.1', mark: 'waived' }] })
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			recordSteps(w.ctx('member'), { item: made.ref, marks: [{ key: '1.1', mark: 'superseded' }] })
		).rejects.toMatchObject({ code: 'INVALID' });
	});

	it('COMPLETED needs every step closed, the capability, and respects the people-only switch', async () => {
		const made = await create('member', {
			phases: [{ key: '1', title: 'One', steps: [{ text: 'Only step' }] }],
			manualChecks: []
		});
		await expect(
			setStatus(w.ctx('member'), { item: made.ref, status: 'COMPLETED', note: 'Done now' })
		).rejects.toMatchObject({ code: 'COMPLETED_REFUSED', details: { reason: 'open-steps' } });
		await expect(
			setStatus(w.ctx('viewer'), { item: made.ref, status: 'COMPLETED', note: 'Done now' })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await recordSteps(w.ctx('member'), { item: made.ref, marks: [{ key: '1.1', mark: 'done' }] });
		// An agent is refused where the project keeps COMPLETED for people
		await db.admin.exec(
			`update project set agents_may_complete = false where id = '${w.projectId}'`
		);
		await expect(
			setStatus(w.ctx('member', { kind: 'agent', tool: 'claude-code' }), {
				item: made.ref,
				status: 'COMPLETED',
				note: 'Done now'
			})
		).rejects.toMatchObject({ code: 'COMPLETED_REFUSED', details: { reason: 'people-only' } });
		// A person may close it
		await expect(
			setStatus(w.ctx('member'), {
				item: made.ref,
				status: 'COMPLETED',
				note: 'Signed off by the team'
			})
		).resolves.toMatchObject({ already: false });
		// With the switch on, an agent may close another item
		await db.admin.exec(
			`update project set agents_may_complete = true where id = '${w.projectId}'`
		);
		const other = await create('member', {
			phases: [],
			manualChecks: [],
			title: 'Closed by an agent'
		});
		await expect(
			setStatus(w.ctx('member', { kind: 'agent' }), {
				item: other.ref,
				status: 'COMPLETED',
				note: 'Agent closed it',
				confirmed: true
			})
		).resolves.toMatchObject({ already: false });
		const [p] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select({ s: project.agentsMayComplete }).from(project).where(eq(project.id, w.projectId))
		);
		expect(p.s).toBe(true);
	});

	it('linked tasks follow progress but are never set DONE', async () => {
		const made = await create('member', {
			phases: [{ key: '1', title: 'One', steps: [{ text: 'a' }, { text: 'b' }] }],
			manualChecks: []
		});
		await db.admin.exec(
			`insert into task (org_id, project_id, number, title, status, linked_item_ids) values ('${w.orgId}', '${w.projectId}', ${900 + Math.floor(Math.random() * 90000)}, 'Linked task', 'TODO', array['${made.id}']::uuid[])`
		);
		await recordSteps(w.ctx('member'), { item: made.ref, marks: [{ key: '1.1', mark: 'done' }] });
		let [t] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(task).where(eq(task.title, 'Linked task'))
		);
		expect(t.status).toBe('IN PROGRESS');
		await recordSteps(w.ctx('member'), { item: made.ref, marks: [{ key: '1.2', mark: 'done' }] });
		await setStatus(w.ctx('member'), {
			item: made.ref,
			status: 'COMPLETED',
			note: 'All done and signed off'
		});
		[t] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(task).where(eq(task.title, 'Linked task'))
		);
		expect(t.status).toBe('IN PROGRESS');
	});

	it('trash hides an item, restore brings it back, and the event can be undone', async () => {
		const made = await create('member', { title: 'Trash me' });
		await trashItem(w.ctx('member'), made.ref);
		await expect(getItem(w.ctx('member'), made.ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		const trashed = await listItems(w.ctx('member'), { project: w.projectKey, trashed: true });
		expect(trashed.items.some((i) => i.id === made.id)).toBe(true);
		await restoreItem(w.ctx('member'), made.ref);
		await expect(getItem(w.ctx('member'), made.ref)).resolves.toBeTruthy();
	});

	it('lists a project by keyset without repeating or skipping items', async () => {
		const seen = new Set<string>();
		let cursor: number | undefined;
		for (let guard = 0; guard < 100; guard++) {
			const page = await listItems(w.ctx('member'), { project: w.projectKey, limit: 3, cursor });
			for (const i of page.items) {
				expect(seen.has(i.id), `repeat ${i.ref}`).toBe(false);
				seen.add(i.id);
			}
			if (page.nextCursor === null) break;
			cursor = page.nextCursor;
		}
		const all = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(item).where(eq(item.projectId, w.projectId))
		);
		const visible = all.filter(
			(i) => !i.deletedAt && (i.visibility === 'public' || i.createdBy === w.people.member)
		);
		expect(seen.size).toBe(visible.length);
	});

	it.runIf(name === 'postgres')(
		'two recorders marking different steps at once both count',
		async () => {
			const made = await create('member', {
				phases: [{ key: '1', title: 'One', steps: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }],
				manualChecks: []
			});
			await Promise.all(
				['1.1', '1.2', '1.3'].map((key) =>
					recordSteps(w.ctx('member'), { item: made.ref, marks: [{ key, mark: 'done' }] })
				)
			);
			const d = await getItem(w.ctx('member'), made.ref);
			expect(d.item.doneSteps).toBe(3);
			expect(d.item.status).toBe('IN REVIEW');
			const history = await withTenant(db, { orgId: w.orgId }, (tx) =>
				tx.select().from(event).where(eq(event.itemId, made.id))
			);
			expect(history.filter((e) => e.verb === 'item.status')).toHaveLength(2);
		}
	);
});
