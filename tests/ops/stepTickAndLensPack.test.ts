// AFTER THE VISUAL EVIDENCE GATE WAS REMOVED (AFB-20261114-1426): A STEP TICKS WITH NO PICTURE EVIDENCE, MOCKUP SCREEN EXTRACTION AND PROJECT LENS PACKS

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { createItem, getItem } from '../../src/lib/server/ops/items';
import { publishMockup, readMockupHtml } from '../../src/lib/server/ops/mockups';
import { setMockupKit } from '../../src/lib/server/ops/mockupSettings';
import { parseLensPack } from '../../src/lib/server/ops/planRules';
import { recordSteps } from '../../src/lib/server/ops/steps';
import { extractMockupScreensFromHtml } from '../../src/lib/shared/mockupScreens';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

const SIMPLE_HTML = `<!doctype html>
<html>
<head>
<!--afb-kit-->
<meta name="afb-config" content='{"screens":[["home","Home"],["settings","Settings"]],"options":[{"key":"mode","label":"Mode","values":[["light","Light"],["dark","Dark"]]}]}'>
</head>
<body><main data-screen="home" data-ref="hero">Hello</main></body>
</html>`;

const KIT_HTML = `<!--afb-kit:start-->
<style>:root { --surface: #fff; --ink: #111; }</style>
<!--afb-kit:end-->`;

describe('a step ticks by its own record, and the helpers that stayed', () => {
	let db: TestDb;
	let w: World;
	let store: ReturnType<typeof memoryStorage>;

	const as = (who: keyof World['people'], extra?: { kind?: 'person' | 'agent' }) => ({
		...w.ctx(who, extra),
		services: { storage: store, baseUrl: 'http://localhost:5180' }
	});

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		store = memoryStorage();
		await setMockupKit(
			as('admin'),
			{ project: w.projectKey, builtFromCommit: 'abc1234', summary: 'test kit' },
			Buffer.from(KIT_HTML, 'utf8')
		);
	}, 120_000);

	afterAll(() => db?.stop());

	it('lets an agent tick a screen step with no picture evidence, and keeps no visibility fields', async () => {
		const created = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Screen step with a linked mockup',
			phases: [
				{
					key: 'A',
					title: 'Build',
					steps: [
						{ key: 'A.1', text: 'Update board card', files: ['src/lib/board/ItemLine.svelte'] },
						{ key: 'A.2', text: 'Wire the Settings form' }
					]
				}
			]
		});
		const ref = created.item.ref;
		const pub = await publishMockup(
			as('member'),
			{ project: w.projectKey, item: ref, title: 'Screen mockup' },
			Buffer.from(SIMPLE_HTML, 'utf8')
		);
		await readMockupHtml(as('member'), pub.mockup.id);

		const done = await recordSteps(as('member', { kind: 'agent' }), {
			item: ref,
			marks: [{ key: 'A.1', mark: 'done' }]
		});
		expect(done.changed).toEqual([{ key: 'A.1', from: 'open', to: 'done' }]);

		const after = await getItem(as('member'), ref);
		const first = after.phases.flatMap((p) => p.steps).find((s) => s.key === 'A.1');
		expect(first?.state).toBe('done');
		expect(first).not.toHaveProperty('visible');
		expect(first).not.toHaveProperty('visibleInferred');
		expect(after.item.health.flags).not.toContain('unverified-visually');
		expect(after.item).not.toHaveProperty('sliceGate');
	});

	it('extracts the screens a mockup declares', () => {
		expect(extractMockupScreensFromHtml(SIMPLE_HTML)).toEqual([
			{ key: 'home', label: 'Home' },
			{ key: 'settings', label: 'Settings' }
		]);
	});

	it('parses custom project critic lens packs and falls back cleanly', () => {
		expect(parseLensPack('')).toEqual({ source: 'default', lenses: [] });
		const pack = parseLensPack(
			[
				'Regular project rule.',
				'- critic-lens: code | Accessibility :: Verify keyboard navigation and WCAG contrast',
				'critic-lens: plan | Tenancy :: Verify withTenant on every table',
				'critic-lens: code | accessibility :: duplicate ignored',
				'critic-lens: badmode | Invalid :: ignored'
			].join('\n')
		);
		expect(pack.source).toBe('project');
		expect(pack.lenses).toEqual([
			{
				mode: 'code',
				name: 'Accessibility',
				focus: 'Verify keyboard navigation and WCAG contrast'
			},
			{
				mode: 'plan',
				name: 'Tenancy',
				focus: 'Verify withTenant on every table'
			}
		]);
	});
});
