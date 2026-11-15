// THE WHO FILTER: LIST ITEMS BY THE PERSON WHO MADE THEM, WHO THEY ARE ASSIGNED TO AND WHO REVIEWS THEM, AND THE COUNTS BEHIND IT

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { projectSummary } from '../../src/lib/server/ops/board';
import { createItem, listItems, updateItem } from '../../src/lib/server/ops/items';
import { setStatus } from '../../src/lib/server/ops/status';
import { getHub } from '../../src/lib/server/realtime/hub';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

describe('the Who filter', () => {
	let db: TestDb;
	let w: World;
	let alpha: string;
	let beta: string;
	let gamma: string;
	let secret: string;
	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		// Alpha is the owner's, Beta and Gamma are the member's, and the member's private plan is hidden from the owner
		alpha = (
			await createItem(w.ctx('owner'), { project: w.projectKey, title: 'Alpha plan', ...PLAN })
		).ref;
		beta = (
			await createItem(w.ctx('member'), { project: w.projectKey, title: 'Beta plan', ...PLAN })
		).ref;
		gamma = (
			await createItem(w.ctx('member'), { project: w.projectKey, title: 'Gamma plan', ...PLAN })
		).ref;
		secret = (
			await createItem(w.ctx('member'), {
				project: w.projectKey,
				title: 'Secret plan',
				visibility: 'private',
				...PLAN
			})
		).ref;
		// Beta is assigned to the owner and waits for the owner's review, Gamma is assigned to the member
		await updateItem(w.ctx('owner'), {
			item: beta,
			assigneeId: w.people.owner,
			reviewerId: w.people.owner
		});
		await updateItem(w.ctx('member'), { item: gamma, assigneeId: w.people.member });
		await setStatus(w.ctx('owner'), { item: beta, status: 'IN REVIEW', note: 'Ready for review' });
	});
	afterAll(async () => {
		await (await getHub(db)).close();
		await db.stop();
	});

	const refs = async (who: keyof World['people'], filter: object) =>
		(await listItems(w.ctx(who), { project: w.projectKey, ...filter })).items
			.map((i) => i.ref)
			.sort();

	it('lists what the caller made, and what everyone else made, without a gap or an overlap', async () => {
		expect(await refs('owner', { by: 'me' })).toEqual([alpha]);
		// The member's private plan is not the owner's to see, so it is in neither list
		expect(await refs('owner', { by: 'others' })).toEqual([beta, gamma].sort());
		expect(await refs('member', { by: 'me' })).toEqual([beta, gamma, secret].sort());
		expect(await refs('member', { by: 'others' })).toEqual([alpha]);
	});

	it('lists what named people made, and ignores the same person named twice', async () => {
		const member = w.people.member;
		expect(await refs('owner', { by: member })).toEqual([beta, gamma].sort());
		expect(await refs('owner', { by: `${member},${member}` })).toEqual([beta, gamma].sort());
		expect(await refs('owner', { by: `${w.people.owner},${member}` })).toEqual(
			[alpha, beta, gamma].sort()
		);
		// A name nobody has made anything under gives an empty list, not an error
		expect(await refs('owner', { by: 'nobody-at-all' })).toEqual([]);
	});

	it('lists what is assigned to a person and what waits for their review', async () => {
		expect(await refs('owner', { assignee: 'me' })).toEqual([beta]);
		expect(await refs('member', { assignee: 'me' })).toEqual([gamma]);
		expect(await refs('owner', { assignee: w.people.member })).toEqual([gamma]);
		expect(await refs('owner', { reviewer: 'me' })).toEqual([beta]);
		// Only an item in review waits for a reviewer
		await setStatus(w.ctx('owner'), { item: beta, status: 'IN PROGRESS', note: 'Back to work' });
		expect(await refs('owner', { reviewer: 'me' })).toEqual([]);
		await setStatus(w.ctx('owner'), { item: beta, status: 'IN REVIEW', note: 'Ready for review' });
	});

	it('combines with the status, the search box and each other', async () => {
		expect(await refs('owner', { by: 'others', status: ['IN REVIEW'] })).toEqual([beta]);
		expect(await refs('owner', { by: 'others', q: 'gamma' })).toEqual([gamma]);
		expect(await refs('owner', { by: 'me', q: 'gamma' })).toEqual([]);
		expect(await refs('owner', { by: w.people.member, assignee: 'me' })).toEqual([beta]);
	});

	it('never shows a private plan of another person through a person filter', async () => {
		expect(await refs('owner', { by: w.people.member })).not.toContain(secret);
		expect(await refs('viewer', { by: w.people.member })).not.toContain(secret);
		expect(await refs('member', { by: w.people.member })).toContain(secret);
	});

	it('counts the same things for the filter popover, over what the caller may see', async () => {
		const owner = (await projectSummary(w.ctx('owner'), w.projectKey)).who;
		expect(owner).toMatchObject({
			me: w.people.owner,
			all: 3,
			mine: 1,
			others: 2,
			assigned: 1,
			review: 1
		});
		expect(owner.people).toEqual([{ userId: w.people.member, name: 'member', v: null, n: 2 }]);
		const member = (await projectSummary(w.ctx('member'), w.projectKey)).who;
		expect(member).toMatchObject({ all: 4, mine: 3, others: 1, assigned: 1, review: 0 });
		expect(member.people).toEqual([{ userId: w.people.owner, name: 'owner', v: null, n: 1 }]);
		// The counts and the lists agree
		expect((await listItems(w.ctx('owner'), { project: w.projectKey, by: 'others' })).total).toBe(
			owner.others
		);
	});
});
