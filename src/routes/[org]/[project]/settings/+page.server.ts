// -- DEP-TYPES -- //
import type { Actions, PageServerLoad } from './$types';
// -- DEP-MODULES -- //
import { fail } from '@sveltejs/kit';
// -- MODULES -- //
import { approvalList, setAutoApprove } from '#lib/server/ops/approvals.js';
import { OpError } from '#lib/server/ops/context.js';
import { getProject } from '#lib/server/ops/projects.js';
import { childContext, orgContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** The project's settings and this person's own agent switch. Everyone who can read the project may look, admins and owners change. */
export const load: PageServerLoad = async ({ params, parent, locals, depends }) => {
	depends('afb:settings');
	const { org, summary } = await parent();
	if (!summary) return { project: null, usage: [], agentAccess: null };
	const ctx = await childContext(locals, org.id);
	const canManage = summary.caps.includes('manage');
	const [project, agentAccess] = await Promise.all([
		getProject(ctx, params.project),
		// This person's own switch and what their own agents did on their own; the list is empty for anyone who cannot manage
		approvalList(ctx)
	]);
	return {
		project: {
			id: project.id,
			logoV: project.logoV,
			key: project.key,
			name: project.name,
			webApp: project.webApp,
			streams: project.streams,
			themes: project.themes,
			referencePages: project.referencePages,
			agentsMayComplete: project.agentsMayComplete,
			staleDays: project.staleDays,
			rules: project.rules
		},
		// How many items sit under each stream and scope, as this person may see them (private and trashed items are not counted)
		usage: summary.areas.map((a) => ({ stream: a.stream, scope: a.scope, n: a.n })),
		agentAccess: {
			enabled: agentAccess.enabled,
			since: agentAccess.since,
			canManage: agentAccess.canManage,
			history: agentAccess.history
		},
		canManage
	};
};

export const actions: Actions = {
	/** The person's own switch: only a signed-in person with manage changes it, never a token or an agent. */
	autoApprove: async ({ request, locals, params, url }) => {
		const { ctx } = await orgContext(locals, params.org, url.pathname);
		const data = await request.formData();
		try {
			const done = await setAutoApprove(ctx, data.get('on') === 'true');
			return { enabled: done.enabled };
		} catch (e) {
			if (e instanceof OpError)
				return fail(e.code === 'FORBIDDEN' ? 403 : 400, {
					message:
						e.code === 'FORBIDDEN' ? 'You can no longer change this. Reload the page.' : e.message
				});
			throw e;
		}
	}
};
