// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { OpError } from '#lib/server/ops/context.js';
import { listTrash } from '#lib/server/ops/history.js';
import { childContext, pageError } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** What is in the trash. Reading it needs the delete capability, so a viewer sees a permission panel. */
export const load: PageServerLoad = async ({ params, parent, locals, depends }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	if (!summary) return { trash: null, denied: null };
	const ctx = await childContext(locals, org.id);
	try {
		return { trash: await listTrash(ctx, params.project), denied: null };
	} catch (e) {
		if (e instanceof OpError) return { trash: null, ...pageError(e) };
		throw e;
	}
};
