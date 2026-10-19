// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { publishState } from '#lib/server/github/publish.js';
import { listRunners } from '#lib/server/ops/environments.js';
import { getProject } from '#lib/server/ops/projects.js';
import { childContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** The project's settings, and its publishing state. Everyone who can read the project may look, admins and owners change. */
export const load: PageServerLoad = async ({ params, parent, locals, depends }) => {
	depends('afb:settings');
	const { org, summary } = await parent();
	if (!summary) return { project: null, publish: null, usage: [], tools: [] };
	const ctx = await childContext(locals, org.id);
	const [project, publish, runners] = await Promise.all([
		getProject(ctx, params.project),
		publishState(ctx, params.project),
		listRunners(ctx)
	]);
	return {
		project: {
			id: project.id,
			logoV: project.logoV,
			key: project.key,
			name: project.name,
			webApp: project.webApp,
			defaultTarget: project.defaultTarget,
			streams: project.streams,
			themes: project.themes,
			referencePages: project.referencePages,
			agentsMayComplete: project.agentsMayComplete,
			staleDays: project.staleDays,
			rules: project.rules
		},
		// How many items sit under each stream and scope, as this person may see them (private and trashed items are not counted)
		usage: summary.areas.map((a) => ({ stream: a.stream, scope: a.scope, n: a.n })),
		// The afb-checks tools that serve this project: only a name and whether it answered lately
		tools: (summary.caps.includes('manage') ? runners : [])
			.filter((r) => r.kind === 'tool' && r.projects.includes(project.key))
			.map((r) => ({
				id: r.id,
				name: r.name,
				online: r.online,
				lastSeenAt: r.lastSeenAt?.toISOString() ?? null
			})),
		canManage: summary.caps.includes('manage'),
		publish
	};
};
