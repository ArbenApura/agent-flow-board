// THE QA FEATURES ONE PLAN TOUCHES, FOR ITS PAGE: A COUNT ON EVERY LOAD AND THE LIST ONLY WHEN THE TESTING TAB IS OPEN (AFB-20261125-0442)

// IMPORTED TYPES
import type { Ctx } from '../ops/context';
// IMPORTED MODULES
import { planFeatureCount, planFeatures } from '../ops/qa';

// -- TYPES -- //

export type PlanQaFeature = Awaited<ReturnType<typeof planFeatures>>[number];
export type ItemQa = { count: number; list: PlanQaFeature[] | null };

// -- FUNCTIONS -- //

/** A plan with no QA features (and every plan for a guest) gets a count of 0 and never reads the list. */
export async function itemQa(ctx: Ctx, itemRef: string, withList: boolean): Promise<ItemQa> {
	const count = await planFeatureCount(ctx, itemRef);
	if (!withList || count === 0) return { count, list: withList ? [] : null };
	const list = await planFeatures(ctx, itemRef);
	return { count: list.length, list };
}
