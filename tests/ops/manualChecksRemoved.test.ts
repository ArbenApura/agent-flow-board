// MANUAL CHECKS ARE GONE (AFB-20261115-0119): AN M MARK IS REFUSED, THE OLD INPUT IS IGNORED WITH A NOTICE, A BROWSER CHECK NEEDS NO MANUAL CHECK AND GETS ITS OWN C KEY

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { itemChecks, saveCheck } from '../../src/lib/server/ops/checks';
import { createItem, getItem } from '../../src/lib/server/ops/items';
import { addManualChecks } from '../../src/lib/server/ops/plan';
import { recordSteps } from '../../src/lib/server/ops/steps';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

describe('manual checks are removed', () => {
	let db: TestDb;
	let w: World;
	let n = 0;
	const newItem = (extra: Record<string, unknown> = {}) =>
		createItem(w.ctx('member'), {
			project: w.projectKey,
			title: `No manual checks ${++n}`,
			phases: PLAN.phases,
			...extra
		});

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		await db.admin.exec(`update project set web_app = true where id = '${w.projectId}'`);
	}, 240_000);
	afterAll(() => db?.stop());

	it('refuses a step mark with an M key, names the key and records nothing', async () => {
		const made = await newItem();
		await expect(
			recordSteps(w.ctx('member'), {
				item: made.ref,
				marks: [
					{ key: '1.1', mark: 'done' },
					{ key: 'M1', mark: 'done' }
				]
			})
		).rejects.toMatchObject({
			code: 'INVALID',
			message: expect.stringMatching(/M1.*Nothing was recorded/s)
		});
		const d = await getItem(w.ctx('member'), made.ref);
		expect(d.phases[0].steps[0].state).toBe('open');
	});

	it('ignores manualChecks on a new item and says so, and writes nothing for the retired add call', async () => {
		const made = await newItem({ manualChecks: [{ key: 'M1', text: 'By hand' }] });
		expect(made.notice).toMatch(/no longer exist/i);
		const d = await getItem(w.ctx('member'), made.ref);
		expect('manualChecks' in d).toBe(false);
		expect(d.checks).toEqual([]);
		const retired = await addManualChecks(w.ctx('member'), {
			item: made.ref,
			checks: [{ key: 'M1', text: 'again' }]
		});
		expect(retired.keys).toEqual([]);
		expect(retired.notice).toMatch(/check_save/);
	});

	it('saves a browser check with no manual check, picks C1 then C2, keeps the title, and two saves at once get two keys', async () => {
		const made = await newItem();
		const ctx = w.ctx('member');
		const first = await saveCheck(ctx, {
			item: made.ref,
			script: 'await page.goto("/")',
			title: 'The home page opens'
		});
		expect(first).toMatchObject({ key: 'C1', created: true });
		const both = await Promise.all([
			saveCheck(ctx, { item: made.ref, script: 'await page.goto("/a")' }),
			saveCheck(ctx, { item: made.ref, script: 'await page.goto("/b")' })
		]);
		expect(both.map((b) => b.key).sort()).toEqual(['C2', 'C3']);
		// A key the caller names is used as given, and an old M key is still a valid check key
		expect(
			await saveCheck(ctx, { item: made.ref, key: 'M1', script: 'await page.goto("/old")' })
		).toMatchObject({ key: 'M1', created: true });
		const view = await itemChecks(ctx, made.ref);
		expect(view.checks.map((c) => c.key)).toEqual(['C1', 'C2', 'C3', 'M1']);
		expect(view.checks[0].title).toBe('The home page opens');
		// Saving again keeps the title when the call names none
		await saveCheck(ctx, { item: made.ref, key: 'C1', script: 'await page.goto("/")' });
		expect((await itemChecks(ctx, made.ref)).checks[0].title).toBe('The home page opens');
	});

	it('an item with every step done is ready for sign-off with no manual check to close', async () => {
		const made = await newItem();
		await recordSteps(w.ctx('member'), {
			item: made.ref,
			marks: ['1.1', '1.2', '2.1', '2.2'].map((key) => ({ key, mark: 'done' as const }))
		});
		const d = await getItem(w.ctx('member'), made.ref);
		expect(d.item.status).toBe('IN REVIEW');
		expect(d.item.health.drift).toContain('ready-for-sign-off');
	});
});
