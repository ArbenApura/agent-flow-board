// IMPORTED DEP-TYPES
import type { LayoutServerLoad } from './$types';
// IMPORTED MODULES
import { projectSummary } from '#lib/server/ops/board.js';
import { OpError } from '#lib/server/ops/context.js';
import { childContext, pageError } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** The project's counts, the person's role in it and who is running now. Refetched when the live stream reports a change. */
export const load: LayoutServerLoad = async ({ params, parent, locals, depends }) => {
	depends('afb:project');
	const { org } = await parent();
	const ctx = await childContext(locals, org.id);
	try {
		return { summary: await projectSummary(ctx, params.project), denied: null };
	} catch (e) {
		if (e instanceof OpError) return { summary: null, ...pageError(e) };
		throw e;
	}
};
