// THE SLIM ITEM ROW KEEPS WHO MADE THE PLAN, SO THE BOARD CAN SHOW IT WITHOUT A SECOND LOOKUP

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { slimItem, type ApiItem } from './rows';

// -- CONSTANTS -- //

const BASE: ApiItem = {
	id: 'i1',
	ref: 'AFB-20261115-0657',
	number: 1,
	title: 'A plan',
	status: 'PLANNED',
	percent: 0,
	doneSteps: 0,
	totalSteps: 3,
	visibility: 'public',
	stream: 'features',
	scope: 'core',
	lastActivityAt: '2026-11-15T10:00:00.000Z'
};

// -- FUNCTIONS -- //

describe('slimItem', () => {
	it('keeps the person who made the plan', () => {
		expect(slimItem({ ...BASE, createdBy: 'user-1' }).createdBy).toBe('user-1');
	});

	it('gives null for an imported plan with no creator', () => {
		expect(slimItem({ ...BASE, createdBy: null }).createdBy).toBeNull();
		expect(slimItem(BASE).createdBy).toBeNull();
	});
});
