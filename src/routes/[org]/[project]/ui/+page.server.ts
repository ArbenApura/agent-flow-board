// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { projectUi } from '#lib/server/ops/uiShots.js';
import { childContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** The latest UI shots of every item the person may see, so a reviewer finds all new screens in one place (SPEC 11.2). */
export const load: PageServerLoad = async ({ params, parent, locals, depends }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	if (!summary) return { ui: null };
	const ctx = await childContext(locals, org.id);
	return { ui: await projectUi(ctx, params.project) };
};
