// PHASE C.1 & D.7 TESTS: VISUAL STEP INFERENCE, SHARED PROGRESS, HEALTH FLAGS & PROJECT LENS PACKS (AFB-20261113-1008)

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { createItem, getItem } from '../../src/lib/server/ops/items';
import { publishMockup, readMockupHtml } from '../../src/lib/server/ops/mockups';
import { setMockupKit } from '../../src/lib/server/ops/mockupSettings';
import { addSteps } from '../../src/lib/server/ops/plan';
import { parseLensPack } from '../../src/lib/server/ops/planRules';
import { updateProject } from '../../src/lib/server/ops/projects';
import { recordSteps } from '../../src/lib/server/ops/steps';
import { computeVisualProgress, findUnverifiedBuiltClaims } from '../../src/lib/shared/progress';
import {
	anyFileMatchesScreenGlobs,
	effectiveStepVisible,
	extractMockupScreensFromHtml,
	matchesScreenGlob,
	normaliseGlobPath,
	stepTextNamesScreen
} from '../../src/lib/shared/screenGlobs';
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

describe('C.1 visual step helpers, progress, health & D.7 lens pack', () => {
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

	it('matches screen globs, normalises Windows backslashes, and extracts mockup screens', () => {
		expect(normaliseGlobPath('src\\routes\\+page.svelte')).toBe('src/routes/+page.svelte');
		expect(matchesScreenGlob('src\\routes\\[org]\\settings\\+page.svelte', 'src/routes/**')).toBe(
			true
		);
		expect(matchesScreenGlob('src/lib/ui/Modal.svelte', 'src/lib/ui/**')).toBe(true);
		expect(matchesScreenGlob('src/lib/server/ops/items.ts', 'src/lib/ui/**')).toBe(false);
		expect(
			anyFileMatchesScreenGlobs(
				['src/lib/server/ops/items.ts', 'src/lib/board/PlanTab.svelte'],
				['src/lib/board/**']
			)
		).toBe(true);
		expect(effectiveStepVisible({ visible: false, visibleInferred: true })).toBe(false);
		expect(effectiveStepVisible({ visible: null, visibleInferred: true })).toBe(true);

		const screens = extractMockupScreensFromHtml(SIMPLE_HTML);
		expect(screens).toEqual([
			{ key: 'home', label: 'Home' },
			{ key: 'settings', label: 'Settings' }
		]);
		expect(stepTextNamesScreen('Build Settings panel with controls', screens)).toBe(true);
		expect(stepTextNamesScreen('Add database index on token hash', screens)).toBe(false);
	});

	it('computes dual written/verified percentages and detects unverified built claims', () => {
		const legacy = computeVisualProgress([
			{ state: 'done', visible: null, visibleInferred: false, evidence: null },
			{ state: 'open', visible: null, visibleInferred: false, evidence: null }
		]);
		expect(legacy.writtenPercent).toBe(50);
		expect(legacy.verifiedPercent).toBeNull();
		expect(legacy.unverifiedVisually).toBe(false);

		const unverified = computeVisualProgress([
			{ state: 'done', visible: true, visibleInferred: false, evidence: null },
			{ state: 'done', visible: false, visibleInferred: false, evidence: null }
		]);
		expect(unverified.writtenPercent).toBe(100);
		expect(unverified.verifiedPercent).toBe(0);
		expect(unverified.unverifiedVisually).toBe(true);

		const verified = computeVisualProgress([
			{
				state: 'done',
				visible: true,
				visibleInferred: false,
				evidence: { checkRunId: '00000000-0000-4000-8000-000000000001' }
			},
			{ state: 'done', visible: false, visibleInferred: false, evidence: null }
		]);
		expect(verified.verifiedPercent).toBe(100);
		expect(verified.unverifiedVisually).toBe(false);

		expect(
			findUnverifiedBuiltClaims('### Mockup inventory\n- [built] hero', {
				files: [],
				runIds: [],
				hasDiff: false
			})
		).toHaveLength(1);
		expect(
			findUnverifiedBuiltClaims('### Mockup inventory\n- [built] hero.svelte (diff)', {
				files: ['hero.svelte'],
				runIds: [],
				hasDiff: true
			})
		).toEqual([]);
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

	it('updates visualEvidenceGate/screenGlobs, infers step visibility, and surfaces unverified-visually health flag', async () => {
		await updateProject(as('owner'), {
			project: w.projectKey,
			screenGlobs: ['src/routes/**', 'src/lib/board/**'],
			visualEvidenceGate: false
		});

		const created = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Visible step inference item',
			phases: [
				{
					key: 'A',
					title: 'Build',
					steps: [
						{ key: 'A.1', text: 'Update server helper', files: ['src/lib/server/ops/foo.ts'] },
						{ key: 'A.2', text: 'Update board card', files: ['src/lib/board/ItemLine.svelte'] },
						{
							key: 'A.3',
							text: 'Explicit non-visual route config',
							files: ['src/routes/healthz/+server.ts'],
							visible: false
						}
					]
				}
			]
		});
		const ref = created.item.ref;

		// Before linking a mockup, globs stay latent until a mockup is linked
		const pub = await publishMockup(
			as('member'),
			{ project: w.projectKey, item: ref, title: 'Screen mockup' },
			Buffer.from(SIMPLE_HTML, 'utf8')
		);
		await readMockupHtml(as('member'), pub.mockup.id);

		// Add another step mentioning a declared mockup screen name
		await addSteps(as('member'), {
			item: ref,
			phase: 'A',
			steps: [{ key: 'A.4', text: 'Wire Settings form handlers' }]
		});

		const detailBeforeDone = await getItem(as('member'), ref);
		const stepMap = new Map(detailBeforeDone.phases.flatMap((p) => p.steps).map((s) => [s.key, s]));
		expect(stepMap.get('A.1')?.visibleInferred).toBe(false);
		expect(stepMap.get('A.2')?.visibleInferred).toBe(true);
		// Explicit visible=false overrides inference
		expect(stepMap.get('A.3')?.visible).toBe(false);
		expect(stepMap.get('A.4')?.visibleInferred).toBe(true);

		// With gate off, ticking visible steps marks them done without compare evidence,
		// triggering unverified-visually health flag + verifiedPercent 0.
		await recordSteps(as('member'), {
			item: ref,
			marks: [
				{ key: 'A.1', mark: 'done' },
				{ key: 'A.2', mark: 'done' }
			]
		});
		const afterTick = await getItem(as('member'), ref);
		expect(afterTick.item.health.flags).toContain('unverified-visually');
		expect(afterTick.item.health.verifiedPercent).toBe(0);
		expect(afterTick.item.health.visibleTotal).toBe(2);
		expect(afterTick.item.health.visibleVerified).toBe(0);
	});
});
