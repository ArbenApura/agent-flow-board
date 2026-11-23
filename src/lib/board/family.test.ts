// THE WORDS AND ADDRESSES OF MASTER AND CHILD PLANS, AND HOW A SLIM ROW CARRIES ITS FAMILY (AFB-20261123-1227)

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { ITEM_TABS, itemTabsFrom } from './item/itemTabs';
import { childCounts, childSummary, parentLine, siblingHref } from './family';
import { slimItem, type ApiFamily, type ApiItem } from './rows';
import { statusLabel } from './status';

// -- CONSTANTS -- //

const kid = (childNo: number, status: string) => ({
	id: `k${childNo}`,
	ref: `AFB-20261123-0001-${childNo}`,
	title: `Child ${childNo}`,
	status,
	percent: status === 'COMPLETED' ? 100 : 0,
	doneSteps: 0,
	totalSteps: 3,
	childNo
});

const BASE: ApiItem = {
	id: 'm1',
	ref: 'AFB-20261123-0001',
	number: 1,
	title: 'A master',
	status: 'IN PROGRESS',
	percent: 10,
	doneSteps: 1,
	totalSteps: 10,
	visibility: 'public',
	stream: 'features',
	scope: 'core',
	lastActivityAt: '2026-11-23T10:00:00.000Z'
};

// -- FUNCTIONS -- //

describe('child plan words', () => {
	it('counts done, running and planned child plans', () => {
		const kids = [kid(1, 'COMPLETED'), kid(2, 'IN PROGRESS'), kid(3, 'PLANNED'), kid(4, 'PLANNED')];
		expect(childCounts(kids)).toEqual({ n: 4, done: 1, running: 1, planned: 2 });
	});

	it('says how the child plans stand, and all done when every one is', () => {
		expect(childSummary([kid(1, 'COMPLETED'), kid(2, 'IN PROGRESS'), kid(3, 'PLANNED')])).toBe(
			'3 child plans · 1 done · 1 running'
		);
		expect(childSummary([kid(1, 'COMPLETED'), kid(2, 'COMPLETED')])).toBe(
			'2 child plans · all done'
		);
		expect(childSummary([kid(1, 'PLANNED')])).toBe('1 child plan · 0 done');
	});

	it('names the master and the number on a child', () => {
		expect(parentLine({ childNo: 8, childTotal: 10, title: 'Centers UI-UX overhaul' })).toBe(
			'Child 8 of 10 · Centers UI-UX overhaul'
		);
	});

	it('links a child next to its master', () => {
		expect(siblingHref('/acme/PRJ/PRJ-20261123-0001', 'PRJ-20261123-0001-b')).toBe(
			'/acme/PRJ/PRJ-20261123-0001-b'
		);
	});

	it('writes a status in sentence case', () => {
		expect(statusLabel('IN PROGRESS')).toBe('In progress');
		expect(statusLabel('COMPLETED')).toBe('Completed');
	});
});

describe('slimItem with a family', () => {
	const family: ApiFamily = {
		kids: { m1: [kid(1, 'COMPLETED'), kid(2, 'PLANNED')] },
		parents: { c9: { ref: 'AFB-20261123-0001', title: 'A master', childNo: 2, childTotal: 2 } }
	};

	it('gives a master its child plans', () => {
		const row = slimItem(BASE, family);
		expect(row.kids?.map((k) => k.childNo)).toEqual([1, 2]);
		expect(row.parent).toBeNull();
	});

	it('gives a child its master', () => {
		const row = slimItem({ ...BASE, id: 'c9' }, family);
		expect(row.parent?.childNo).toBe(2);
		expect(row.kids).toEqual([]);
	});

	it('is a plain plan when no family is given', () => {
		const row = slimItem(BASE);
		expect(row.parent).toBeNull();
		expect(row.kids).toEqual([]);
	});

	it('is safe in a map, where the second argument is the index', () => {
		const rows = [BASE].map((i) => slimItem(i, undefined));
		expect(rows[0].kids).toEqual([]);
	});
});

describe('the Children tab', () => {
	const data = (kids: unknown[]) => ({
		detail: {
			item: { id: 'm1', totalSteps: 4 },
			decisions: [],
			sections: [],
			family: { kids: { m1: kids } }
		}
	});
	const params = { get: () => null };

	it('shows only on a master', () => {
		const master = itemTabsFrom('/[org]/[project]/[item]', data([kid(1, 'PLANNED')]), params);
		expect(master?.tabs).toContain('children');
		expect(master?.counts.children).toBe(1);
		const plain = itemTabsFrom('/[org]/[project]/[item]', data([]), params);
		expect(plain?.tabs).not.toContain('children');
		expect(plain?.tabs).toHaveLength(ITEM_TABS.length - 1);
	});
});
