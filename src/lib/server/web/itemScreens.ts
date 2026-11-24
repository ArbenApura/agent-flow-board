// THE SCREENSHOTS OF ONE PLAN FOR ITS PAGE: A COUNT ON EVERY LOAD AND THE LIST ONLY WHEN THE SCREENS TAB IS OPEN (AFB-20261124-0926)

// IMPORTED TYPES
import type { Ctx } from '../ops/context';
// IMPORTED MODULES
import { countScreens, listScreens } from '../ops/screens';

// -- TYPES -- //

export type ScreenView = Awaited<ReturnType<typeof listScreens>>['screens'][number];
export type ItemScreens = { count: number; list: ScreenView[] | null };

// -- FUNCTIONS -- //

export async function itemScreens(
	ctx: Ctx,
	itemRef: string,
	withList: boolean
): Promise<ItemScreens> {
	if (!withList) return { count: await countScreens(ctx, itemRef), list: null };
	const { screens } = await listScreens(ctx, itemRef);
	return { count: screens.length, list: screens };
}
