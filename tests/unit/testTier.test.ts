// HOW MUCH TESTING A PLAN GETS (AFB-20261127-0438): THE TIER AND THE RE-RUN PICK

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { RERUN_CAP, inAreas, pickRerun, planTier } from '../../src/lib/shared/testTier';

// -- FUNCTIONS -- //

describe('planTier', () => {
	it('gives docs, skill text and config no run', () => {
		expect(planTier({ steps: 2, files: ['README.md', 'docs/a.md'], visible: false })).toBe('none');
		expect(
			planTier({
				steps: 1,
				files: ['src/lib/server/system-skills/skills/flow/SKILL.md'],
				visible: false
			})
		).toBe('none');
		expect(planTier({ steps: 1, files: ['.github/workflows/ci.yml'], visible: false })).toBe(
			'none'
		);
	});
	it('covers a small tweak to an approved screen with its Screens capture', () => {
		expect(
			planTier({ steps: 1, files: ['src/lib/ui/Button.svelte'], visible: true, tweak: true })
		).toBe('screens-only');
	});
	it('runs a small fix on its own cases, a normal plan with a re-run, and server or auth code deep', () => {
		expect(planTier({ steps: 2, files: ['src/lib/board/a.ts'], visible: false })).toBe('lite');
		expect(
			planTier({ steps: 6, files: ['src/lib/board/a.ts', 'src/lib/board/b.svelte'], visible: true })
		).toBe('normal');
		expect(
			planTier({ steps: 2, files: ['src/lib/server/db/migrations/0063_x.sql'], visible: false })
		).toBe('deep');
		expect(planTier({ steps: 2, files: ['src/lib/server/auth/x.ts'], visible: false })).toBe(
			'deep'
		);
		expect(
			planTier({
				steps: 4,
				files: Array.from({ length: 16 }, (_, i) => `src/a${i}.ts`),
				visible: false
			})
		).toBe('deep');
	});
});

describe('pickRerun', () => {
	const c = (
		key: string,
		area: string,
		priority: 'high' | 'normal' | 'low',
		lastRunAt: string | null
	) => ({
		key,
		area,
		priority,
		lastRunAt
	});
	it('matches an area and the areas inside it', () => {
		expect(inAreas('apps/centers/queue', ['apps/centers'])).toBe(true);
		expect(inAreas('apps/centers', ['apps/centers/queue'])).toBe(false);
		expect(inAreas('AUTH', ['auth'])).toBe(true);
	});
	it('re-runs nothing for lite and lower', () => {
		const cands = [c('TC-A-01', 'A', 'high', null)];
		for (const t of ['none', 'screens-only', 'lite'] as const)
			expect(pickRerun(cands, ['A'], t)).toEqual({ run: [], owed: [] });
	});
	it('picks High priority cases of the touched areas, never run first, then the oldest, up to the cap, and owes the rest', () => {
		const cands = [
			...Array.from({ length: 10 }, (_, i) =>
				c(
					`TC-A-${String(i + 1).padStart(2, '0')}`,
					'apps/a',
					'high',
					`2026-11-${String(10 + i).padStart(2, '0')}T00:00:00Z`
				)
			),
			c('TC-A-99', 'apps/a', 'high', null),
			c('TC-A-50', 'apps/a', 'normal', null),
			c('TC-B-01', 'apps/b', 'high', null)
		];
		const got = pickRerun(cands, ['apps/a'], 'normal');
		expect(got.run).toHaveLength(RERUN_CAP);
		expect(got.run[0]).toBe('TC-A-99');
		expect(got.run[1]).toBe('TC-A-01');
		expect(got.owed).toEqual(['TC-A-08', 'TC-A-09', 'TC-A-10']);
		expect([...got.run, ...got.owed]).not.toContain('TC-A-50');
		expect([...got.run, ...got.owed]).not.toContain('TC-B-01');
	});
	it('re-runs every case of the touched areas for a deep plan', () => {
		const cands = [
			c('TC-A-01', 'A', 'low', null),
			c('TC-A-02', 'A', 'high', null),
			c('TC-B-01', 'B', 'high', null)
		];
		expect(pickRerun(cands, ['A'], 'deep')).toEqual({ run: ['TC-A-01', 'TC-A-02'], owed: [] });
	});
});
