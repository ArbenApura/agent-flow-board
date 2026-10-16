// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { orgOverview } from '#lib/server/ops/board.js';
import { listMembers, membersFor } from '#lib/server/orgs/orgs.js';
import { childContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** The org home: each project with its counts and who is running, then the members. */
export const load: PageServerLoad = async ({ parent, locals, depends }) => {
	depends('afb:overview');
	const { org } = await parent();
	const ctx = await childContext(locals, org.id);
	const [projects, members] = await Promise.all([
		orgOverview(ctx),
		listMembers(ctx.handle, org.id)
	]);
	return { overview: projects, members: membersFor(members, locals.user!.id) };
};
