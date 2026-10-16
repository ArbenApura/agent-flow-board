// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { refsFor } from '#lib/server/ops/board.js';
import { listTasks } from '#lib/server/ops/docs.js';
import { listMembers } from '#lib/server/orgs/orgs.js';
import { childContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** The tasks of the project, the references of the items they link, and the names of the people. */
export const load: PageServerLoad = async ({ params, parent, locals, depends }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	if (!summary) return { tasks: [], refs: {}, people: {} };
	const ctx = await childContext(locals, org.id);
	const [tasks, members] = await Promise.all([
		listTasks(ctx, params.project),
		listMembers(ctx.handle, org.id)
	]);
	const refs = await refsFor(
		ctx,
		params.project,
		tasks.flatMap((t) => t.linkedItemIds)
	);
	return {
		tasks,
		refs,
		people: Object.fromEntries(members.map((m) => [m.userId, m.name]))
	};
};
