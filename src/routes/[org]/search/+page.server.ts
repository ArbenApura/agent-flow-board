// IMPORTED DEP-TYPES
import type { PageServerLoad } from './$types';
// IMPORTED MODULES
import { searchBoard } from '#lib/server/ops/board.js';
import { childContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** Search across the org's items, sections, decisions and tasks, limited to what the person may see. */
export const load: PageServerLoad = async ({ parent, locals, url }) => {
	const { org } = await parent();
	const q = url.searchParams.get('q')?.trim() ?? '';
	const project = url.searchParams.get('project') || undefined;
	if (!q) return { q, project, hits: [] };
	const ctx = await childContext(locals, org.id);
	return { q, project, hits: await searchBoard(ctx, q, { project, limit: 40 }) };
};
