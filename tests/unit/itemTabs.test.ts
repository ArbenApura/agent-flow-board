// THE TABS OF AN ITEM, READ FROM THE PAGE DATA FOR THE CARD AND FOR THE TOP BAR (AFB-20261112-2350)

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	ITEM_ROUTE,
	ITEM_TABS,
	itemTabHref,
	itemTabsFrom,
	parseItemTab
} from '../../src/lib/board/item/itemTabs';

// -- CONSTANTS -- //

const params = (q = '') => new URLSearchParams(q);
const data = (over: Record<string, unknown> = {}) => ({
	detail: {
		item: { totalSteps: 12 },
		decisions: [{}, {}, {}],
		sections: [{}, {}],
		project: { webApp: true }
	},
	mockups: { list: [{}] },
	...over
});

// -- FUNCTIONS -- //

describe('itemTabsFrom', () => {
	it('gives the tabs, their counts and the open tab for a loaded item', () => {
		const got = itemTabsFrom(ITEM_ROUTE, data(), params('tab=docs'));
		expect(got?.tabs).toEqual([...ITEM_TABS]);
		expect(got?.counts).toEqual({ plan: 12, decisions: 3, docs: 2, mockups: 1 });
		expect(got?.active).toBe('docs');
	});
	it('leaves the Checks tab out for a project that is not a web app', () => {
		const got = itemTabsFrom(
			ITEM_ROUTE,
			data({ detail: { item: { totalSteps: 1 }, project: { webApp: false } } }),
			params()
		);
		expect(got?.tabs).not.toContain('checks');
		expect(got?.tabs).toContain('plan');
	});
	it('is null on any route that is not an item, even when the page returns a detail too', () => {
		expect(itemTabsFrom('/[org]/[project]/mockups/[id]', data(), params())).toBeNull();
		expect(itemTabsFrom(null, data(), params())).toBeNull();
		expect(itemTabsFrom(undefined, data(), params())).toBeNull();
	});
	it('is null for an item that did not load', () => {
		for (const bad of [
			null,
			undefined,
			'x',
			[],
			{},
			{ detail: null },
			{ detail: 'x' },
			{ detail: {} },
			{ detail: { item: null } }
		])
			expect(itemTabsFrom(ITEM_ROUTE, bad, params()), JSON.stringify(bad)).toBeNull();
	});
	it('counts what is missing as zero', () => {
		const got = itemTabsFrom(ITEM_ROUTE, { detail: { item: {} }, mockups: null }, params());
		expect(got?.counts).toEqual({ plan: 0, decisions: 0, docs: 0, mockups: 0 });
	});
});

describe('the tab in the address', () => {
	it('is the plan unless the address names one of the tabs', () => {
		expect(parseItemTab(null)).toBe('plan');
		expect(parseItemTab('')).toBe('plan');
		expect(parseItemTab('nope')).toBe('plan');
		expect(parseItemTab('__proto__')).toBe('plan');
		for (const t of ITEM_TABS) expect(parseItemTab(t)).toBe(t);
	});
	it('links the plan to the page and every other tab to a query on it', () => {
		expect(itemTabHref('/o/p/P-1', 'plan')).toBe('/o/p/P-1');
		expect(itemTabHref('/o/p/P-1', 'mockups')).toBe('/o/p/P-1?tab=mockups');
	});
});
