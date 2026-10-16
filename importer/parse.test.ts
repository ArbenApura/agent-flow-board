// THE PARSERS OF THE HAPR IMPORT, ON THE SHAPES THE REAL BOARD USES (SPEC 13)

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	parseDecisions,
	parseIdMap,
	parseLog,
	parsePlan,
	parseTasks,
	parseUiChanges
} from './parse';

// -- FUNCTIONS -- //

describe('the plan grammar', () => {
	const plan = parsePlan(
		[
			'# Plan',
			'## Phase 1 Build',
			'- [x] 1.1 Write it',
			'  - a note under a step',
			'- [ ] 1.2 Test it',
			'- [-] 1.3 Skipped',
			'  - Arben waived it',
			'## Phase 3b Later work',
			'- [~] 3b.1 Moved to FLOW-20261012-1000',
			'- [x] 4.5b A step with a letter',
			'## Phase P Prototype',
			'- [ ] P.0 Prototype',
			'## Manual checks (not counted)',
			'- [ ] M1 [auto] It opens',
			'- [-] M2 Arben looks',
			'## As built',
			'- [x] this checkbox sits outside a phase and is not a step'
		].join('\n')
	);
	it('reads phases, steps, their states and their notes', () => {
		expect(plan.phases.map((p) => p.key)).toEqual(['1', '3b', 'P']);
		const steps = plan.phases.flatMap((p) => p.steps);
		expect(steps.map((s) => [s.key, s.state])).toEqual([
			['1.1', 'done'],
			['1.2', 'open'],
			['1.3', 'waived'],
			['3b.1', 'superseded'],
			['4.5b', 'done'],
			['P.0', 'open']
		]);
		expect(steps[0].notes).toEqual(['a note under a step']);
		expect(steps[2].notes).toEqual(['Arben waived it']);
	});
	it('reads manual checks with their auto tag removed from the text', () => {
		expect(plan.checks.map((c) => [c.key, c.auto, c.state, c.text])).toEqual([
			['M1', true, 'open', 'It opens'],
			['M2', false, 'waived', 'Arben looks']
		]);
	});
	it('lists a checklist line that is outside the grammar and counts nothing for it', () => {
		expect(plan.unplaced).toEqual(['- [x] this checkbox sits outside a phase and is not a step']);
	});
});

describe('decisions', () => {
	const text = [
		'# Decisions',
		'## ADR-001 Bullet style',
		'- **Context.** Why.',
		'- **Decision.** What.',
		'- **Alternatives.** Else.',
		'- **Consequences.** So.',
		'### ADR-002: Heading style',
		'#### Context',
		'Why two.',
		'#### Decision',
		'What two.',
		'#### Trade-offs',
		'Costs two.',
		'## ADR-3 Loose text',
		'Some words with no fields.',
		'## Settled without asking',
		'| Question | Answer | Source |',
		'|---|---|---|',
		'| Q one? | A one | SPEC 1 |',
		'| Q two? | A two | a \\| b |',
		'## Something else',
		'text after'
	].join('\n');
	const d = parseDecisions(text);
	it('reads both field styles and text with no fields', () => {
		expect(d.adrs.map((a) => [a.number, a.title])).toEqual([
			[1, 'Bullet style'],
			[2, 'Heading style'],
			[3, 'Loose text']
		]);
		expect(d.adrs[0]).toMatchObject({
			context: 'Why.',
			decision: 'What.',
			alternatives: 'Else.',
			consequences: 'So.'
		});
		expect(d.adrs[1]).toMatchObject({
			context: 'Why two.',
			decision: 'What two.',
			consequences: 'Costs two.'
		});
		expect(d.adrs[2].decision).toBe('Some words with no fields.');
	});
	it('reads the settled table, including an escaped bar, and stops at the next heading', () => {
		expect(d.settled).toEqual([
			{ number: 1, question: 'Q one?', answer: 'A one', source: 'SPEC 1' },
			{ number: 2, question: 'Q two?', answer: 'A two', source: 'a | b' }
		]);
		expect(d.adrs.some((a) => a.raw.includes('text after'))).toBe(false);
	});
	it('finds nothing in a file with no ADR headings, so the whole text can be kept', () => {
		expect(parseDecisions('Just prose, no headings.')).toMatchObject({ adrs: [], settled: [] });
	});
});

describe('the log', () => {
	it('keeps the date, the time and the text of each dated line, and ignores the rest', () => {
		const log = parseLog(
			'# Log\nAppend-only.\n- 2026-10-16 01:31, 11.1 done, 11.2 done. Phase built.\n- 2026-10-15 09:00: no comma after\n- 2026-10-14, only a date\nnot a line\n'
		);
		expect(log.map((l) => [l.at, l.text])).toEqual([
			['2026-10-16T01:31:00+08:00', '11.1 done, 11.2 done. Phase built.'],
			['2026-10-15T09:00:00+08:00', 'no comma after'],
			['2026-10-14T00:00:00+08:00', 'only a date']
		]);
	});
});

describe('the UI changes table', () => {
	const t = parseUiChanges(
		[
			'### UI changes',
			'| Page | State | Brands | Accounts | Siblings | Levels | Viewports |',
			'|---|---|---|---|---|---|---|',
			'| `/a`, `/b` | none, `click:text=Open` | both | default | `/x`, `design/screens.html` (a mockup) | title, section | 1440, 390 |',
			'| `/hub/{event}/rooms` | none | hapr | hapr=iso@example.com | `/x` | body | 1440 |',
			'',
			'| Date | Who | What |'
		].join('\n'),
		['hapr', 'gameplan']
	);
	it('makes one row for each page and state, and expands both to every theme', () => {
		expect(t.tableRows).toBe(2);
		expect(t.rows).toHaveLength(5);
		expect(t.rows[0]).toMatchObject({
			page: '/a',
			stateRecipe: '',
			themes: ['hapr', 'gameplan'],
			viewports: [1440, 390]
		});
		expect(t.rows[1]).toMatchObject({ page: '/a', stateRecipe: 'click:text=Open' });
		expect(t.rows[4]).toMatchObject({
			page: '/hub/{event}/rooms',
			themes: ['hapr'],
			accounts: 'hapr=iso@example.com'
		});
		expect(t.rows[0].siblings).toEqual(['/x', 'design/screens.html']);
	});
	it('reads the table that names its themes column Themes, and finds none in a file without the table', () => {
		const alt = parseUiChanges(
			'| Page | State | Themes | Accounts | Siblings | Levels | Viewports |\n|---|---|---|---|---|---|---|\n| `/p` | none | light | none | `/q` | title | 390 |',
			['light', 'dark']
		);
		expect(alt.rows[0]).toMatchObject({ themes: ['light'], accounts: 'none', viewports: [390] });
		expect(parseUiChanges('# nothing here', ['a'])).toEqual({ rows: [], tableRows: 0 });
	});
});

describe('tasks and the ID map', () => {
	it('reads the tasks with their group, status, links and notes', () => {
		const tasks = parseTasks(
			'# T\n\n## Billing\n\n### T-01 First\n- **Task:** Do it.\n- **Status:** `DONE`\n- **Priority:** -\n- **Links:** FLOW-20261001-0950 x\n- **Notes:** n\n- **Updated:** 2026-10-07\n\n## Later\n\n### T-02 Second\n- **Task:** t\n- **Status:** `FUTURE`\n'
		);
		expect(tasks.map((t) => [t.number, t.title, t.group, t.status])).toEqual([
			[1, 'First', 'Billing', 'DONE'],
			[2, 'Second', 'Later', 'FUTURE']
		]);
		expect(tasks[0]).toMatchObject({
			links: 'FLOW-20261001-0950 x',
			notes: 'n',
			updated: '2026-10-07'
		});
	});
	it('reads the legacy to FLOW rows of the ID map', () => {
		expect(
			parseIdMap(
				'| `FEAT-003` | `FLOW-20260921-1405` | `20260921T14:05` | `sourcing-requirements-refactor (removed)` |\n| header | x |'
			)
		).toEqual([
			{
				legacy: 'FEAT-003',
				flow: 'FLOW-20260921-1405',
				name: 'sourcing-requirements-refactor (removed)'
			}
		]);
	});
});
