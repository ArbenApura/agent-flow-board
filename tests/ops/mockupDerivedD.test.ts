// PHASE D TESTS: DERIVED MOCKUP ASSETS, HOOK CITATION CHECKS, AND PROJECT LENS PACKS (AFB-20261113-1008)

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import {
	extractMockupDerived,
	extractMockupHooks,
	verifyDesignBriefHookCitations
} from '../../src/lib/server/mockups/derived';
import { createItem } from '../../src/lib/server/ops/items';
import { getMockupDerived, publishMockup } from '../../src/lib/server/ops/mockups';
import { setMockupKit } from '../../src/lib/server/ops/mockupSettings';
import { parseLensPack } from '../../src/lib/server/ops/planRules';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

const RICH_MOCKUP_HTML = `<!doctype html>
<html>
<head>
<!--afb-kit-->
<meta name="afb-config" content='{"screens":[["overview","Overview"],["detail","Detail"]],"options":[{"key":"mode","label":"Mode","values":[["light","Light"],["dark","Dark"]]}]}'>
<style>.card { background: var(--surface); color: var(--ink); }</style>
</head>
<body>
<header data-ref="top-bar">Overview Header</header>
<main data-screen="overview" id="main-content">
  <section data-ref="summary-card" role="region">Summary Metrics</section>
  <button data-testid="primary-cta">Save Changes</button>
</main>
</body>
</html>`;

describe('D.1-D.3 derived mockup assets & D.7 project lens packs', () => {
	let db: TestDb;
	let w: World;
	let store: ReturnType<typeof memoryStorage>;
	let services: { storage: ReturnType<typeof memoryStorage>; baseUrl: string };

	const as = (who: keyof World['people']) => ({
		...w.ctx(who),
		services
	});

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		store = memoryStorage();
		services = { storage: store, baseUrl: 'http://localhost:5180' };
		await setMockupKit(
			as('admin'),
			{ project: w.projectKey, builtFromCommit: 'd100001', summary: 'kit' },
			Buffer.from(
				'<!--afb-kit:start--><style>:root{--surface:#fff;--ink:#111;}</style><!--afb-kit:end-->',
				'utf8'
			)
		);
	}, 120_000);

	afterAll(() => db?.stop());

	it('extracts screens, semantic regions, visible strings, tokens, and hooks from mockup HTML', () => {
		const hooks = extractMockupHooks(RICH_MOCKUP_HTML);
		expect(hooks).toContain('data-ref=summary-card');
		expect(hooks).toContain('summary-card');
		expect(hooks).toContain('data-testid=primary-cta');

		const derived = extractMockupDerived(RICH_MOCKUP_HTML, 'deadbeef');
		expect(derived.outline.screens).toEqual([
			{ key: 'overview', label: 'Overview' },
			{ key: 'detail', label: 'Detail' }
		]);
		expect(derived.tokens).toContain('--surface');
		expect(derived.tokens).toContain('--ink');
		expect(derived.outline.strings).toContain('Summary Metrics');
		expect(derived.outline.strings).toContain('Save Changes');
		expect(derived.snapshot.screenCount).toBe(2);
		expect(derived.snapshot.hookCount).toBeGreaterThanOrEqual(4);
	});

	it('validates design-brief inventory hook citations against extracted mockup hooks', () => {
		const known = new Set(extractMockupHooks(RICH_MOCKUP_HTML));
		const validBrief = `### Mockup inventory
- Top header data-ref="top-bar" [built]
- Summary block hook: summary-card [built]`;
		expect(verifyDesignBriefHookCitations(validBrief, known, true)).toEqual({
			missingHooks: [],
			uncitedLines: []
		});

		const invalidBrief = `### Mockup inventory
- Unknown widget data-ref="ghost-panel" [built]
- Uncited row without hook attribute [built]`;
		const check = verifyDesignBriefHookCitations(invalidBrief, known, true);
		expect(check.missingHooks).toEqual(['data-ref=ghost-panel']);
		expect(check.uncitedLines).toHaveLength(1);
	});

	it('stores and serves derived mockup assets on publishMockup + getMockupDerived', async () => {
		const created = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Derived asset test'
		});
		const pub = await publishMockup(
			as('member'),
			{ project: w.projectKey, item: created.ref, title: 'Derived mockup' },
			Buffer.from(RICH_MOCKUP_HTML, 'utf8')
		);
		const fetched = await getMockupDerived(as('viewer'), pub.mockup.id);
		expect(fetched.version).toBe(1);
		expect(fetched.derived?.outline.screens.map((s) => s.key)).toEqual(['overview', 'detail']);
		expect(fetched.derived?.outline.hooks).toContain('summary-card');
	});

	it('parses mode-specific project lens packs cleanly', () => {
		const rules = [
			'critic-lens: code | Perf :: Check bundle size and query count',
			'critic-lens: mockup | Brand :: Check header height matches shell'
		].join('\n');
		const pack = parseLensPack(rules);
		expect(pack.source).toBe('project');
		expect(pack.lenses.map((l) => l.mode)).toEqual(['code', 'mockup']);
	});
});
