// A MASTER PLAN'S STATUS CARRIES TO ITS CHILD PLANS (AFB-20261125-0906): COMPLETED, ON HOLD, IN REVIEW, RESUME, SKIPS AND AGENTS

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { createItem, trashItem } from '../../src/lib/server/ops/items';
import { setStatus } from '../../src/lib/server/ops/status';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, PLAN, type World } from '../support/ops';

// -- FUNCTIONS -- //

describe('master status cascade', () => {
	let db: TestDb;
	let w: World;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		// These plans predate Testing, so the testing rules of COMPLETED (tests/ops/testingStatus.test.ts) stay out of the way
		await db.admin.exec(`update project set testing_since = now() + interval '100 years'`);
	}, 120_000);
	afterAll(() => db?.stop());

	const owner = () => w.ctx('owner');
	const agent = () => w.ctx('owner', { kind: 'agent' });
	// A reference is the key and the UTC minute, so every plan of this file gets a minute of its own (after the Screens rule date)
	let minute = 0;
	const nextMinute = () => new Date(Date.UTC(2026, 10, 26, 0, 0) + ++minute * 60_000);
	const make = (title: string, parent?: string, extra: object = {}) =>
		createItem(owner(), { project: w.projectKey, title, parent, ...extra }, { now: nextMinute() });
	const statusOf = async (id: string) =>
		(await db.admin.query<{ s: string }>(`select status as s from item where id = '${id}'`))[0].s;
	const force = (id: string, status: string) =>
		db.admin.exec(`update item set status = '${status}' where id = '${id}'`);

	it('completes the open children with the master and leaves a completed one alone', async () => {
		const master = await make('Complete master');
		const planned = await make('Planned child', master.ref);
		const going = await make('Going child', master.ref);
		const held = await make('Held child', master.ref);
		const done = await make('Done child', master.ref);
		await force(going.id, 'IN PROGRESS');
		await force(held.id, 'ON HOLD');
		await force(done.id, 'COMPLETED');
		const res = await setStatus(owner(), {
			item: master.ref,
			status: 'COMPLETED',
			note: 'Closed at the board'
		});
		expect(res.followed.map((f) => f.ref).sort()).toEqual(
			[planned.ref, going.ref, held.ref].sort()
		);
		for (const k of [planned, going, held, done]) expect(await statusOf(k.id)).toBe('COMPLETED');
		const [ev] = await db.admin.query<{ note: string }>(
			`select after->>'note' as note from event where item_id = '${planned.id}' and verb = 'item.status' order by id desc limit 1`
		);
		expect(ev.note).toBe(`Followed master ${master.ref}`);
	});

	it('holds the open children with the master and resumes only the ones it held', async () => {
		const master = await make('Hold master');
		const going = await make('Going child', master.ref);
		const own = await make('Own hold child', master.ref);
		await force(going.id, 'IN PROGRESS');
		await force(own.id, 'ON HOLD');
		const held = await setStatus(owner(), { item: master.ref, status: 'ON HOLD', note: 'Paused' });
		expect(held.followed.map((f) => f.ref)).toEqual([going.ref]);
		expect(await statusOf(going.id)).toBe('ON HOLD');
		const back = await setStatus(owner(), {
			item: master.ref,
			status: 'IN PROGRESS',
			note: 'Resumed'
		});
		// The held child returns to the status it had, the one held on its own stays on hold
		expect(back.followed.map((f) => [f.ref, f.to])).toEqual([[going.ref, 'IN PROGRESS']]);
		expect(await statusOf(going.id)).toBe('IN PROGRESS');
		expect(await statusOf(own.id)).toBe('ON HOLD');
	});

	it('moves to review only the in progress children whose counted steps are all done', async () => {
		const master = await make('Review master');
		const ready = await make('Ready child', master.ref, PLAN);
		const open = await make('Open child', master.ref, PLAN);
		await force(ready.id, 'IN PROGRESS');
		await force(open.id, 'IN PROGRESS');
		await db.admin.exec(`update step set state = 'done' where item_id = '${ready.id}'`);
		const res = await setStatus(owner(), {
			item: master.ref,
			status: 'IN REVIEW',
			note: 'In review'
		});
		expect(res.followed.map((f) => f.ref)).toEqual([ready.ref]);
		expect(await statusOf(ready.id)).toBe('IN REVIEW');
		expect(await statusOf(open.id)).toBe('IN PROGRESS');
	});

	it('skips a trashed child and catches up a child added after the master closed', async () => {
		const master = await make('Catch up master');
		const trashed = await make('Trashed child', master.ref);
		await trashItem(owner(), trashed.ref);
		const first = await setStatus(owner(), {
			item: master.ref,
			status: 'COMPLETED',
			note: 'Closed at the board'
		});
		expect(first.followed).toEqual([]);
		expect(await statusOf(trashed.id)).toBe('PLANNED');
		const late = await make('Late child', master.ref);
		const again = await setStatus(owner(), {
			item: master.ref,
			status: 'COMPLETED',
			note: 'Closed at the board'
		});
		expect(again.already).toBe(true);
		expect(again.followed.map((f) => f.ref)).toEqual([late.ref]);
		expect(await statusOf(late.id)).toBe('COMPLETED');
	});

	it('leaves a private child of someone else alone and never names it', async () => {
		const master = await make('Private child master');
		const hidden = await createItem(
			w.ctx('member'),
			{ project: w.projectKey, title: 'Private child', parent: master.ref, visibility: 'private' },
			{ now: nextMinute() }
		);
		const res = await setStatus(owner(), {
			item: master.ref,
			status: 'COMPLETED',
			note: 'Closed at the board'
		});
		expect(res.followed).toEqual([]);
		expect(res.skipped).toEqual([]);
		expect(await statusOf(hidden.id)).toBe('PLANNED');
	});

	it('does not carry a child plan own change to its master', async () => {
		const master = await make('Quiet master');
		const kid = await make('Quiet child', master.ref);
		await setStatus(owner(), { item: kid.ref, status: 'ON HOLD', note: 'Paused' });
		expect(await statusOf(master.id)).toBe('PLANNED');
	});

	it('makes an agent confirm the children it closes and skips a child with no screens', async () => {
		const master = await make('Agent master');
		const plain = await make('Plain child', master.ref);
		const visible = await make('Visible child', master.ref, {
			sections: [{ slug: 'design-brief', title: 'Design brief', body: 'A screen changes.' }]
		});
		// The master itself needs the agent's own confirmation first, then the children are listed
		const asked = await setStatus(agent(), {
			item: master.ref,
			status: 'COMPLETED',
			note: 'Closing the master',
			confirmed: false
		}).catch((e) => e);
		expect(asked).toMatchObject({ code: 'CONFIRM_REQUIRED' });
		const res = await setStatus(agent(), {
			item: master.ref,
			status: 'COMPLETED',
			note: 'Closing the master',
			confirmed: true
		});
		expect(res.followed.map((f) => f.ref)).toEqual([plain.ref]);
		expect(res.skipped).toEqual([{ ref: visible.ref, reason: 'screens-missing' }]);
		expect(await statusOf(plain.id)).toBe('COMPLETED');
		expect(await statusOf(visible.id)).toBe('PLANNED');
	});

	it('lets a person close a visible plan with no screens, and refuses an agent', async () => {
		const p = await make('Hand closed plan', undefined, {
			sections: [{ slug: 'design-brief', title: 'Design brief', body: 'A screen changes.' }]
		});
		await expect(
			setStatus(agent(), {
				item: p.ref,
				status: 'COMPLETED',
				note: 'Done',
				confirmed: true
			})
		).rejects.toMatchObject({ code: 'COMPLETED_REFUSED', details: { reason: 'screens-missing' } });
		const closed = await setStatus(owner(), { item: p.ref, status: 'COMPLETED', note: 'Done' });
		expect(closed.item.status).toBe('COMPLETED');
	});
});
