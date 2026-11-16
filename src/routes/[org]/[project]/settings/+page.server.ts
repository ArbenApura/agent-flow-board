// IMPORTED DEP-TYPES
import type { PageServerLoad } from './$types';
// IMPORTED MODULES
import { getProject } from '#lib/server/ops/projects.js';
import { childContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** The project's settings. Everyone who can read the project may look, admins and owners change. */
export const load: PageServerLoad = async ({ params, parent, locals, depends }) => {
	depends('afb:settings');
	const { org, summary } = await parent();
	if (!summary) return { project: null, usage: [] };
	const ctx = await childContext(locals, org.id);
	const canManage = summary.caps.includes('manage');
	const project = await getProject(ctx, params.project);
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
			rules: project.rules
		},
		// How many items sit under each stream and scope, as this person may see them (private and trashed items are not counted)
		usage: summary.areas.map((a) => ({ stream: a.stream, scope: a.scope, n: a.n })),
		canManage
	};
};
