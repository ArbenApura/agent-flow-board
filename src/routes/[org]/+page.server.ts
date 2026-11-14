// IMPORTED DEP-TYPES
import type { Actions, PageServerLoad } from './$types';
// IMPORTED DEP-MODULES
import { fail } from '@sveltejs/kit';
// IMPORTED MODULES
import { projectPinInput } from '#lib/server/db/zod.js';
import { orgOverview } from '#lib/server/ops/board.js';
import { OpError } from '#lib/server/ops/context.js';
import { pinProject, unpinProject } from '#lib/server/ops/pins.js';
import { listMembers, membersFor } from '#lib/server/orgs/orgs.js';
import { childContext, orgContext } from '#lib/server/web/ctx.js';

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

export const actions: Actions = {
	/** Pins or unpins one project for the signed in person. The org and the person come from the request, never from the form. */
	pin: async ({ request, locals, params, url }) => {
		const { ctx } = await orgContext(locals, params.org, url.pathname);
		const data = await request.formData();
		const parsed = projectPinInput.safeParse({ projectId: data.get('projectId') });
		if (!parsed.success) return fail(400, { message: 'Pick a project to pin.' });
		const intent = data.get('intent') === 'unpin' ? 'unpin' : 'pin';
		try {
			if (intent === 'pin') await pinProject(ctx, parsed.data.projectId);
			else await unpinProject(ctx, parsed.data.projectId);
			return { projectId: parsed.data.projectId, pinned: intent === 'pin' };
		} catch (e) {
			if (e instanceof OpError)
				return fail(e.code === 'NOT_FOUND' ? 404 : 400, { message: e.message });
			throw e;
		}
	}
};
