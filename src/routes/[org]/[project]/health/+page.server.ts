// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { projectHealth } from '#lib/server/ops/health.js';
import { childContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** The project health panel: what needs attention, none of it blocking. */
export const load: PageServerLoad = async ({ params, parent, locals, depends }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	if (!summary) return { health: null };
	const ctx = await childContext(locals, org.id);
	return { health: await projectHealth(ctx, params.project) };
};
