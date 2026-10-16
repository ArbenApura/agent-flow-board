// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { publishState } from '#lib/server/github/publish.js';
import { getProject } from '#lib/server/ops/projects.js';
import { childContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** The project's settings, and its publishing state. Everyone who can read the project may look, admins and owners change. */
export const load: PageServerLoad = async ({ params, parent, locals, depends }) => {
	depends('afb:settings');
	const { org, summary } = await parent();
	if (!summary) return { project: null, publish: null };
	const ctx = await childContext(locals, org.id);
	const [project, publish] = await Promise.all([
		getProject(ctx, params.project),
		publishState(ctx, params.project)
	]);
	return {
		project: {
			key: project.key,
			name: project.name,
			colourTag: project.colourTag,
			webApp: project.webApp,
			defaultTarget: project.defaultTarget,
			streams: project.streams,
			themes: project.themes,
			referencePages: project.referencePages,
			agentsMayComplete: project.agentsMayComplete,
			staleDays: project.staleDays,
			rules: project.rules
		},
		canManage: summary.caps.includes('manage'),
		publish
	};
};
