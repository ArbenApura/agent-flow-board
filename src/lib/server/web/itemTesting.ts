// IMPORTED TYPES
import type { Ctx } from '../ops/context';
// IMPORTED MODULES
import { OpError } from '../ops/context';
import { planTesting } from '../ops/testing';

// -- FUNCTIONS -- //

/**
 * A plan's Testing tab (AFB-20261127-0438): whether it shows and its case count always, the full view only when the tab is open.
 * A refusal or a hidden plan shows no tab, never an error on the plan page.
 */
export async function itemTesting(ctx: Ctx, itemRef: string, full: boolean) {
	try {
		return await planTesting(ctx, itemRef, full);
	} catch (e) {
		if (e instanceof OpError) return { shown: false, count: 0, view: null };
		throw e;
	}
}
