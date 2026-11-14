// THE PLAN RULES A PROJECT WRITES IN ITS RULES TEXT: PARSED, AND ENFORCED WHEN A PLAN IS WRITTEN

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { createItem } from '../../src/lib/server/ops/items';
import { addManualChecks, addPhase, addSteps, updateStep } from '../../src/lib/server/ops/plan';
import { parsePlanRules, planViolations } from '../../src/lib/server/ops/planRules';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const RULES = [
	'Plain project rules text stays as it is.',
	'forbid-plan: mockup|UI changes table :: this project has no mockups or UI changes tables',
	'forbid-plan: feat/demo',
	'forbid-plan: (a+)+$ :: a pattern with nested repeats is only a phrase',
	'no-browser-steps'
].join('\n');

describe('parsePlanRules and planViolations', () => {
	it('reads forbid lines as phrases and the browser switch, and names each reason once', () => {
		const rules = parsePlanRules(RULES);
		expect(rules.noBrowserSteps).toBe(true);
		expect(rules.forbid).toHaveLength(3);
		expect(planViolations(rules, { texts: ['Draw a clickable Mockup'], browser: false })).toEqual([
			'this project has no mockups or UI changes tables'
		]);
		expect(planViolations(rules, { texts: ['Push to feat/demo'], browser: false })).toEqual([
			'plans may not mention feat/demo'
		]);
		expect(planViolations(rules, { texts: ['fine'], browser: true })).toHaveLength(1);
		expect(planViolations(rules, { texts: ['fine'], browser: false })).toEqual([]);
		expect(planViolations(parsePlanRules(''), { texts: ['mockup'], browser: true })).toEqual([]);
		// A pattern that would backtrack for ever as an expression is a literal phrase here and answers at once
		const started = Date.now();
		expect(planViolations(rules, { texts: [`${'a'.repeat(5000)}x`], browser: false })).toEqual([]);
		expect(Date.now() - started).toBeLessThan(200);
	});
});

describe('plan rules in the operations', () => {
	let db: TestDb;
	let w: World;
	const person = () => w.ctx('member');

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		await db.admin.query('UPDATE project SET rules = $1 WHERE id = $2', [RULES, w.projectId]);
	}, 240_000);
	afterAll(() => db?.stop());

	it('refuses a new plan, new steps, a new phase, a new check and a reworded step that break the rules', async () => {
		const base = { project: w.projectKey, title: 'Plan rules item' };
		await expect(
			createItem(person(), {
				...base,
				phases: [{ key: '1', title: 'Build', steps: [{ text: 'Make a clickable mockup' }] }]
			})
		).rejects.toThrow(/no mockups/);
		await expect(
			createItem(person(), {
				...base,
				phases: [
					{ key: '1', title: 'Build', steps: [{ text: 'Open it', requiredTarget: 'preview' }] }
				]
			})
		).rejects.toThrow(/browser steps/);

		const made = await createItem(person(), {
			...base,
			phases: [{ key: '1', title: 'Build', steps: [{ text: 'Write the code' }] }],
			manualChecks: [{ key: 'M1', text: 'Look at it by hand' }]
		});
		await expect(
			addSteps(person(), {
				item: made.ref,
				phase: '1',
				steps: [{ text: 'Create the UI changes table' }]
			})
		).rejects.toThrow(/no mockups/);
		await expect(
			addPhase(person(), {
				item: made.ref,
				key: '2',
				title: 'Release',
				steps: [{ text: 'Merge to feat/demo' }]
			})
		).rejects.toThrow(/feat\/demo/);
		await expect(
			addManualChecks(person(), {
				item: made.ref,
				checks: [{ key: 'M2', text: 'Runs by itself', auto: true }]
			})
		).rejects.toThrow(/browser steps/);
		await expect(
			updateStep(person(), { item: made.ref, key: '1.1', text: 'Draw the mockup' })
		).rejects.toThrow(/no mockups/);

		// Text that breaks no rule still goes through
		await expect(
			addSteps(person(), { item: made.ref, phase: '1', steps: [{ text: 'Write the tests' }] })
		).resolves.toMatchObject({ keys: ['1.2'] });
	});
});
