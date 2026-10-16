// THE UI SHOTS RULES: THE TABLE, ITS VALIDATION, THE FLAGS AND THE SCALE BUILT FROM MEASURED PAGES (SPEC 10.1)

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { UI_LEVELS } from '../../src/lib/shared/uiChange';
import {
	DEFAULT_LOCATORS,
	LEVEL_PROPS,
	buildScale,
	flagsFor,
	flagsForPage,
	isAppRoute,
	locatorFor,
	parseUiChangesTable,
	shotFileName,
	validateUiChange,
	type UiChangeRow
} from '../../src/lib/shared/uiShots';

// -- CONSTANTS -- //

const TABLE = `
| Page | State | Themes | Accounts | Siblings | Levels | Viewports |
|---|---|---|---|---|---|---|
| \`/sign-in\`, \`/sign-up\` | none, \`click:text=Tab\` > \`wait:.x\` | both | none | \`/\` , \`design/screens.html\` (x) | title, button-primary=css:.a b | 1440, 390 |
`;
const ROW: UiChangeRow = {
	page: '/a',
	stateRecipe: '',
	themes: ['light'],
	accounts: 'default',
	siblings: ['/b'],
	levels: ['title'],
	viewports: [1440]
};

// -- FUNCTIONS -- //

describe('the UI changes table', () => {
	it('splits a row into one row for each page and state, and reads themes and siblings', () => {
		const rows = parseUiChangesTable(TABLE, { lenient: true });
		expect(rows).toHaveLength(4);
		expect(rows.map((r) => `${r.page}|${r.stateRecipe}`)).toEqual([
			'/sign-in|',
			'/sign-in|click:text=Tab > wait:.x',
			'/sign-up|',
			'/sign-up|click:text=Tab > wait:.x'
		]);
		expect(rows[0].themes).toEqual(['light', 'dark']);
		expect(rows[0].viewports).toEqual([1440, 390]);
		// A lenient read keeps the mockup file this repo's own table names beside the app's pages
		expect(rows[0].siblings).toEqual(['/', 'design/screens.html']);
		expect(rows[0].accounts).toBe('none');
		// Strict mode keeps a mockup file in the siblings, and the row is then refused
		const strict = parseUiChangesTable(TABLE);
		expect(strict[0].siblings).toEqual(['/', 'design/screens.html']);
		expect(() => validateUiChange(strict[0])).toThrow(/inside the app/);
		expect(() => validateUiChange(rows[0], { allowMockups: true })).not.toThrow();
		expect(() => validateUiChange(rows[0])).toThrow(/inside the app/);
	});
	it('refuses a table with a missing column, a row with the wrong cell count and a row with no page', () => {
		expect(() => parseUiChangesTable('| Page | State |\n|---|---|\n| `/a` | none |')).toThrow(
			/No "UI changes" table/
		);
		const head =
			'| Page | State | Themes | Accounts | Siblings | Levels | Viewports |\n|---|---|---|---|---|---|---|\n';
		expect(() => parseUiChangesTable(head + '| `/a` | none | both |')).toThrow(/columns/);
		expect(() =>
			parseUiChangesTable(head + '| x | none | both | none | `/b` | title | 1440 |')
		).toThrow(/names no page/);
	});
	it('validates a row: levels, state steps, viewports, themes, addresses and siblings', () => {
		expect(() => validateUiChange(ROW)).not.toThrow();
		expect(() => validateUiChange({ ...ROW, levels: ['heading'] })).toThrow(/Unknown level/);
		expect(() => validateUiChange({ ...ROW, levels: ['title=.x'] })).toThrow(/css:/);
		expect(() => validateUiChange({ ...ROW, levels: ['button=css:.save'] })).not.toThrow();
		expect(() => validateUiChange({ ...ROW, viewports: [800] })).toThrow(/Viewport/);
		expect(() => validateUiChange({ ...ROW, stateRecipe: 'submit:form' })).toThrow(
			/click:, wait: or scroll:/
		);
		expect(() =>
			validateUiChange({ ...ROW, stateRecipe: 'click:text=Tab > wait:.x' })
		).not.toThrow();
		expect(() => validateUiChange({ ...ROW, siblings: [] })).toThrow(/1 to 3/);
		expect(() => validateUiChange({ ...ROW, siblings: ['/1', '/2', '/3', '/4'] })).toThrow(
			/1 to 3/
		);
		expect(() => validateUiChange({ ...ROW, page: 'https://elsewhere.example.com/' })).toThrow(
			/inside the app/
		);
		expect(() => validateUiChange({ ...ROW, page: '//elsewhere.example.com' })).toThrow(
			/inside the app/
		);
		expect(() => validateUiChange({ ...ROW, themes: ['hapr'] })).toThrow(/themes/);
		expect(() =>
			validateUiChange({ ...ROW, themes: ['hapr'] }, { themes: ['hapr', 'gameplan'] })
		).not.toThrow();
	});
	it('knows an address inside the app', () => {
		expect(isAppRoute('/acme/CKT?view=list')).toBe(true);
		for (const bad of ['acme', '//host', 'http://x', '/with space', '/\\evil'])
			expect(isAppRoute(bad)).toBe(false);
	});
	it('names every level once, each with a locator and the properties it is compared on', () => {
		for (const level of UI_LEVELS) {
			expect(DEFAULT_LOCATORS[level], level).toBeTruthy();
			expect(LEVEL_PROPS[level], level).toBeTruthy();
		}
		expect(locatorFor('title')).toBe('h1');
		expect(locatorFor('button=css:.save-bar button')).toBe('.save-bar button');
		expect(locatorFor('nonsense')).toBeNull();
		expect(
			shotFileName({
				page: '/acme/CKT?view=list',
				state: '',
				theme: 'dark',
				viewport: 390,
				side: 'after'
			})
		).toBe('after-acme_CKT_view_list-dark-390.jpg');
	});
});

describe('flags', () => {
	it('flags a heading larger than its sibling and off the scale', () => {
		const f = flagsFor('title', { fontSize: 28 } as never, { fontSize: 24 } as never, {
			fontSize: 24
		});
		expect(f.map((x) => x.kind).sort()).toEqual(['larger-than-sibling', 'off-scale']);
	});
	it('passes a value on the scale, and a smaller one than the sibling', () => {
		expect(
			flagsFor(
				'button',
				{ height: 44, fontSize: 14, radius: 8 } as never,
				{ height: 44 } as never,
				{ height: [32, 44], fontSize: 14, radius: 8 }
			)
		).toEqual([]);
		expect(
			flagsFor('title', { fontSize: 20 } as never, { fontSize: 24 } as never, undefined)
		).toEqual([]);
	});
	it('compares a control on height as well as font size, and a text level on font size only', () => {
		expect(
			flagsFor(
				'input',
				{ fontSize: 14, height: 52 } as never,
				{ fontSize: 14, height: 44 } as never,
				undefined
			).map((f) => f.kind)
		).toEqual(['larger-than-sibling']);
		expect(
			flagsFor(
				'body',
				{ fontSize: 14, height: 80 } as never,
				{ fontSize: 14, height: 20 } as never,
				undefined
			)
		).toEqual([]);
	});
	it('reports a missing level, and gathers the flags of a page against its first sibling that has the level', () => {
		expect(flagsFor('card', null, null, {})[0].kind).toBe('missing');
		const m = { title: { fontSize: 28 }, section: { fontSize: 18 } } as never;
		const flags = flagsForPage(
			['title', 'section'],
			m,
			[{ title: null, section: { fontSize: 18 } }, { title: { fontSize: 24 } }] as never,
			{
				title: { fontSize: 24 },
				section: { fontSize: 18 }
			}
		);
		expect(flags.map((f) => `${f.level}:${f.kind}`).sort()).toEqual([
			'title:larger-than-sibling',
			'title:off-scale'
		]);
	});
});

describe('the scale', () => {
	const page = (title: number, button?: number) => ({
		title: { fontSize: title, fontWeight: 600, height: 32, width: 300, radius: 0 },
		button: button ? { fontSize: 14, fontWeight: 500, height: button, width: 80, radius: 8 } : null
	});
	it('keeps the values pages really use, and leaves out a level seen on fewer than three pages', () => {
		const built = buildScale([
			{ page: '/a', measured: page(24, 44) },
			{ page: '/b', measured: page(24, 44) },
			{ page: '/c', measured: page(24, 32) },
			{ page: '/d', measured: page(24) }
		]);
		expect(built.seenOn).toEqual({ title: 4, button: 3 });
		expect(built.levels.title).toEqual({ fontSize: 24 });
		// The 44 px button was seen twice, the 32 px once: only the common one stays
		expect(built.levels.button.height).toEqual(44);
		const few = buildScale([
			{ page: '/a', measured: page(24, 44) },
			{ page: '/b', measured: page(24, 44) },
			{ page: '/c', measured: page(24) }
		]);
		expect(few.unused).toEqual(['button']);
		expect(few.levels.button).toBeUndefined();
	});
	it('keeps two values that both appear on several pages', () => {
		const built = buildScale([
			{ page: '/a', measured: page(24, 44) },
			{ page: '/b', measured: page(24, 44) },
			{ page: '/c', measured: page(24, 32) },
			{ page: '/d', measured: page(24, 32) }
		]);
		expect(built.levels.button.height).toEqual([32, 44]);
	});
});
