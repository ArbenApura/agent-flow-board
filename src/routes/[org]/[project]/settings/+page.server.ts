// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { listRunners } from '#lib/server/ops/environments.js';
import { getMockupSettings } from '#lib/server/ops/mockupSettings.js';
import { getProject } from '#lib/server/ops/projects.js';
import { childContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** The project's settings, and the tools that serve it. Everyone who can read the project may look, admins and owners change. */
export const load: PageServerLoad = async ({ params, parent, locals, depends }) => {
	depends('afb:settings');
	const { org, summary } = await parent();
	if (!summary) return { project: null, usage: [], tools: [], mockups: null };
	const ctx = await childContext(locals, org.id);
	const [project, runners, mockups] = await Promise.all([
		getProject(ctx, params.project),
		listRunners(ctx),
		getMockupSettings(ctx, params.project)
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
		// The afb-checks tools that serve this project: only a name and whether it answered lately
		tools: (summary.caps.includes('manage') ? runners : [])
			.filter((r) => r.kind === 'tool' && r.projects.includes(project.key))
			.map((r) => ({
				id: r.id,
				name: r.name,
				online: r.online,
				slots: r.slots,
				busy: r.busy,
				lastSeenAt: r.lastSeenAt?.toISOString() ?? null
			})),
		// The mockup style, templates, screens, themes and kit details. The kit file itself never leaves the server
		mockups,
		canManage: summary.caps.includes('manage')
	};
};
